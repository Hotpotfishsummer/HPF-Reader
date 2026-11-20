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

// ImportBookPayload 是"把内存中的书籍字节写入本地书库"的入参（前端下载云端文件后调用）。
//
// name 是原始文件名（用于推断标题/扩展名与落盘文件名）；title/author/format 允许用
// **云端元数据**覆盖文件推断值（云端 title 常常比文件名准确）。Data 为原始字节。
// 经 Wails 绑定时 Data 会序列化为 base64 字符串（前端 Uint8Array -> base64）。
type ImportBookPayload struct {
	Name   string `json:"name"`
	Title  string `json:"title,omitempty"`
	Author string `json:"author,omitempty"`
	Format string `json:"format,omitempty"`
	Data   []byte `json:"data"`
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
	name := filepath.Base(path)
	return s.importBytes(importRequest{
		Name:   name,
		Title:  strings.TrimSuffix(name, filepath.Ext(name)),
		Format: strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), "."),
		Data:   raw,
	})
}

// ImportBookBytes 把内存中的书籍字节写入本地书库（前端下载云端文件后调用）。
//
// 与 ImportBook 共用同一条去重/落盘路径：id = sha256(data) 前 16 位，
// 重复内容直接返回已有条目，**不重复写文件、不覆盖已有元数据**。
func (s *LibraryService) ImportBookBytes(payload ImportBookPayload) (BookSummary, error) {
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		name = strings.TrimSpace(payload.Title)
	}
	if name == "" {
		return BookSummary{}, errors.New("book name is empty")
	}
	// 只对"来自网络下载的字节"做格式校验：本地文件对话框导入保持宽松，
	// 因为用户可能导入服务端/第三方工具产出的非常规容器（历史行为，不能收紧）。
	format := normalizeBookFormat(payload.Format, name)
	if err := validateBookData(format, payload.Data); err != nil {
		return BookSummary{}, err
	}
	return s.importBytes(importRequest{
		Name:   name,
		Title:  payload.Title,
		Author: payload.Author,
		Format: format,
		Data:   payload.Data,
	})
}

// importRequest 是 ImportBook / ImportBookBytes 的共同输入（内部类型，不进 bindings）。
type importRequest struct {
	Name   string
	Title  string
	Author string
	Format string
	Data   []byte
}

// importBytes 是唯一的入库实现：sha256 去重 -> 落盘 -> 写索引（格式校验由调用方决定）。
func (s *LibraryService) importBytes(req importRequest) (BookSummary, error) {
	if len(req.Data) == 0 {
		return BookSummary{}, errors.New("book data is empty")
	}
	name := filepath.Base(strings.TrimSpace(req.Name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return BookSummary{}, errors.New("book name is empty")
	}
	format := normalizeBookFormat(req.Format, name)

	sum := sha256.Sum256(req.Data)
	hash := hex.EncodeToString(sum[:])
	id := hash[:16]

	s.mu.RLock()
	existing, ok := s.index.Books[id]
	s.mu.RUnlock()
	if ok {
		// 去重命中：同一份内容永远只落一个文件，元数据以首次入库为准。
		return existing, nil
	}

	if _, err := s.indexPath(); err != nil {
		return BookSummary{}, err
	}
	ext := strings.ToLower(filepath.Ext(name))
	if format != "" {
		ext = "." + format
	}
	dst := filepath.Join(s.dir, "books", id+ext)
	if err := os.WriteFile(dst, req.Data, 0o644); err != nil {
		return BookSummary{}, fmt.Errorf("write %s: %w", dst, err)
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = strings.TrimSuffix(name, filepath.Ext(name))
	}
	rec := BookSummary{
		ID:          id,
		Title:       title,
		Author:      strings.TrimSpace(req.Author),
		Format:      format,
		ContentHash: hash,
		SizeBytes:   int64(len(req.Data)),
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

// normalizeBookFormat 归一化格式串：显式 format 优先，否则从文件名扩展名推断。
func normalizeBookFormat(format, name string) string {
	f := strings.ToLower(strings.TrimSpace(format))
	f = strings.TrimPrefix(f, ".")
	if f != "" {
		return f
	}
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
}

// validateBookData 拒绝空数据与"扩展名说是电子书、内容根本不是"的损坏数据。
// 只用于 ImportBookBytes（云端下载）：下载是自动路径，坏字节必须在入库前挡住；
// ImportBook（用户显式选择的本地文件）保持宽松，不做过度校验以免挡住真实可读文件。
// 未知格式（含 txt）只要求非空。
func validateBookData(format string, raw []byte) error {
	if len(raw) == 0 {
		return errors.New("book data is empty")
	}
	switch format {
	case "epub", "cbz":
		// EPUB / CBZ 都是 ZIP 容器。
		if len(raw) < 4 || raw[0] != 'P' || raw[1] != 'K' {
			return fmt.Errorf("corrupted %s: missing ZIP header", strings.ToUpper(format))
		}
	case "pdf":
		if len(raw) < 5 || string(raw[:5]) != "%PDF-" {
			return errors.New("corrupted PDF: missing %PDF- header")
		}
	case "mobi", "azw3":
		// PalmDB 头部：偏移 60 处必须是 "BOOKMOBI"。
		if len(raw) < 68 || string(raw[60:68]) != "BOOKMOBI" {
			return fmt.Errorf("corrupted %s: missing BOOKMOBI header", strings.ToUpper(format))
		}
	}
	return nil
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
