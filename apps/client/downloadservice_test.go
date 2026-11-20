package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadService(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "dl-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	lib := &LibraryService{
		dir:   filepath.Join(tempDir, "library"),
		index: libraryIndex{Books: map[string]BookSummary{}},
	}
	dlService := NewDownloadService(lib)
	dlService.dir = filepath.Join(tempDir, "downloads")

	// 启动一个测试 HTTP 文件服务器
	mockContent := []byte("fake epub content for unit test")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="pride_and_prejudice.epub"`)
		w.Header().Set("Content-Type", "application/epub+zip")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(mockContent)
	}))
	defer server.Close()

	// 1. 测试下载
	item, err := dlService.StartDownload(server.URL+"/book.epub", "")
	if err != nil {
		t.Fatalf("StartDownload failed: %v", err)
	}
	if item.Filename != "pride_and_prejudice.epub" {
		t.Fatalf("expected filename pride_and_prejudice.epub, got %s", item.Filename)
	}
	if item.SizeBytes != int64(len(mockContent)) {
		t.Fatalf("expected size %d, got %d", len(mockContent), item.SizeBytes)
	}

	// 2. 测试列表
	items, err := dlService.ListDownloads()
	if err != nil {
		t.Fatalf("ListDownloads failed: %v", err)
	}
	if len(items) != 1 || items[0].Filename != "pride_and_prejudice.epub" {
		t.Fatalf("ListDownloads unexpected items: %+v", items)
	}

	// 3. 测试导入书库
	summary, err := dlService.ImportToLibrary(item.Filename)
	if err != nil {
		t.Fatalf("ImportToLibrary failed: %v", err)
	}
	if summary.Title != "pride_and_prejudice" {
		t.Fatalf("expected imported title pride_and_prejudice, got %s", summary.Title)
	}

	// 验证书库中确实有了该书
	books := lib.ListBooks()
	if len(books) != 1 || books[0].ID != summary.ID {
		t.Fatalf("expected 1 book in library, got %+v", books)
	}

	// 4. 测试删除下载
	if err := dlService.DeleteDownload(item.Filename); err != nil {
		t.Fatalf("DeleteDownload failed: %v", err)
	}
	afterItems, _ := dlService.ListDownloads()
	if len(afterItems) != 0 {
		t.Fatalf("expected 0 downloads after delete, got %d", len(afterItems))
	}
}
