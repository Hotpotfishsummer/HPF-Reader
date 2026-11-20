package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// DownloadItem 描述一个下载项。
type DownloadItem struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Filename     string `json:"filename"`
	SizeBytes    int64  `json:"sizeBytes"`
	Status       string `json:"status"` // "completed", "downloading", "failed"
	DownloadedAt string `json:"downloadedAt"`
	FilePath     string `json:"filePath"`
}

// DownloadService 提供下载管理与书籍快速入库能力。
type DownloadService struct {
	app     *application.App
	library *LibraryService
	mu      sync.RWMutex
	dir     string
}

// NewDownloadService 创建下载服务实例。
func NewDownloadService(library *LibraryService) *DownloadService {
	return &DownloadService{library: library}
}

func (s *DownloadService) attach(app *application.App) {
	s.app = app
}

func (s *DownloadService) downloadDir() (string, error) {
	if s.dir == "" {
		base, err := dataDir()
		if err != nil {
			return "", err
		}
		s.dir = filepath.Join(base, "downloads")
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return "", err
	}
	return s.dir, nil
}

// ListDownloads 列出下载目录中的全部电子书文件。
func (s *DownloadService) ListDownloads() ([]DownloadItem, error) {
	dir, err := s.downloadDir()
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	validExts := map[string]bool{
		".epub": true,
		".mobi": true,
		".azw3": true,
		".fb2":  true,
		".cbz":  true,
		".pdf":  true,
		".txt":  true,
	}

	var items []DownloadItem
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if !validExts[ext] {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		sum := sha256.Sum256([]byte(name + fmt.Sprintf("%d", info.Size())))
		id := hex.EncodeToString(sum[:])[:16]

		items = append(items, DownloadItem{
			ID:           id,
			Filename:     name,
			SizeBytes:    info.Size(),
			Status:       "completed",
			DownloadedAt: info.ModTime().UTC().Format(time.RFC3339),
			FilePath:     filepath.Join(dir, name),
		})
	}

	return items, nil
}

// StartDownload 从指定 URL 下载文件保存到下载目录中。
func (s *DownloadService) StartDownload(rawURL string, customFilename string) (DownloadItem, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return DownloadItem{}, errors.New("URL 不能为空")
	}

	dir, err := s.downloadDir()
	if err != nil {
		return DownloadItem{}, err
	}

	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return DownloadItem{}, fmt.Errorf("创建请求失败: %w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 HPF-Reader")

	client := &http.Client{
		Timeout: 5 * time.Minute,
	}
	resp, err := client.Do(req)
	if err != nil {
		return DownloadItem{}, fmt.Errorf("网络请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return DownloadItem{}, fmt.Errorf("服务器返回状态码: %d", resp.StatusCode)
	}

	// 确定文件名
	filename := strings.TrimSpace(customFilename)
	if filename == "" {
		// 从 Content-Disposition 解析
		if cd := resp.Header.Get("Content-Disposition"); cd != "" {
			if _, params, err := mime.ParseMediaType(cd); err == nil {
				if f, ok := params["filename"]; ok && f != "" {
					filename = f
				}
			}
		}
	}
	if filename == "" {
		if parsed, err := url.Parse(rawURL); err == nil {
			filename = filepath.Base(parsed.Path)
		}
	}
	if filename == "" || filename == "." || filename == "/" {
		filename = fmt.Sprintf("download_%d.epub", time.Now().Unix())
	}
	// 去除非法文件名字符
	filename = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\?%*:|"<>`, r) {
			return '_'
		}
		return r
	}, filename)

	// 补全默认后缀
	if filepath.Ext(filename) == "" {
		filename += ".epub"
	}

	dstPath := filepath.Join(dir, filename)
	tmpPath := dstPath + ".tmp"

	out, err := os.Create(tmpPath)
	if err != nil {
		return DownloadItem{}, fmt.Errorf("创建本地文件失败: %w", err)
	}

	written, err := io.Copy(out, resp.Body)
	_ = out.Close()
	if err != nil {
		_ = os.Remove(tmpPath)
		return DownloadItem{}, fmt.Errorf("写入文件失败: %w", err)
	}

	if err := os.Rename(tmpPath, dstPath); err != nil {
		return DownloadItem{}, fmt.Errorf("重命名完成文件失败: %w", err)
	}

	sum := sha256.Sum256([]byte(filename + fmt.Sprintf("%d", written)))
	id := hex.EncodeToString(sum[:])[:16]

	item := DownloadItem{
		ID:           id,
		URL:          rawURL,
		Filename:     filename,
		SizeBytes:    written,
		Status:       "completed",
		DownloadedAt: time.Now().UTC().Format(time.RFC3339),
		FilePath:     dstPath,
	}

	return item, nil
}

// ImportToLibrary 将已下载的文件导入到书库中。
func (s *DownloadService) ImportToLibrary(filename string) (BookSummary, error) {
	if s.library == nil {
		return BookSummary{}, errors.New("library service not initialized")
	}

	dir, err := s.downloadDir()
	if err != nil {
		return BookSummary{}, err
	}

	targetPath := filepath.Join(dir, filename)
	if _, err := os.Stat(targetPath); err != nil {
		return BookSummary{}, fmt.Errorf("文件不存在: %s", filename)
	}

	return s.library.ImportBook(targetPath)
}

// DeleteDownload 删除下载目录中的指定文件。
func (s *DownloadService) DeleteDownload(filename string) error {
	dir, err := s.downloadDir()
	if err != nil {
		return err
	}
	targetPath := filepath.Join(dir, filename)
	return os.Remove(targetPath)
}

// OpenDownloadsFolder 在系统资源管理器中打开下载目录。
func (s *DownloadService) OpenDownloadsFolder() error {
	dir, err := s.downloadDir()
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	case "linux":
		return exec.Command("xdg-open", dir).Start()
	default:
		return nil
	}
}
