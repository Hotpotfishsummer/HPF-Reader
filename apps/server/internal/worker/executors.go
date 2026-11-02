package worker

import (
	"context"
	"errors"
	"fmt"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// 任务级哨兵错误。
var (
	// errNotImplemented 表示该 kind 的执行器还没接上（骨架阶段）。
	errNotImplemented = errors.New("worker: executor not implemented yet")
	// errUnknownKind 表示 ai_jobs.kind 是未知取值。
	errUnknownKind = errors.New("worker: unknown job kind")
)

// normalizeResult 是 entity_normalize 任务的 result 形态（骨架）。
//
// 字段先定下来，M5-4 填逻辑时前端契约不用改。
type normalizeResult struct {
	// Status 说明本阶段进度：not_implemented / partial / ok。
	Status string `json:"status"`
	// TotalChunks / DoneChunks 与 book_translate 保持一致的进度语义。
	TotalChunks int `json:"totalChunks"`
	DoneChunks  int `json:"doneChunks"`
	// EntityCount 是抽取到的实体数。
	EntityCount int `json:"entityCount"`
	// MergedCount 是自动合并的对数（每对都要能在 correction 日志里被拆开）。
	MergedCount int `json:"mergedCount"`
	// ReplayedCorrections 是本次重放的用户修正事件数。
	// **重放是核心语义**：重跑不能冲掉用户的人工修改（80 号调研 §A7）。
	ReplayedCorrections int `json:"replayedCorrections"`
}

// runEntityNormalize 是 entity_normalize 的骨架实现。
//
// 本阶段**故意不实现**：它依赖实体抽取流水线（书内共指消解 + 跨书聚类），
// 那是一个独立的、需要 LLM 多轮裁决的子系统，硬塞进本期会做出半成品。
// 但两件事已经就位，M5-4 可以直接接着写：
//
//  1. `book_correction` 表（append-only 修正日志，永不 UPDATE/DELETE）；
//  2. `book_blocked_pair` 表（负样本对，防重跑把用户拆开的又合回去）。
//
// 为什么先建表而不是先写逻辑：
// 这两张表是**数据契约**，一旦有了真实用户数据再改结构，迁移成本极高。
// 而逻辑可以随时补。先把「用户修正怎么存」定死，比先写抽取算法更重要。
func (w *Worker) runEntityNormalize(ctx context.Context, job store.AIJob) (normalizeResult, error) {
	if job.BookID == nil {
		return normalizeResult{}, fmt.Errorf("entity_normalize requires bookId")
	}
	res := normalizeResult{Status: "not_implemented"}
	// 重放已有的用户修正事件数（只读，用来证明日志表可用）。
	// 即便逻辑没实现，这个计数也能让前端显示「已有 N 条人工修正待重放」。
	n, err := w.deps.Store.CountCorrections(ctx, *job.BookID)
	if err != nil {
		w.deps.Logger.Warn("count corrections failed", "error", err)
	}
	res.ReplayedCorrections = n
	return res, fmt.Errorf("%w: entity_normalize (planned for M5-4; correction log schema is ready)",
		errNotImplemented)
}

// summarizeResult 是 summarize 任务的 result 形态（骨架）。
type summarizeResult struct {
	Status       string `json:"status"`
	TotalChunks  int    `json:"totalChunks"`
	DoneChunks   int    `json:"doneChunks"`
	SummaryChars int    `json:"summaryChars"`
}

// runSummarize 是 summarize 的骨架实现。
//
// 优先级最低：摘要不影响正确性，只是锦上添花。
// 与 book_translate 共享同一套分块/断点续跑结构，实现时直接复用 chunk 表即可，
// 只需把 feature 换成 "summarize" 以便配额按功能分别统计。
func (w *Worker) runSummarize(ctx context.Context, job store.AIJob) (summarizeResult, error) {
	if job.BookID == nil {
		return summarizeResult{}, fmt.Errorf("summarize requires bookId")
	}
	return summarizeResult{Status: "not_implemented"},
		fmt.Errorf("%w: summarize", errNotImplemented)
}
