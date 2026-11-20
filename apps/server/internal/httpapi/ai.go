package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

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

	ctx := r.Context()
	aiReq := ai.TranslateRequest{
		Text:       req.Text,
		TargetLang: req.TargetLang,
		SourceLang: req.SourceLang,
		Context:    req.Context,
		Glossary:   req.Glossary,
		Model:      req.Model,
	}

	// ---- 成本闸门：必须在写 SSE 头之前完成 ----
	//
	// 一旦写了 200 + text/event-stream，就再也改不回 429 了（HTTP 头已经发出）。
	// 所以预扣必须发生在这里，而不是流结束之后——后者等于没有闸门：
	// 并发的 N 个请求会同时穿过判定，然后一起把额度用掉。
	//
	// 预扣的 token 数是**输入估算 + 输出上限的一半**：输出长度未知，
	// 取输入估算的一半作为保守估计。真实用量在 Settle 时结算差额。
	//
	// 顺序是先查全站预算、再做用户预扣：全站预算检查是纯读（不写库），
	// 先做它可以避免「全站已超额时还白白消耗一次用户预扣」。
	if err := s.checkGlobalAIBudget(r.Context()); err != nil {
		s.metrics.IncAI(false)
		writeQuotaExceeded(w, err)
		return
	}
	reserved := int64(ai.EstimateRequestTokens(aiReq))
	reserved += reserved / 2
	if reserved < 1 {
		reserved = 1
	}
	if _, err := s.store.Reserve(ctx, claims.UserID, reserved); err != nil {
		var qe *store.ErrQuotaExceeded
		if errors.As(err, &qe) {
			s.metrics.IncAI(false)
			writeQuotaExceeded(w, err)
			return
		}
		writeStoreError(w, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // 让 nginx/Caddy 不要缓冲
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	stream, errs, usageCh, err := s.translator.TranslateStreamWithUsage(ctx, aiReq)
	if err != nil {
		// 上游拒绝：这次调用没有产生任何 token，但仍要结算（把预扣退回去）并记账，
		// 否则预扣会永久占着用户的额度。失败也是花钱的，只是这次没花成。
		s.settleAI(r, claims.UserID, "translate", s.translator.Name(), reserved, ai.Usage{
			Source: ai.UsageSourceEstimated,
		}, "failed", err.Error())
		s.metrics.IncAI(false)
		s.writeSSE(w, flusher, "error", map[string]any{"code": codeUnavailable, "message": err.Error()})
		return
	}

	var builder strings.Builder
	clientGone := false
	for chunk := range stream {
		builder.WriteString(chunk)
		if !s.writeSSE(w, flusher, "delta", map[string]any{"text": chunk}) {
			// 客户端断开：停止读取，让上游 ctx 取消。
			clientGone = true
			break
		}
	}
	// 必须把 errs 与 usageCh 都读完：上游 goroutine 在关闭 out 之后才会写这两个通道，
	// 提前 return 会让它们永久阻塞（goroutine 泄漏 + 记账丢失）。
	streamErr := <-errs
	usage := <-usageCh

	status := "ok"
	var errMsg string
	switch {
	case clientGone:
		status = "canceled"
		errMsg = "client disconnected"
	case streamErr != nil && !errors.Is(streamErr, context.Canceled):
		status = "failed"
		errMsg = streamErr.Error()
	}
	s.settleAI(r, claims.UserID, "translate", s.translator.Name(), reserved, usage, status, errMsg)

	if status == "ok" {
		s.metrics.IncAI(true)
		s.writeSSE(w, flusher, "done", map[string]any{
			"translated": builder.String(),
			"model":      s.translator.Name(),
		})
		return
	}
	if !clientGone {
		s.metrics.IncAI(false)
		s.writeSSE(w, flusher, "error", map[string]any{"code": codeUnavailable, "message": errMsg})
	}
}

// checkGlobalAIBudget 做全站月度调用上限判定（HPF_AI_GLOBAL_MONTHLY_CALLS）。
//
// 为什么需要这道闸门：每用户配额只约束「一个账号能花多少」。注册开放时
// 攻击者注册 N 个账号就得到 N 份额度，账单按 N 倍增长——每用户配额对
// 「多账号绕过」完全无效。全站上限是最后一道成本闸门。
//
// 实现上刻意**直接查库、不加缓存层**：
//   - AI 调用本身要花几秒到几十秒，一次 SUM 聚合的开销可以忽略；
//   - 缓存会引入「多个副本各算各的账」和「缓存未失效导致超额放行」两种新失效模式，
//     而这道闸门存在的意义就是防超额，用缓存换来的性能提升不值这个风险。
//
// store 层未配置（例如只跑路由的最小 Server）时直接放行：
// 这些测试不覆盖成本语义，让它们因为「没有数据库」而 500 反而是噪声。
func (s *Server) checkGlobalAIBudget(ctx context.Context) error {
	limit := s.cfg.AIGlobalMonthlyCalls
	if limit <= 0 || s.store == nil {
		return nil
	}
	return s.store.CheckGlobalAICallBudget(ctx, limit)
}

// settleAI 用真实用量结算预扣并记账。
//
// 记账失败只记日志、不影响响应：用户已经拿到了译文，
// 因为记账写库失败就回一个错误属于本末倒置。但日志必须留下，
// 否则「账单对不上」时会无从查起。
func (s *Server) settleAI(r *http.Request, userID, feature, model string, reserved int64, usage ai.Usage, status, errMsg string) {
	u := store.AIUsage{
		Feature:      feature,
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		UsageSource:  usage.Source,
		Outcome:      status,
		CostCents:    ai.DefaultTokenPrice.CostCents(usage.InputTokens, usage.OutputTokens),
	}
	if u.UsageSource == "" {
		u.UsageSource = ai.UsageSourceEstimated
	}
	if model != "" {
		u.Model = &model
	}
	if errMsg != "" {
		u.Error = &errMsg
	}
	if rid := requestID(r.Context()); rid != "" {
		u.RequestID = &rid
	}
	// 结算与记账放在同一个事务里：只结算不记账 = 额度少了但没有账目；
	// 只记账不结算 = 额度永久被预扣占着。
	if _, err := s.store.Settle(context.WithoutCancel(r.Context()), userID, reserved, u); err != nil {
		s.log.Error("settle ai usage failed", "error", err, "user_id", userID, "feature", feature)
	}
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

	// 后台任务同样要过闸门：整书翻译一次可能花 1~2 元，
	// 不在这里拦就等 worker 跑起来才发现额度不够，用户已经等了半天。
	//
	// 这里只预扣「1 次调用 + 一个保守的 token 估计」作为入场费：
	// 真实消耗由 worker 在**每个块处理前**用同一套 Reserve/Settle 逐块结算，
	// 超限时把任务置为 paused（可续跑）而不是 failed。
	// 也就是说这里的预扣是「占位」，不是「一次性买断」——
	// 这正是 M5-2 需要的结构，不要把它改成一锤子买卖。
	//
	// 全站预算必须在入队前查：否则多账号可以把无数个任务塞进队列，
	// 每个任务都是「已经答应了用户会跑」的承诺，等到 worker 才发现超额时
	// 用户已经在等结果了（而且队列里的任务会一直堆到下个月）。
	if err := s.checkGlobalAIBudget(r.Context()); err != nil {
		writeQuotaExceeded(w, err)
		return
	}
	const jobReserveTokens = 100000 // 约一本中等篇幅书的入场估计，块级结算会修正
	if _, err := s.store.Reserve(r.Context(), claims.UserID, jobReserveTokens); err != nil {
		var qe *store.ErrQuotaExceeded
		if errors.As(err, &qe) {
			writeQuotaExceeded(w, err)
			return
		}
		writeStoreError(w, err)
		return
	}

	job, err := s.store.CreateAIJob(r.Context(), claims.UserID, req.BookID, req.Kind, req.Options)
	if err != nil {
		// 入队失败要把预扣退回去，否则用户额度被占着却没有任何任务。
		s.releaseReservation(r, claims.UserID, jobReserveTokens)
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, toAIJobDTO(job))
}

// handleListAIJobs 查询用户的 AI 任务列表，支持 ?bookId=...
func (s *Server) handleListAIJobs(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.URL.Query().Get("bookId")
	if bookID != "" && !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	jobs, err := s.store.ListAIJobs(r.Context(), claims.UserID, bookID, limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out := make([]aiJobDTO, len(jobs))
	for i, j := range jobs {
		out[i] = toAIJobDTO(j)
	}
	writeJSON(w, http.StatusOK, out)
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

type translationChunkDTO struct {
	ChunkIndex   int     `json:"chunkIndex"`
	ChapterIndex int     `json:"chapterIndex"`
	SourceText   string  `json:"sourceText"`
	OutputText   *string `json:"outputText"`
	Status       string  `json:"status"`
}

type jobChunksResponse struct {
	JobID  string                `json:"jobId"`
	Chunks []translationChunkDTO `json:"chunks"`
}

// handleGetAIJobChunks 返回指定任务的翻译分块列表。
func (s *Server) handleGetAIJobChunks(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	jobID := r.PathValue("jobId")
	if !idgen.IsUUID(jobID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "jobId must be a UUID", nil)
		return
	}
	job, err := s.store.GetAIJob(r.Context(), claims.UserID, jobID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	chunks, err := s.store.ListChunks(r.Context(), job.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	dtos := make([]translationChunkDTO, len(chunks))
	for i, c := range chunks {
		dtos[i] = translationChunkDTO{
			ChunkIndex:   c.ChunkIndex,
			ChapterIndex: c.ChapterIndex,
			SourceText:   c.SourceText,
			OutputText:   c.OutputText,
			Status:       c.Status,
		}
	}
	writeJSON(w, http.StatusOK, jobChunksResponse{
		JobID:  job.ID,
		Chunks: dtos,
	})
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

// aiUsageResponse 是 GET /v1/ai/usage 的响应体。
//
// 两个维度都返回：只回一个的话，客户端没法解释「为什么被拒了」。
type aiUsageResponse struct {
	PeriodStart time.Time      `json:"periodStart"`
	ResetAt     time.Time      `json:"resetAt"`
	Calls       quotaDimension `json:"calls"`
	Tokens      quotaDimension `json:"tokens"`
	// Usage 是本周期内的实际记账汇总（按 feature），用于核对「配额消耗」与「真实成本」是否一致。
	Usage map[string]usageAggregateDTO `json:"usage"`
}

type quotaDimension struct {
	Used      int64 `json:"used"`
	Quota     int64 `json:"quota"`
	Remaining int64 `json:"remaining"`
}

type usageAggregateDTO struct {
	Calls        int64 `json:"calls"`
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	CostCents    int64 `json:"costCents"`
}

// handleGetAIUsage 返回当前周期的配额与用量。
//
// 只读接口：不能顺手把跨月周期翻篇，否则「看一眼用量」就会重置已用量。
func (s *Server) handleGetAIUsage(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	snap, err := s.store.GetQuota(r.Context(), claims.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	agg, err := s.store.SumAIUsage(r.Context(), claims.UserID, snap.PeriodStart)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out := aiUsageResponse{
		PeriodStart: snap.PeriodStart.UTC(),
		ResetAt:     snap.ResetAt.UTC(),
		Calls: quotaDimension{
			Used:      snap.CallsUsed,
			Quota:     snap.CallsQuota,
			Remaining: snap.CallsRemaining(),
		},
		Tokens: quotaDimension{
			Used:      snap.TokensUsed,
			Quota:     snap.TokensQuota,
			Remaining: snap.TokensRemaining(),
		},
		Usage: map[string]usageAggregateDTO{},
	}
	for feature, a := range agg {
		out.Usage[feature] = usageAggregateDTO{
			Calls: a.Calls, InputTokens: a.InputTokens,
			OutputTokens: a.OutputTokens, CostCents: a.CostCents,
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// releaseReservation 在「预扣成功但后续步骤失败」时把额度退回去。
//
// 只退 token 额度不退调用次数：这次调用确实发生了（用户点了按钮、服务端做了判断），
// 退掉次数会让「高频刷失败请求」绕过次数闸门。
func (s *Server) releaseReservation(r *http.Request, userID string, reserved int64) {
	if reserved <= 0 {
		return
	}
	if err := s.store.ReleaseTokens(context.WithoutCancel(r.Context()), userID, reserved); err != nil {
		s.log.Error("release reservation failed", "error", err, "user_id", userID)
	}
}
