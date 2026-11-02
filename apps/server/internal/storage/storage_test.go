package storage

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeHash(t *testing.T) {
	valid := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	got, err := NormalizeHash(valid)
	if err != nil {
		t.Fatalf("NormalizeHash: %v", err)
	}
	if got != "sha256:"+valid {
		t.Fatalf("got %q", got)
	}
	if g, err := NormalizeHash("SHA256:" + valid); err != nil || g != got {
		t.Fatalf("uppercase prefix should normalize: %q %v", g, err)
	}
	for _, bad := range []string{"", "abc", valid + "00", "z" + valid[1:]} {
		if _, err := NormalizeHash(bad); err == nil {
			t.Fatalf("NormalizeHash(%q) should fail", bad)
		}
	}
}

func TestLocalStorePutOpenStatDelete(t *testing.T) {
	root := t.TempDir()
	st, err := NewLocal(root)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	if st.Kind() != "local" {
		t.Fatalf("Kind = %q", st.Kind())
	}
	payload := []byte("hello hpf-reader")
	key := KeyForHash(HashBytes(payload))
	n, err := st.Put(context.Background(), key, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n != int64(len(payload)) {
		t.Fatalf("written = %d, want %d", n, len(payload))
	}
	size, err := st.Stat(context.Background(), key)
	if err != nil || size != int64(len(payload)) {
		t.Fatalf("Stat = %d, %v", size, err)
	}
	f, size, err := st.Open(context.Background(), key)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if size != int64(len(payload)) {
		t.Fatalf("size = %d", size)
	}
	got, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("read back mismatch: %q %v", got, err)
	}
	// 随机访问（Range 请求依赖 ReadAt）。
	buf := make([]byte, 5)
	if _, err := f.ReadAt(buf, 6); err != nil {
		t.Fatalf("ReadAt: %v", err)
	}
	if string(buf) != "hpf-r" {
		t.Fatalf("ReadAt = %q", buf)
	}
	// Windows 上删除已被打开的文件会失败，必须先关闭句柄。
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := st.Delete(context.Background(), key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := st.Stat(context.Background(), key); err != ErrNotFound {
		t.Fatalf("Stat after delete = %v, want ErrNotFound", err)
	}
	// 重复删除不报错（幂等）。
	if err := st.Delete(context.Background(), key); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
}

// key 必须是相对路径：否则本地实现会写到根目录之外。
func TestLocalStoreRejectsTraversal(t *testing.T) {
	st, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	for _, key := range []string{"../escape", "a/../../escape", "/etc/passwd"} {
		if _, err := st.Put(context.Background(), key, bytes.NewReader([]byte("x"))); err == nil {
			t.Fatalf("Put(%q) should be rejected", key)
		}
	}
}

func TestKeyForHashShards(t *testing.T) {
	h := "sha256:abcdef0123456789"
	key := KeyForHash(h)
	want := "ab/cd/abcdef0123456789"
	if filepath.ToSlash(key) != want {
		t.Fatalf("KeyForHash = %q, want %q", key, want)
	}
}

func TestHasherDetectsContentHash(t *testing.T) {
	var sink bytes.Buffer
	h := NewHasher(&sink)
	payload := []byte("streamed bytes")
	if _, err := h.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	sum, n := h.Sum()
	if sum != HashBytes(payload) {
		t.Fatalf("Sum = %q, want %q", sum, HashBytes(payload))
	}
	if n != int64(len(payload)) {
		t.Fatalf("n = %d", n)
	}
	if sink.String() != string(payload) {
		t.Fatal("tee write did not preserve bytes")
	}
}

func TestPutIsAtomicOnFailure(t *testing.T) {
	root := t.TempDir()
	st, _ := NewLocal(root)
	key := "aa/bb/cc"
	// 用一个提前失败的 reader 模拟中断的上传。
	if _, err := st.Put(context.Background(), key, &failingReader{}); err == nil {
		t.Fatal("expected Put to fail")
	}
	// 不应留下任何目标文件或临时文件。
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			t.Fatalf("leftover file after failed Put: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

type failingReader struct{ n int }

func (f *failingReader) Read(p []byte) (int, error) {
	f.n++
	if f.n > 1 {
		return 0, io.ErrUnexpectedEOF
	}
	copy(p, "partial")
	return 7, nil
}
