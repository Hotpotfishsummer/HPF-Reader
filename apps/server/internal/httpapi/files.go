package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// defaultDrainLimit 是"丢弃请求体"时的兜底上限（配置缺失时用）。
const defaultDrainLimit = 64 << 20 // 64 MiB

// handlePutBookFile 上传书籍文件。
//
// 幂等 / 秒传语义：按客户端提供的 contentHash 去重。
//   - 服务端已有该 hash 的字节：直接绑定到书籍，返回 200；
//   - 首次上传：写入本地目录，登记 book_files，返回 201。
//
// 上传过程中同时计算 sha256，与客户端声明比对；不一致直接 400，
// 避免把损坏文件写进存储后污染所有设备。
func (s *Server) handlePutBookFile(w http.ResponseWriter, r *http.Request) {
	// ★★ 无论走哪条分支，都必须把请求体读完（丢弃即可）再让响应出去。
	//   handler 提前返回而没读完 body 时，Go 的 http.Server 无法复用这条连接，
	//   会在响应发出后**关闭 TCP 连接**；而客户端此刻还在写这本书的字节，
	//   写端被打断 ⇒ 客户端看到的是"上传卡住 / network_error"，
	//   服务端这边却一切正常（200/409/507 已经写出去了），极难排查。
	//   秒传、配额超限、哈希冲突……这些"提前返回"的分支都会踩到。
	//   defer 在响应真正 flush 之前执行，所以客户端拿到的一定是完整响应。
	defer s.drainRequestBody(r)
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	declared, err := storage.NormalizeHash(r.URL.Query().Get("contentHash"))
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "contentHash is required: "+err.Error(), nil)
		return
	}
	book, err := s.store.GetBook(r.Context(), claims.UserID, bookID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if book.FileHash != nil && *book.FileHash != declared {
		writeError(w, http.StatusConflict, codeConflict, "book already has a different file", map[string]any{
			"existingContentHash": *book.FileHash,
		})
		return
	}

	// 秒传：已有字节则不再接收请求体（直接丢弃，避免读整份文件）。
	if existing, err := s.store.GetBookFile(r.Context(), declared); err == nil {
		if _, statErr := s.storage.Stat(r.Context(), existing.StorageKey); statErr == nil {
			// 秒传同样计入配额（按逻辑大小），否则换个小号就能无限存书。
			// ★ 但只计**新增**的部分：这本书已经挂着同一份文件时账本里算过了。
			if ok := s.ensureStorageQuota(w, r, claims.UserID, quotaDelta(book, existing.SizeBytes)); !ok {
				return
			}
			if _, _, err := s.store.EnsureBookFile(r.Context(), declared, existing.StorageKey, existing.SizeBytes); err != nil {
				writeStoreError(w, err)
				return
			}
			if _, err := s.store.AttachBookFile(r.Context(), claims.UserID, bookID, declared, existing.SizeBytes); err != nil {
				writeAttachError(w, err, declared)
				return
			}
			// ★★ 请求体由 defer 里的 drainRequestBody 读完（见函数头注释）：
			//   不读完的话，Go 会关闭连接，把客户端正在写的字节打断。
			s.metrics.IncUpload(true)
			writeJSON(w, http.StatusOK, map[string]any{"contentHash": declared, "sizeBytes": existing.SizeBytes, "deduplicated": true})
			return
		}
	}

	quotaLimit, ok := s.uploadByteLimit(w, r, claims.UserID, book, declared)
	if !ok {
		return
	}
	key := storage.KeyForHash(declared)
	r.Body = http.MaxBytesReader(w, r.Body, quotaLimit)
	hasher := storage.NewHasher(io.Discard)
	// 先落盘再校验：把哈希计算与写入合并成一次 IO。
	written, err := s.storage.Put(r.Context(), key, io.TeeReader(r.Body, hasher))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			if quotaLimit < s.cfg.MaxUploadSize {
				// 读到的上限来自配额而不是单文件上限：返回配额错误，
				// 并且 Put 已经删掉了半截临时文件，不会占磁盘。
				writeError(w, http.StatusInsufficientStorage, codeQuotaExceeded,
					"storage quota exceeded", map[string]any{
						"maxBytes": quotaLimit,
					})
				return
			}
			writeError(w, http.StatusRequestEntityTooLarge, codePayloadTooLarge,
				fmt.Sprintf("file exceeds the %d byte limit", s.cfg.MaxUploadSize), nil)
			return
		}
		s.log.Error("store book file", "error", err, "book_id", bookID)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not store file", nil)
		return
	}
	actual, size := hasher.Sum()
	if actual != declared {
		// 客户端声明的 hash 与实际字节不符：删除已写入的临时对象并报错。
		_ = s.storage.Delete(r.Context(), key)
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "contentHash does not match uploaded bytes", map[string]any{
			"declared": declared,
			"actual":   actual,
		})
		return
	}
	if size != written {
		s.log.Warn("size mismatch after upload", "written", written, "hashed", size, "book_id", bookID)
	}
	if _, _, err := s.store.EnsureBookFile(r.Context(), declared, key, size); err != nil {
		writeStoreError(w, err)
		return
	}
	if _, err := s.store.AttachBookFile(r.Context(), claims.UserID, bookID, declared, size); err != nil {
		writeAttachError(w, err, declared)
		return
	}
	s.metrics.IncUpload(false)
	writeJSON(w, http.StatusCreated, map[string]any{"contentHash": declared, "sizeBytes": size, "deduplicated": false})
}

// drainRequestBody 读完并丢弃剩余请求体（本地读，不落盘、不占配额）。
//
// 上限取单文件上限：正常客户端不会发超过它的字节；真发了也只丢这么多，
// 剩下的交给 Go 关闭连接（总比把连接一直挂着好）。
func (s *Server) drainRequestBody(r *http.Request) {
	if r.Body == nil {
		return
	}
	limit := int64(s.cfg.MaxUploadSize)
	if limit <= 0 {
		limit = defaultDrainLimit
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, limit))
}

// storageQuota 返回用户的存储配额与已用逻辑字节数；quota <= 0 表示不限。
func (s *Server) storageQuota(ctx context.Context, userID string) (quota, used int64, err error) {
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return 0, 0, err
	}
	used, err = s.store.BookBytesUsed(ctx, userID)
	if err != nil {
		return 0, 0, err
	}
	return user.QuotaBytes, used, nil
}

// quotaDelta 返回「本次上传真正新增占用」的字节数。
//
// 配额账本（BookBytesUsed）按**书**统计 file_size，所以：
//   - 这本书已经挂着同一份文件（幂等重传）⇒ 账本里已经算过它了，
//     再按全额收一次会让"重传同一本书"在接近配额上限时误报 507；
//   - 这本书还没挂文件（新建的书 / 上次上传失败）⇒ 全额新增。
//
// 注意判断条件是「文件真的挂着」（storage_key 非空且 file_size > 0），
// 而不是「file_hash 相同」：服务端在 POST /v1/books 时就把客户端声明的
// contentHash 写进了 file_hash，那时文件其实还没上传。
func quotaDelta(book store.Book, size int64) int64 {
	if book.StorageKey != nil && book.FileSize > 0 {
		return 0
	}
	return size
}

// ensureStorageQuota 校验「已用 + extra」是否仍在配额内；返回 false 时已写响应。
func (s *Server) ensureStorageQuota(w http.ResponseWriter, r *http.Request, userID string, extra int64) bool {
	quota, used, err := s.storageQuota(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return false
	}
	if quota > 0 && used+extra > quota {
		writeError(w, http.StatusInsufficientStorage, codeQuotaExceeded, "storage quota exceeded", map[string]any{
			"quotaBytes":     quota,
			"usedBytes":      used,
			"requestedBytes": extra,
		})
		return false
	}
	return true
}

// uploadByteLimit 返回本次上传允许从 body 读取的最大字节数
// （取「单文件上限」与「剩余配额」的较小值）。
//
// 为什么在读取前就限制：否则攻击者可以反复上传超大文件，虽然最后被配额拒绝，
// 但字节已经落盘，磁盘照样被打满。
//
// ★ 幂等重传（这本书已经挂着同一份文件）不新增占用，
//
//	所以可用额度要把**已经计入账本的那部分**加回来，
//	否则"重传同一本书"在接近配额上限时会误报 507。
func (s *Server) uploadByteLimit(w http.ResponseWriter, r *http.Request, userID string, book store.Book, declared string) (int64, bool) {
	quota, used, err := s.storageQuota(r.Context(), userID)
	if err != nil {
		writeStoreError(w, err)
		return 0, false
	}
	limit := s.cfg.MaxUploadSize
	if quota > 0 {
		alreadyCounted := int64(0)
		if book.FileHash != nil && *book.FileHash == declared && book.StorageKey != nil && book.FileSize > 0 {
			alreadyCounted = book.FileSize
		}
		remaining := quota - used + alreadyCounted
		if remaining <= 0 {
			writeError(w, http.StatusInsufficientStorage, codeQuotaExceeded, "storage quota exceeded", map[string]any{
				"quotaBytes": quota,
				"usedBytes":  used,
			})
			return 0, false
		}
		if remaining < limit {
			limit = remaining
		}
	}
	return limit, true
}

// writeAttachError 把「挂载文件失败」翻译成对客户端有意义的响应。
//
// books 表上有唯一约束 books_user_hash_idx (user_id, file_hash)：同一用户对同一份文件字节
// 只能有一条有效书籍记录（这是有意的产品规则，避免同一本书被重复加入书架）。
// 因此这里必须给出明确解释，而不是通用的 "resource already exists"。
func writeAttachError(w http.ResponseWriter, err error, contentHash string) {
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, codeConflict,
			"this account already has a book with the same content hash", map[string]any{"contentHash": contentHash})
		return
	}
	writeStoreError(w, err)
}

// handleGetBookFile 下载书籍文件，支持 Range 与 ETag。
//
// 用 http.ServeContent：标准库已经处理了 Range / If-Range / If-None-Match / HEAD，
// 自己手写极易在边界条件上出错。
func (s *Server) handleGetBookFile(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	book, err := s.store.GetBook(r.Context(), claims.UserID, bookID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if book.FileHash == nil || book.StorageKey == nil {
		writeError(w, http.StatusNotFound, codeNotFound, "book file has not been uploaded yet", nil)
		return
	}
	f, size, err := s.storage.Open(r.Context(), *book.StorageKey)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, codeNotFound, "book file is missing from storage", nil)
			return
		}
		s.log.Error("open book file", "error", err, "book_id", bookID)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not read file", nil)
		return
	}
	defer func() { _ = f.Close() }()

	name := safeFilename(book.Title) + "." + book.Format
	w.Header().Set("Content-Type", contentTypeForFormat(book.Format))
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", name))
	w.Header().Set("Accept-Ranges", "bytes")
	// ETag 基于内容哈希：文件内容不变则永远不变，客户端可放心长缓存。
	w.Header().Set("ETag", "\""+strings.TrimPrefix(*book.FileHash, "sha256:")+"\"")
	w.Header().Set("Cache-Control", "private, max-age=3600")

	http.ServeContent(w, r, name, book.UpdatedAt, io.NewSectionReader(f, 0, size))
	s.audit(r, &claims.UserID, "book.download", bookID, nil)
}

func contentTypeForFormat(format string) string {
	switch format {
	case "epub":
		return "application/epub+zip"
	case "pdf":
		return "application/pdf"
	case "cbz":
		return "application/vnd.comicbook+zip"
	case "fb2":
		return "application/x-fictionbook+xml"
	case "html":
		return "text/html; charset=utf-8"
	case "md", "txt":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

// safeFilename 去掉路径分隔符与控制字符，避免 Content-Disposition 注入。
func safeFilename(title string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r < 0x20, r == 0x7f:
			return -1
		case r == '/' || r == '\\' || r == '"' || r == ';' || r == ':':
			return '_'
		default:
			return r
		}
	}, title)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		cleaned = "book"
	}
	if len(cleaned) > 120 {
		cleaned = cleaned[:120]
	}
	return cleaned
}
