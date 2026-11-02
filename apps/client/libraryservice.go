package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// BookSummary 是书库列表项（同时作为 Go -> TS 绑定生成的类型来源）。
type BookSummary struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Author      string `json:"author"`
	Format      string `json:"format"`
	ContentHash string `json:"contentHash"`
	SizeBytes   int64  `json:"sizeBytes"`
	AddedAt     string `json:"addedAt"`
}

// LibraryChangedEvent 是书库变更事件的载荷。
type LibraryChangedEvent struct {
	Reason string `json:"reason"`
	BookID string `json:"bookId,omitempty"`
}

type libraryIndex struct {
	Books map[string]BookSummary `json:"books"`
}

// LibraryService 管理本地书库：导入文件、列出、读取字节、删除、阅读进度。
// 设计约定（ADR-002）：本地文件/数据库访问放在 Go 侧，前端只通过 bindings 访问。
//
// 当前实现是"能跑通的最小实现"：索引存 JSON 文件，书籍文件按内容哈希去重后落在 books/ 目录。
// 后续里程碑会替换为 SQLite（modernc.org/sqlite，纯 Go 免 cgo）。
type LibraryService struct {
	app   *application.App
	mu    sync.RWMutex
	dir   string
	index libraryIndex
}

func NewLibraryService() *LibraryService {
	return &LibraryService{index: libraryIndex{Books: map[string]BookSummary{}}}
}

// attach 在 application.New 之后调用，并尝试加载已有索引。
// 刻意不导出：不导出就不会出现在 Wails 生成的 bindings 里。
func (s *LibraryService) attach(app *application.App) {
	s.app = app
	_ = s.load()
}

func (s *LibraryService) indexPath() (string, error) {
	if s.dir == "" {
		dir, err := dataDir()
		if err != nil {
			return "", err
		}
		s.dir = dir
	}
	if err := os.MkdirAll(filepath.Join(s.dir, "books"), 0o755); err != nil {
		return "", err
	}
	return filepath.Join(s.dir, "library.json"), nil
}

func (s *LibraryService) load() error {
	path, err := s.indexPath()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var idx libraryIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return fmt.Errorf("library index corrupted: %w", err)
	}
	if idx.Books == nil {
		idx.Books = map[string]BookSummary{}
	}
	s.mu.Lock()
	s.index = idx
	s.mu.Unlock()
	return nil
}

func (s *LibraryService) save() error {
	path, err := s.indexPath()
	if err != nil {
		return err
	}
	s.mu.RLock()
	raw, err := json.MarshalIndent(s.index, "", "  ")
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

// ListBooks 返回全部书库条目（新加入的排在前面）。
func (s *LibraryService) ListBooks() []BookSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]BookSummary, 0, len(s.index.Books))
	for _, b := range s.index.Books {
		out = append(out, b)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].AddedAt > out[j-1].AddedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// ImportBook 把一个本地文件导入书库；按内容哈希去重（重复导入返回已有条目）。
func (s *LibraryService) ImportBook(path string) (BookSummary, error) {
	if strings.TrimSpace(path) == "" {
		return BookSummary{}, errors.New("path is empty")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return BookSummary{}, fmt.Errorf("read %s: %w", path, err)
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])
	id := hash[:16]

	s.mu.RLock()
	existing, ok := s.index.Books[id]
	s.mu.RUnlock()
	if ok {
		return existing, nil
	}

	if _, err := s.indexPath(); err != nil {
		return BookSummary{}, err
	}
	name := filepath.Base(path)
	dst := filepath.Join(s.dir, "books", id+strings.ToLower(filepath.Ext(name)))
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		return BookSummary{}, fmt.Errorf("write %s: %w", dst, err)
	}

	rec := BookSummary{
		ID:          id,
		Title:       strings.TrimSuffix(name, filepath.Ext(name)),
		Author:      "",
		Format:      strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), "."),
		ContentHash: hash,
		SizeBytes:   int64(len(raw)),
		AddedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	s.mu.Lock()
	s.index.Books[id] = rec
	s.mu.Unlock()
	if err := s.save(); err != nil {
		return BookSummary{}, err
	}
	s.emit("imported", id)
	return rec, nil
}

// ReadBookBytes 读取书籍原始字节（供前端交给 foliate-js 渲染）。
func (s *LibraryService) ReadBookBytes(id string) ([]byte, error) {
	if _, err := s.indexPath(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	_, ok := s.index.Books[id]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("book %s not found", id)
	}
	matches, err := filepath.Glob(filepath.Join(s.dir, "books", id+".*"))
	if err != nil || len(matches) == 0 {
		return nil, fmt.Errorf("book file for %s not found", id)
	}
	return os.ReadFile(matches[0])
}

// DeleteBook 从书库移除条目并删除文件。
func (s *LibraryService) DeleteBook(id string) error {
	if _, err := s.indexPath(); err != nil {
		return err
	}
	s.mu.Lock()
	if _, ok := s.index.Books[id]; !ok {
		s.mu.Unlock()
		return fmt.Errorf("book %s not found", id)
	}
	delete(s.index.Books, id)
	s.mu.Unlock()

	matches, _ := filepath.Glob(filepath.Join(s.dir, "books", id+".*"))
	for _, m := range matches {
		_ = os.Remove(m)
	}
	if err := s.save(); err != nil {
		return err
	}
	s.emit("deleted", id)
	return nil
}

// SaveProgress 记录阅读位置（M1 先落本地 JSON；M2 换成 SQLite + 同步引擎 outbox）。
func (s *LibraryService) SaveProgress(id string, locator string) error {
	if _, err := s.indexPath(); err != nil {
		return err
	}
	path := filepath.Join(s.dir, "progress.json")
	table := map[string]string{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &table)
	}
	table[id] = locator
	raw, err := json.MarshalIndent(table, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

// GetProgress 读取阅读位置（不存在时返回空串）。
func (s *LibraryService) GetProgress(id string) (string, error) {
	if _, err := s.indexPath(); err != nil {
		return "", err
	}
	path := filepath.Join(s.dir, "progress.json")
	table := map[string]string{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &table)
	}
	return table[id], nil
}

// PickBookFile 打开系统文件选择框，返回用户选中的文件路径（取消则返回空串）。
func (s *LibraryService) PickBookFile() (string, error) {
	if s.app == nil {
		return "", errors.New("application not attached")
	}
	path, err := s.app.Dialog.OpenFile().
		SetTitle("选择要导入的书籍").
		AddFilter("电子书", "*.epub;*.mobi;*.azw3;*.fb2;*.cbz;*.pdf;*.txt").
		AddFilter("所有文件", "*.*").
		PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	return path, nil
}

// ImportBookWithDialog 打开文件选择框并直接把选中的书导入书库。
func (s *LibraryService) ImportBookWithDialog() (BookSummary, error) {
	path, err := s.PickBookFile()
	if err != nil {
		return BookSummary{}, err
	}
	if path == "" {
		return BookSummary{}, errors.New("cancelled")
	}
	return s.ImportBook(path)
}

func (s *LibraryService) emit(reason, bookID string) {
	if s.app == nil {
		return
	}
	s.app.Event.Emit("library:changed", LibraryChangedEvent{Reason: reason, BookID: bookID})
}
