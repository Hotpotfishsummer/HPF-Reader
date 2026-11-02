package httpapi

import (
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

// handlePutBookFile 上传书籍文件。
//
// 幂等 / 秒传语义：按客户端提供的 contentHash 去重。
//   - 服务端已有该 hash 的字节：直接绑定到书籍，返回 200；
//   - 首次上传：写入本地目录，登记 book_files，返回 201。
//
// 上传过程中同时计算 sha256，与客户端声明比对；不一致直接 400，
// 避免把损坏文件写进存储后污染所有设备。
func (s *Server) handlePutBookFile(w http.ResponseWriter, r *http.Request) {
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
			if _, _, err := s.store.EnsureBookFile(r.Context(), declared, existing.StorageKey, existing.SizeBytes); err != nil {
				writeStoreError(w, err)
				return
			}
			if _, err := s.store.AttachBookFile(r.Context(), claims.UserID, bookID, declared, existing.SizeBytes); err != nil {
				writeAttachError(w, err, declared)
				return
			}
			s.metrics.IncUpload(true)
			writeJSON(w, http.StatusOK, map[string]any{"contentHash": declared, "sizeBytes": existing.SizeBytes, "deduplicated": true})
			return
		}
	}

	key := storage.KeyForHash(declared)
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadSize)
	hasher := storage.NewHasher(io.Discard)
	// 先落盘再校验：把哈希计算与写入合并成一次 IO。
	written, err := s.storage.Put(r.Context(), key, io.TeeReader(r.Body, hasher))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
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
