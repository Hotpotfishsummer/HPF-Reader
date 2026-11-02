package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// ---- DTO ----

type progressDTO struct {
	Locator          json.RawMessage `json:"locator,omitempty"`
	FurthestLocator  json.RawMessage `json:"furthestLocator,omitempty"`
	TotalProgression float64         `json:"totalProgression"`
	ExplicitRewind   bool            `json:"explicitRewind"`
	HLC              string          `json:"hlc,omitempty"`
	DeviceID         string          `json:"deviceId,omitempty"`
	UpdatedAt        string          `json:"updatedAt,omitempty"`
}

type bookDTO struct {
	ID           string       `json:"id"`
	Title        string       `json:"title"`
	Author       *string      `json:"author"`
	Language     *string      `json:"language"`
	Format       string       `json:"format"`
	ContentHash  *string      `json:"contentHash"`
	SizeBytes    *int64       `json:"sizeBytes"`
	ReadingState string       `json:"readingState"`
	Progress     *progressDTO `json:"progress,omitempty"`
	CreatedAt    string       `json:"createdAt"`
	UpdatedAt    string       `json:"updatedAt"`
}

type bookCreateRequest struct {
	Title       string  `json:"title"`
	Author      *string `json:"author"`
	Language    *string `json:"language"`
	Format      string  `json:"format"`
	ContentHash string  `json:"contentHash"`
	Series      *string `json:"series"`
}

type bookUpdateRequest struct {
	Title        *string         `json:"title"`
	Author       *string         `json:"author"`
	ReadingState *string         `json:"readingState"`
	Rating       *int            `json:"rating"`
	Metadata     json.RawMessage `json:"metadata"`
}

type bookPageDTO struct {
	Items      []bookDTO `json:"items"`
	NextCursor *string   `json:"nextCursor"`
}

// handleListBooks 游标分页列表。
func (s *Server) handleListBooks(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	limit, err := queryInt(r, "limit", 50, 1, 200)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "limit must be an integer", nil)
		return
	}
	cursor, err := store.DecodeCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid cursor", nil)
		return
	}
	params := store.ListBooksParams{UserID: claims.UserID, Limit: limit, Cursor: cursor}
	if raw := r.URL.Query().Get("updatedSince"); raw != "" {
		ts, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, "updatedSince must be RFC3339", nil)
			return
		}
		params.UpdatedSince = &ts
	}
	books, next, err := s.store.ListBooks(r.Context(), params)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]bookDTO, 0, len(books))
	for _, b := range books {
		items = append(items, toBookDTO(b))
	}
	out := bookPageDTO{Items: items}
	if next != "" {
		out.NextCursor = &next
	}
	writeJSON(w, http.StatusOK, out)
}

// handleCreateBook 创建书籍记录（随后 PUT 文件）。
func (s *Server) handleCreateBook(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req bookCreateRequest
	if err := decodeJSON(w, r, &req, 256<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if len(req.Title) == 0 || len(req.Title) > 512 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "title is required (max 512 chars)", nil)
		return
	}
	if req.Format == "" {
		req.Format = "epub"
	}
	if !validFormat(req.Format) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "unsupported format "+req.Format, nil)
		return
	}
	var hash *string
	if req.ContentHash != "" {
		h, err := storage.NormalizeHash(req.ContentHash)
		if err != nil {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error(), nil)
			return
		}
		hash = &h
	}
	book, err := s.store.CreateBook(r.Context(), store.BookCreateInput{
		UserID:       claims.UserID,
		Title:        req.Title,
		Author:       req.Author,
		Language:     req.Language,
		Format:       req.Format,
		ContentHash:  hash,
		Series:       req.Series,
		ReadingState: "unread",
	})
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, codeConflict, "a book with the same content hash already exists", nil)
			return
		}
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toBookDTO(store.BookWithProgress{Book: book}))
}

// handleGetBook 书籍详情（含服务端权威进度）。
func (s *Server) handleGetBook(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	b, err := s.store.GetBookWithProgress(r.Context(), claims.UserID, bookID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toBookDTO(b))
}

// handleUpdateBook 更新元数据 / 阅读状态。
func (s *Server) handleUpdateBook(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	var req bookUpdateRequest
	if err := decodeJSON(w, r, &req, 256<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if req.ReadingState != nil && !validReadingState(*req.ReadingState) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid readingState", nil)
		return
	}
	if req.Rating != nil && (*req.Rating < 0 || *req.Rating > 5) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "rating must be 0..5", nil)
		return
	}
	patch := store.BookPatch{
		Title:        req.Title,
		Author:       req.Author,
		ReadingState: req.ReadingState,
		Rating:       req.Rating,
		RatingSet:    req.Rating != nil,
		Metadata:     req.Metadata,
	}
	book, err := s.store.UpdateBook(r.Context(), claims.UserID, bookID, patch)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	b, err := s.store.GetBookWithProgress(r.Context(), claims.UserID, book.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toBookDTO(b))
}

// handleDeleteBook 软删除书籍。
func (s *Server) handleDeleteBook(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	if err := s.store.SoftDeleteBook(r.Context(), claims.UserID, bookID); err != nil {
		writeStoreError(w, err)
		return
	}
	s.audit(r, &claims.UserID, "book.delete", bookID, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ---- 映射工具 ----

func toBookDTO(b store.BookWithProgress) bookDTO {
	out := bookDTO{
		ID:           b.ID,
		Title:        b.Title,
		Author:       b.Author,
		Language:     b.Language,
		Format:       b.Format,
		ContentHash:  b.FileHash,
		ReadingState: b.ReadingState,
		CreatedAt:    b.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:    b.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if b.FileSize > 0 {
		size := b.FileSize
		out.SizeBytes = &size
	}
	if b.Progress != nil {
		p := &progressDTO{
			Locator:          b.Progress.Locator,
			FurthestLocator:  b.Progress.FurthestLocator,
			TotalProgression: b.Progress.TotalProgression,
			ExplicitRewind:   b.Progress.ExplicitRewind,
			HLC:              b.Progress.HLC,
			UpdatedAt:        b.Progress.UpdatedAt.UTC().Format(time.RFC3339),
		}
		if b.Progress.DeviceID != nil {
			p.DeviceID = *b.Progress.DeviceID
		}
		out.Progress = p
	}
	return out
}

func validFormat(f string) bool {
	switch f {
	case "epub", "pdf", "txt", "mobi", "azw3", "fb2", "cbz", "html", "md":
		return true
	}
	return false
}

func validReadingState(s string) bool {
	switch s {
	case "unread", "reading", "finished", "archived":
		return true
	}
	return false
}
