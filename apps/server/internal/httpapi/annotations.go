package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// ---- DTO ----

type annotationDTO struct {
	ID        string          `json:"id"`
	BookID    string          `json:"bookId"`
	Type      string          `json:"type"`
	Locator   json.RawMessage `json:"locator"`
	Color     *string         `json:"color"`
	Note      *string         `json:"note"`
	Text      *string         `json:"text"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

type annotationCreateRequest struct {
	Locator json.RawMessage `json:"locator"`
	Type    string          `json:"type"`
	Color   *string         `json:"color"`
	Note    *string         `json:"note"`
	Text    *string         `json:"text"`
}

type annotationUpdateRequest struct {
	Type     *string         `json:"type"`
	Locator  json.RawMessage `json:"locator"`
	Color    *string         `json:"color"`
	ColorSet bool            `json:"-"`
	Note     *string         `json:"note"`
	NoteSet  bool            `json:"-"`
	Text     *string         `json:"text"`
	TextSet  bool            `json:"-"`
}

// handleListAnnotations 列出某本书的标注。
func (s *Server) handleListAnnotations(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	// 确认书籍归属，避免越权读取他人标注。
	if _, err := s.store.GetBook(r.Context(), claims.UserID, bookID); err != nil {
		writeStoreError(w, err)
		return
	}
	list, err := s.store.ListAnnotations(r.Context(), claims.UserID, bookID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out := make([]annotationDTO, 0, len(list))
	for _, a := range list {
		out = append(out, toAnnotationDTO(a))
	}
	writeJSON(w, http.StatusOK, out)
}

// handleCreateAnnotation 新建标注。
//
// 与同步引擎共享同一套 HLC：服务端用高精度时钟生成 HLC，
// 因此后续客户端 push 的字段级 LWW 能正确判断先后。
func (s *Server) handleCreateAnnotation(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	var req annotationCreateRequest
	if err := decodeJSON(w, r, &req, 512<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if !validAnnotationType(req.Type) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid annotation type", nil)
		return
	}
	if len(req.Locator) == 0 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "locator is required", nil)
		return
	}
	if _, err := s.store.GetBook(r.Context(), claims.UserID, bookID); err != nil {
		writeStoreError(w, err)
		return
	}
	hlc := s.syncEngine.ServerHLC()
	payload := mustJSON(map[string]any{
		"type":    req.Type,
		"locator": json.RawMessage(req.Locator),
		"color":   req.Color,
		"note":    req.Note,
		"text":    req.Text,
	})
	ann, err := s.store.CreateAnnotation(r.Context(), store.AnnotationInput{
		ID:      idgen.NewUUID(),
		UserID:  claims.UserID,
		BookID:  bookID,
		Kind:    req.Type,
		Locator: req.Locator,
		Color:   req.Color,
		Text:    req.Text,
		Note:    req.Note,
		Payload: payload,
		HLC:     hlc,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// 让这份服务端写入也进入 change_log，其它设备才拉得到。
	if err := s.recordServerChange(r.Context(), claims.UserID, syncChangeInput{
		Entity:   entityAnnotation,
		EntityID: ann.ID,
		BookID:   &bookID,
		Kind:     kindUpsert,
		HLC:      hlc,
		Payload:  payload,
	}); err != nil {
		s.log.Error("record annotation change", "error", err, "annotation_id", ann.ID)
	}
	writeJSON(w, http.StatusCreated, toAnnotationDTO(ann))
}

// handleUpdateAnnotation 部分更新标注（含显式置空语义）。
func (s *Server) handleUpdateAnnotation(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	id := r.PathValue("annotationId")
	if !idgen.IsUUID(id) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "annotationId must be a UUID", nil)
		return
	}
	// 用 map 解析以区分「字段缺失」与「显式 null」。
	var raw map[string]json.RawMessage
	if err := decodeJSON(w, r, &raw, 512<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	var patch store.AnnotationPatch
	patch.HLC = s.syncEngine.ServerHLC()
	if v, ok := raw["type"]; ok {
		var t string
		if err := json.Unmarshal(v, &t); err != nil || !validAnnotationType(t) {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid annotation type", nil)
			return
		}
		patch.Kind = &t
	}
	if v, ok := raw["locator"]; ok && string(v) != "null" {
		patch.Locator = v
	}
	if v, ok := raw["color"]; ok {
		patch.ColorSet = true
		if string(v) != "null" {
			var c string
			if err := json.Unmarshal(v, &c); err != nil {
				writeError(w, http.StatusBadRequest, codeInvalidRequest, "color must be a string or null", nil)
				return
			}
			patch.Color = &c
		}
	}
	if v, ok := raw["note"]; ok {
		patch.NoteSet = true
		if string(v) != "null" {
			var n string
			if err := json.Unmarshal(v, &n); err != nil {
				writeError(w, http.StatusBadRequest, codeInvalidRequest, "note must be a string or null", nil)
				return
			}
			patch.Note = &n
		}
	}
	if v, ok := raw["text"]; ok {
		patch.TextSet = true
		if string(v) != "null" {
			var t string
			if err := json.Unmarshal(v, &t); err != nil {
				writeError(w, http.StatusBadRequest, codeInvalidRequest, "text must be a string or null", nil)
				return
			}
			patch.Text = &t
		}
	}
	ann, err := s.store.UpdateAnnotation(r.Context(), claims.UserID, id, patch)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	payload := mustJSON(map[string]any{
		"type":    ann.Kind,
		"locator": json.RawMessage(ann.Locator),
		"color":   ann.Color,
		"note":    ann.Note,
		"text":    ann.Text,
	})
	bookID := ann.BookID
	if err := s.recordServerChange(r.Context(), claims.UserID, syncChangeInput{
		Entity:   entityAnnotation,
		EntityID: ann.ID,
		BookID:   &bookID,
		Kind:     kindUpsert,
		HLC:      patch.HLC,
		Payload:  payload,
	}); err != nil {
		s.log.Error("record annotation change", "error", err, "annotation_id", ann.ID)
	}
	writeJSON(w, http.StatusOK, toAnnotationDTO(ann))
}

// handleDeleteAnnotation 软删除标注（墓碑，remove-wins 由同步引擎保证）。
func (s *Server) handleDeleteAnnotation(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	id := r.PathValue("annotationId")
	if !idgen.IsUUID(id) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "annotationId must be a UUID", nil)
		return
	}
	existing, err := s.store.GetAnnotation(r.Context(), claims.UserID, id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// 幂等删除：已经没了也返回 204。
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeStoreError(w, err)
		return
	}
	hlc := s.syncEngine.ServerHLC()
	if err := s.store.SoftDeleteAnnotation(r.Context(), claims.UserID, id, hlc); err != nil {
		writeStoreError(w, err)
		return
	}
	bookID := existing.BookID
	if err := s.recordServerChange(r.Context(), claims.UserID, syncChangeInput{
		Entity:   entityAnnotation,
		EntityID: id,
		BookID:   &bookID,
		Kind:     kindDelete,
		HLC:      hlc,
		Payload:  nil,
	}); err != nil {
		s.log.Error("record annotation delete", "error", err, "annotation_id", id)
	}
	s.audit(r, &claims.UserID, "annotation.delete", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

func toAnnotationDTO(a store.Annotation) annotationDTO {
	return annotationDTO{
		ID:        a.ID,
		BookID:    a.BookID,
		Type:      a.Kind,
		Locator:   a.Locator,
		Color:     a.Color,
		Note:      a.Note,
		Text:      a.Text,
		CreatedAt: a.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: a.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func validAnnotationType(t string) bool {
	switch t {
	case "highlight", "underline", "note", "bookmark":
		return true
	}
	return false
}
