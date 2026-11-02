// Package worker 实现后台任务消费（AI 任务 + 定期清理）。
//
// 队列选型说明（任务书要求给出理由）：**不用 asynq/river，直接用 Postgres 表 + SKIP LOCKED**。
//
//  1. 一期是单机自托管，Redis 只是「为了队列而多一个组件」，运维成本不划算；
//  2. ai_jobs 表本身已是任务状态的权威来源（前端要轮询进度），再引入外部队列就得维护两份状态；
//  3. Postgres 的 FOR UPDATE SKIP LOCKED 已经能安全支持多 worker 抢占；
//  4. 迁移路径清晰：等 QPS 上来，把 claimAIJob 换成 asynq 客户端即可，业务代码不动。
package worker

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// Deps 是 worker 依赖。
type Deps struct {
	Logger          *slog.Logger
	Store           *store.Store
	SyncStore       *store.SyncStore
	Translator      ai.Translator
	Interval        time.Duration
	IdempotencyTTL  time.Duration
	CleanupInterval time.Duration
}

// Worker 轮询并处理后台任务。
type Worker struct {
	deps Deps
	id   string
}

// New 构造 worker。
func New(d Deps) *Worker {
	if d.Interval <= 0 {
		d.Interval = 5 * time.Second
	}
	if d.CleanupInterval <= 0 {
		d.CleanupInterval = time.Hour
	}
	if d.IdempotencyTTL <= 0 {
		d.IdempotencyTTL = 7 * 24 * time.Hour
	}
	return &Worker{deps: d, id: "worker-1"}
}

// Run 阻塞运行直到 ctx 取消。
func (w *Worker) Run(ctx context.Context) {
	w.deps.Logger.Info("background worker started", "poll_interval", w.deps.Interval.String())

	poll := time.NewTicker(w.deps.Interval)
	defer poll.Stop()
	cleanup := time.NewTicker(w.deps.CleanupInterval)
	defer cleanup.Stop()

	for {
		select {
		case <-ctx.Done():
			w.deps.Logger.Info("background worker stopping")
			return
		case <-poll.C:
			w.drain(ctx)
		case <-cleanup.C:
			w.cleanup(ctx)
		}
	}
}

// drain 处理当前所有就绪任务（一次最多 20 个，避免长时间独占）。
func (w *Worker) drain(ctx context.Context) {
	for i := 0; i < 20; i++ {
		if ctx.Err() != nil {
			return
		}
		job, err := w.deps.Store.ClaimAIJob(ctx, w.id)
		if err != nil {
			if err == store.ErrNotFound {
				return
			}
			w.deps.Logger.Warn("claim ai job failed", "error", err)
			return
		}
		w.process(ctx, job)
	}
}

// process 处理单个任务。
//
// 一期行为：把任务标记为 failed 并写明「未接入模型」，而不是假装成功。
// 虚假的 succeeded 会让前端与用户误以为正文已被处理，属于最糟的失败模式。
func (w *Worker) process(ctx context.Context, job store.AIJob) {
	log := w.deps.Logger.With("job_id", job.ID, "kind", job.Kind, "user_id", job.UserID)
	log.Info("processing ai job", "attempt", job.Attempts)

	// 占位实现：真正的整书翻译 / 实体归一化需要分块调度与长事务，
	// 属于 M5 范围。这里保证「任务被消费、状态被正确推进、错误可解释」。
	result, _ := json.Marshal(map[string]any{
		"status":   "not_implemented",
		"kind":     job.Kind,
		"message":  "AI 后台任务处理器尚未接入模型调用（M5 范围）；接口与状态机已就绪",
		"provider": w.providerName(),
	})
	if err := w.deps.Store.FinishAIJob(ctx, job.ID, "failed", 0, result,
		"AI job processor is not implemented yet (planned for M5)"); err != nil {
		log.Error("finish ai job failed", "error", err)
		return
	}
	log.Info("ai job marked as not implemented")
}

func (w *Worker) providerName() string {
	if w.deps.Translator == nil {
		return "none"
	}
	return w.deps.Translator.Name()
}

// cleanup 做周期性清理：
//   - sync_idempotency 超过保留窗口（7 天）的记录；
//   - 过期/已吊销的 refresh token。
func (w *Worker) cleanup(ctx context.Context) {
	if n, err := w.deps.SyncStore.PurgeIdempotency(ctx, w.deps.IdempotencyTTL); err != nil {
		w.deps.Logger.Warn("purge idempotency records failed", "error", err)
	} else if n > 0 {
		w.deps.Logger.Info("purged idempotency records", "count", n)
	}
	if n, err := w.deps.Store.DeleteExpiredRefreshTokens(ctx, 24*time.Hour); err != nil {
		w.deps.Logger.Warn("purge refresh tokens failed", "error", err)
	} else if n > 0 {
		w.deps.Logger.Info("purged refresh tokens", "count", n)
	}
}
