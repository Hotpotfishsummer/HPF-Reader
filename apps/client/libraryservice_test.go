package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

// newTestLibrary 造一个目录隔离的 LibraryService（不触碰用户真实数据目录）。
func newTestLibrary(t *testing.T) *LibraryService {
	t.Helper()
	s := NewLibraryService()
	s.dir = t.TempDir()
	return s
}

func booksDirFileCount(t *testing.T, s *LibraryService) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(s.dir, "books"))
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatalf("read books dir: %v", err)
	}
	return len(entries)
}

// validEPUBBytes 返回一段最小的"看起来像 EPUB"的字节（PK 头足够通过格式校验）。
func validEPUBBytes(body string) []byte {
	return append([]byte{'P', 'K', 3, 4}, []byte(body)...)
}

func TestImportBookBytesDeduplicates(t *testing.T) {
	s := newTestLibrary(t)
	raw := validEPUBBytes("hello book")

	first, err := s.ImportBookBytes(ImportBookPayload{
		Name:   "book.epub",
		Title:  "云端书名",
		Author: "云端作者",
		Format: "epub",
		Data:   raw,
	})
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if len(first.ID) != 16 {
		t.Fatalf("id must be the first 16 hex chars of sha256, got %q", first.ID)
	}
	if first.ContentHash[:16] != first.ID {
		t.Fatalf("id must derive from content hash: %q vs %q", first.ID, first.ContentHash)
	}

	second, err := s.ImportBookBytes(ImportBookPayload{Name: "copy.epub", Format: "epub", Data: raw})
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("dedup failed: %q != %q", second.ID, first.ID)
	}
	if second.Title != first.Title || second.Author != first.Author {
		t.Fatalf("duplicate must return the existing entry unchanged: %+v vs %+v", second, first)
	}
	if got := booksDirFileCount(t, s); got != 1 {
		t.Fatalf("expected exactly 1 stored file, got %d", got)
	}
	if len(s.ListBooks()) != 1 {
		t.Fatalf("expected 1 index entry, got %d", len(s.ListBooks()))
	}
}

func TestImportBookBytesKeepsCloudMetadataAndHash(t *testing.T) {
	s := newTestLibrary(t)
	raw := validEPUBBytes("metadata book")
	sum := sha256.Sum256(raw)
	wantHash := hex.EncodeToString(sum[:])

	rec, err := s.ImportBookBytes(ImportBookPayload{
		Name:   "some-random-name.epub",
		Title:  "真正的标题",
		Author: "真正的作者",
		Format: "EPUB",
		Data:   raw,
	})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if rec.Title != "真正的标题" {
		t.Fatalf("cloud title lost: %q", rec.Title)
	}
	if rec.Author != "真正的作者" {
		t.Fatalf("cloud author lost: %q", rec.Author)
	}
	if rec.Format != "epub" {
		t.Fatalf("format not normalized: %q", rec.Format)
	}
	if rec.ContentHash != wantHash {
		t.Fatalf("content hash mismatch: %q != %q", rec.ContentHash, wantHash)
	}
	if rec.ID != wantHash[:16] {
		t.Fatalf("id rule broken: %q != %q", rec.ID, wantHash[:16])
	}
	if rec.SizeBytes != int64(len(raw)) {
		t.Fatalf("size mismatch: %d != %d", rec.SizeBytes, len(raw))
	}
	if _, err := os.Stat(filepath.Join(s.dir, "books", rec.ID+".epub")); err != nil {
		t.Fatalf("stored file missing: %v", err)
	}
}

func TestImportBookBytesInfersTitleFormatFromName(t *testing.T) {
	s := newTestLibrary(t)
	rec, err := s.ImportBookBytes(ImportBookPayload{Name: "fallback-name.epub", Data: validEPUBBytes("x")})
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if rec.Title != "fallback-name" {
		t.Fatalf("title inference broken: %q", rec.Title)
	}
	if rec.Format != "epub" {
		t.Fatalf("format inference broken: %q", rec.Format)
	}
}

func TestImportBookBytesRejectsEmptyInput(t *testing.T) {
	s := newTestLibrary(t)

	if _, err := s.ImportBookBytes(ImportBookPayload{Name: "empty.epub", Format: "epub"}); err == nil {
		t.Fatal("expected error for empty data")
	}
	if _, err := s.ImportBookBytes(ImportBookPayload{Data: validEPUBBytes("x")}); err == nil {
		t.Fatal("expected error for empty name and title")
	}
	if _, err := s.ImportBookBytes(ImportBookPayload{Name: "   ", Data: validEPUBBytes("x")}); err == nil {
		t.Fatal("expected error for blank name")
	}
	if _, err := s.ImportBookBytes(ImportBookPayload{Title: "有标题", Data: []byte{}}); err == nil {
		t.Fatal("expected error for empty data with title fallback name")
	}
	if len(s.ListBooks()) != 0 {
		t.Fatal("nothing should be indexed after rejected imports")
	}
	if got := booksDirFileCount(t, s); got != 0 {
		t.Fatalf("nothing should be written, got %d files", got)
	}
}

func TestImportBookBytesRejectsCorruptData(t *testing.T) {
	s := newTestLibrary(t)

	cases := []struct {
		name   string
		format string
		data   []byte
	}{
		{"truncated epub", "epub", []byte("this is not a zip at all")},
		{"broken pdf", "pdf", []byte("PK\x03\x04 not a pdf")},
		{"broken mobi", "mobi", []byte("short")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.ImportBookBytes(ImportBookPayload{Name: "x." + tc.format, Format: tc.format, Data: tc.data}); err == nil {
				t.Fatalf("expected %s data to be rejected", tc.format)
			}
		})
	}
	if len(s.ListBooks()) != 0 {
		t.Fatal("corrupt data must not be indexed")
	}
	if got := booksDirFileCount(t, s); got != 0 {
		t.Fatalf("corrupt data must not be written, got %d files", got)
	}
}

func TestImportBookAndImportBookBytesShareDedupPath(t *testing.T) {
	s := newTestLibrary(t)
	raw := validEPUBBytes("shared path book")

	path := filepath.Join(t.TempDir(), "disk.epub")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	fromDisk, err := s.ImportBook(path)
	if err != nil {
		t.Fatalf("ImportBook: %v", err)
	}
	fromBytes, err := s.ImportBookBytes(ImportBookPayload{Name: "cloud.epub", Format: "epub", Data: raw})
	if err != nil {
		t.Fatalf("ImportBookBytes: %v", err)
	}
	if fromDisk.ID != fromBytes.ID {
		t.Fatalf("cross-path dedup failed: %q != %q", fromDisk.ID, fromBytes.ID)
	}
	if fromBytes.Title != "disk" {
		t.Fatalf("existing metadata must win: %q", fromBytes.Title)
	}
	if got := booksDirFileCount(t, s); got != 1 {
		t.Fatalf("expected 1 stored file, got %d", got)
	}
}
