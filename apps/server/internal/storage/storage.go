// Package storage 抽象书籍文件的落地位置。
//
// 一期只提供本地目录实现；对象存储（MinIO/S3）通过实现同一接口接入，
// 上层（books 上传/下载、秒传、Range 请求）完全不感知差异。
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotFound 表示对象不存在。
var ErrNotFound = errors.New("storage: object not found")

// ReadSeekCloserAt 是可随机访问（ReadAt）的只读句柄。
// 下载路径依赖 ReadAt 来支持 HTTP Range（io.NewSectionReader / http.ServeContent）。
type ReadSeekCloserAt interface {
	io.Reader
	io.ReaderAt
	io.Seeker
	io.Closer
}

// Store 是对象存储接口。key 是调用方生成的相对路径（不含根目录前缀）。
type Store interface {
	// Put 写入对象；实现必须保证「先写临时文件再原子改名」，
	// 否则并发读会看到半个文件。
	Put(ctx context.Context, key string, r io.Reader) (int64, error)
	// Open 打开对象供下载；调用方负责 Close。
	Open(ctx context.Context, key string) (ReadSeekCloserAt, int64, error)
	// Stat 返回对象大小。
	Stat(ctx context.Context, key string) (int64, error)
	// Delete 删除对象；不存在不算错误。
	Delete(ctx context.Context, key string) error
	// Kind 返回实现类型（local/s3），用于日志与诊断。
	Kind() string
}

// LocalStore 把对象存到本地目录。
//
// 布局：<root>/ab/cd/<sha256>，用 hash 前 4 位分两级目录，
// 避免单目录塞进几十万文件（ext4 下会很慢）。
type LocalStore struct {
	root string
}

// NewLocal 创建本地目录存储，必要时创建根目录。
func NewLocal(root string) (*LocalStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("storage: empty root dir")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("create storage root: %w", err)
	}
	// 启动时就验证可写。
	// 否则「卷属主不对」要等到用户上传时才以 500 暴露，在 distroless 容器里极难定位。
	probe, err := os.CreateTemp(abs, ".write-probe-*")
	if err != nil {
		return nil, fmt.Errorf("storage root %s is not writable: %w "+
			"(在容器里通常是卷/挂载目录的属主不是运行用户 uid 65532：chown -R 65532:65532 <dir>)", abs, err)
	}
	probeName := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probeName)
	return &LocalStore{root: abs}, nil
}

// Kind 实现 Store。
func (l *LocalStore) Kind() string { return "local" }

// KeyForHash 由内容哈希推导存储 key（两级分片）。
func KeyForHash(contentHash string) string {
	h := strings.ToLower(strings.TrimPrefix(contentHash, "sha256:"))
	if len(h) < 4 {
		return filepath.ToSlash(filepath.Join("misc", h))
	}
	return filepath.ToSlash(filepath.Join(h[0:2], h[2:4], h))
}

func (l *LocalStore) resolve(key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", fmt.Errorf("storage: empty key")
	}
	// 防御路径穿越：key 必须是相对路径。
	// 注意 Windows 上 filepath.IsAbs("\\etc\\passwd") 为 false，
	// 因此还要显式拒绝以分隔符或盘符开头的写法，以及 IsLocal 判定。
	if filepath.IsAbs(key) || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") ||
		filepath.IsLocal(filepath.FromSlash(key)) == false {
		return "", fmt.Errorf("storage: illegal key %q", key)
	}
	clean := filepath.Clean(filepath.FromSlash(key))
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", fmt.Errorf("storage: illegal key %q", key)
	}
	return filepath.Join(l.root, clean), nil
}

// Put 实现 Store。
func (l *LocalStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	dst, err := l.resolve(key)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".upload-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName) // 成功路径下文件已被改名，Remove 会失败但无害
	}()

	n, err := copyWithContext(ctx, tmp, r)
	if err != nil {
		return n, err
	}
	if err := tmp.Sync(); err != nil {
		return n, err
	}
	if err := tmp.Close(); err != nil {
		return n, err
	}
	if err := os.Chmod(tmpName, 0o640); err != nil {
		return n, err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return n, err
	}
	return n, nil
}

// Open 实现 Store。
func (l *LocalStore) Open(ctx context.Context, key string) (ReadSeekCloserAt, int64, error) {
	path, err := l.resolve(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

// Stat 实现 Store。
func (l *LocalStore) Stat(ctx context.Context, key string) (int64, error) {
	path, err := l.resolve(key)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	return info.Size(), nil
}

// Delete 实现 Store。
func (l *LocalStore) Delete(ctx context.Context, key string) error {
	path, err := l.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Hasher 边读边算 sha256，供上传时校验客户端提供的 contentHash，
// 同时把字节写到目标对象，避免「先落盘再读一遍算哈希」的双倍 IO。
type Hasher struct {
	w    io.Writer
	hash hash.Hash
	n    int64
}

// NewHasher 包装目标写入器。
func NewHasher(w io.Writer) *Hasher {
	return &Hasher{w: w, hash: sha256.New()}
}

// Write 实现 io.Writer：同时写入目标与哈希。
func (h *Hasher) Write(p []byte) (int, error) {
	n, err := h.w.Write(p)
	if n > 0 {
		h.hash.Write(p[:n])
		h.n += int64(n)
	}
	return n, err
}

// Sum 返回 "sha256:<hex>" 形态的摘要与总字节数。
func (h *Hasher) Sum() (string, int64) {
	return "sha256:" + hex.EncodeToString(h.hash.Sum(nil)), h.n
}

// NormalizeHash 把各种写法的 sha256 归一成 "sha256:<64位小写hex>"。
// 接受 "abc…"、"sha256:abc…"、"SHA256:ABC…" 等形态。
func NormalizeHash(raw string) (string, error) {
	h := strings.ToLower(strings.TrimSpace(raw))
	h = strings.TrimPrefix(h, "sha256:")
	if len(h) != 64 {
		return "", fmt.Errorf("storage: content hash must be 64 hex chars, got %d", len(h))
	}
	if _, err := hex.DecodeString(h); err != nil {
		return "", fmt.Errorf("storage: content hash is not hex: %w", err)
	}
	return "sha256:" + h, nil
}

// HashBytes 计算字节内容的归一化哈希（小文件/测试用）。
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// copyWithContext 复制流并在 ctx 取消时中止，避免客户端断连后继续写盘。
func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, 256*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return total, werr
			}
			total += int64(n)
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			return total, rerr
		}
	}
}
