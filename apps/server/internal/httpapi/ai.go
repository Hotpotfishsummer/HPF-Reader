package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// ---- DTO ----

type translateRequest struct {
	Text       string            `json:"text"`
	TargetLang string            `json:"targetLang"`
	SourceLang string            `json:"sourceLang"`
	BookID     string            `json:"bookId"`
	Context    string            `json:"context"`
	Glossary   map[string]string `json:"glossary"`
	Model      string            `json:"model"`
}

type aiJobCreateRequest struct {
	Kind    string          `json:"kind"`
	BookID  string          `json:"bookId"`
	Options json.RawMessage `json:"options"`
}

type aiJobDTO struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Status   string          `json:"status"`
	Progress float64         `json:"progress"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    *string         `json:"error,omitempty"`
}

// handleTranslate 是 SSE 流式翻译接口。
//
// 事件协议（全部为 data-only 事件，客户端按行解析）：
//
//	event: delta   data: {"text":"..."}      增量译文
//	event: done    data: {"translated":"..."} 结束（含拼接后的全文，便于客户端对齐）
//	event: error   data: {"code":"...","message":"..."} 中途错误
//
// 用 SSE 而不是 WebSocket：单向流、天然可过代理、断线重连语义简单。
func (s *Server) handleTranslate(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req translateRequest
	if err := decodeJSON(w, r, &req, 2<<20); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "text is required", nil)
		return
	}
	if len(req.Text) > 20000 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "text exceeds 20000 characters", nil)
		return
	}
	if strings.TrimSpace(req.TargetLang) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "targetLang is required", nil)
		return
	}
	if s.translator == nil {
		writeError(w, http.StatusServiceUnavailable, codeUnavailable, "AI gateway is not configured", nil)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, codeInternal, "streaming is not supported by this server", nil)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // 让 nginx/Caddy 不要缓冲
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	stream, errs, err := s.translator.TranslateStream(ctx, ai.TranslateRequest{
		Text:       req.Text,
		TargetLang: req.TargetLang,
		SourceLang: req.SourceLang,
		Context:    req.Context,
		Glossary:   req.Glossary,
		Model:      req.Model,
	})
	if err != nil {
		s.metrics.IncAI(false)
		s.writeSSE(w, flusher, "error", map[string]any{"code": codeUnavailable, "message": err.Error()})
		return
	}

	var builder strings.Builder
	for chunk := range stream {
		builder.WriteString(chunk)
		if !s.writeSSE(w, flusher, "delta", map[string]any{"text": chunk}) {
			// 客户端断开：停止读取，让上游 ctx 取消。
			return
		}
	}
	if err := <-errs; err != nil && !errors.Is(err, context.Canceled) {
		s.metrics.IncAI(false)
		s.writeSSE(w, flusher, "error", map[string]any{"code": codeUnavailable, "message": err.Error()})
		return
	}
	s.metrics.IncAI(true)
	s.writeSSE(w, flusher, "done", map[string]any{"translated": builder.String(), "model": s.translator.Name()})
	_ = claims
}

// writeSSE 写一个 SSE 事件；返回 false 表示写失败（客户端已断开）。
func (s *Server) writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, data any) bool {
	payload, err := json.Marshal(data)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

// handleCreateAIJob 受理后台 AI 任务（入队，由 worker 消费）。
func (s *Server) handleCreateAIJob(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req aiJobCreateRequest
	if err := decodeJSON(w, r, &req, 256<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if !validAIJobKind(req.Kind) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid kind", map[string]any{
			"allowed": []string{"entity_normalize", "book_translate", "summarize"},
		})
		return
	}
	if !idgen.IsUUID(req.BookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	if _, err := s.store.GetBook(r.Context(), claims.UserID, req.BookID); err != nil {
		writeStoreError(w, err)
		return
	}
	job, err := s.store.CreateAIJob(r.Context(), claims.UserID, req.BookID, req.Kind, req.Options)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, toAIJobDTO(job))
}

// handleGetAIJob 查询任务状态。
func (s *Server) handleGetAIJob(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	id := r.PathValue("jobId")
	if !idgen.IsUUID(id) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "jobId must be a UUID", nil)
		return
	}
	job, err := s.store.GetAIJob(r.Context(), claims.UserID, id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toAIJobDTO(job))
}

func toAIJobDTO(j store.AIJob) aiJobDTO {
	out := aiJobDTO{
		ID:       j.ID,
		Kind:     j.Kind,
		Status:   j.Status,
		Progress: j.Progress,
		Result:   j.Result,
		Error:    j.Error,
	}
	return out
}

func validAIJobKind(k string) bool {
	switch k {
	case "entity_normalize", "book_translate", "summarize":
		return true
	}
	return false
}
