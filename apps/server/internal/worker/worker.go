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
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// Deps 是 worker 依赖。
type Deps struct {
	Logger     *slog.Logger
	Store      *store.Store
	SyncStore  *store.SyncStore
	Translator ai.Translator
	// Storage 用于读取书籍原始文件（整书翻译需要从 EPUB 抽章节）。
	Storage         storage.Store
	Interval        time.Duration
	IdempotencyTTL  time.Duration
	CleanupInterval time.Duration
	// StaleJobAfter 是 running 任务的租约时长：超过它没更新 locked_at 就判定为卡死。
	// 默认 15 分钟；整书翻译是逐块推进的，块与块之间会刷新 locked_at，所以不会误判。
	StaleJobAfter time.Duration
	// MaxAttempts 是重试上限：超过就不再退回 queued，避免毒任务无限重跑烧钱。
	MaxAttempts int
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
	if d.StaleJobAfter <= 0 {
		d.StaleJobAfter = 15 * time.Minute
	}
	if d.MaxAttempts <= 0 {
		d.MaxAttempts = 3
	}
	return &Worker{deps: d, id: "worker-1"}
}

// Run 阻塞运行直到 ctx 取消。
func (w *Worker) Run(ctx context.Context) {
	w.deps.Logger.Info("background worker started", "poll_interval", w.deps.Interval.String())

	// 启动时先回收上一次进程崩溃/重启遗留的 running 任务。
	// 不做这一步的话，这些任务永远不会被再捞到（ClaimAIJob 只认 queued）。
	w.reclaimStale(ctx)

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
			// 每轮都回收：多 worker 部署时，别的 worker 挂掉留下的任务也能被接走，
			// 不必等重启。开销是一条 UPDATE，可忽略。
			w.reclaimStale(ctx)
			w.drain(ctx)
		case <-cleanup.C:
			w.cleanup(ctx)
		}
	}
}

// reclaimStale 把租约超时的 running 任务退回 queued。
//
// 这是断点续跑的前提：任务若不回到 queued，就永远没机会被重新执行。
func (w *Worker) reclaimStale(ctx context.Context) {
	n, err := w.deps.Store.ReclaimStaleJobs(ctx, w.deps.StaleJobAfter, w.deps.MaxAttempts)
	if err != nil {
		w.deps.Logger.Warn("reclaim stale jobs failed", "error", err)
		return
	}
	if n > 0 {
		w.deps.Logger.Info("reclaimed stale running jobs", "count", n)
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

// process 处理单个任务：按 kind 分派到具体实现。
//
// 为什么必须有明确的「未实现」兜底而不是静默成功：
// 虚假的 succeeded 会让前端与用户误以为正文已被处理，是最糟的失败模式。
// 未知 kind 一律 failed 并写明原因。
func (w *Worker) process(ctx context.Context, job store.AIJob) {
	log := w.deps.Logger.With("job_id", job.ID, "kind", job.Kind, "user_id", job.UserID)
	log.Info("processing ai job", "attempt", job.Attempts)

	var (
		result any
		err    error
		status = "succeeded"
		prog   = 1.0
	)

	switch job.Kind {
	case "book_translate":
		var res translateResult
		res, err = w.runBookTranslate(ctx, job)
		result = res
		prog = chunkFraction(res.DoneChunks, res.TotalChunks)
		switch {
		case errors.Is(err, errJobPaused):
			// 配额耗尽：暂停而不是失败，已完成块全部保留，下个周期可续跑。
			status = "paused"
			err = nil
		case errors.Is(err, errJobCanceled):
			status = "canceled"
			err = nil
		case errors.Is(err, context.Canceled):
			// 进程关闭：任务保持 running，重启后会被 ClaimAIJob 重新捞起。
			log.Info("worker shutting down; leaving job running for resume")
			return
		}
	case "entity_normalize":
		var res normalizeResult
		res, err = w.runEntityNormalize(ctx, job)
		result = res
		if errors.Is(err, errNotImplemented) {
			status, err = "failed", errNotImplemented
		}
	case "summarize":
		var res summarizeResult
		res, err = w.runSummarize(ctx, job)
		result = res
		if errors.Is(err, errNotImplemented) {
			status, err = "failed", errNotImplemented
		}
	default:
		err = fmt.Errorf("%w: kind %q", errUnknownKind, job.Kind)
	}

	if err != nil && status == "succeeded" {
		status = "failed"
	}
	var payload json.RawMessage
	if result != nil {
		if b, mErr := json.Marshal(result); mErr == nil {
			payload = b
		}
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	var finErr error
	if status == "paused" {
		finErr = w.deps.Store.PauseAIJob(ctx, job.ID, prog, payload, errMsg)
	} else {
		finErr = w.deps.Store.FinishAIJob(ctx, job.ID, status, prog, payload, errMsg)
	}
	if finErr != nil {
		log.Error("finish ai job failed", "error", finErr)
		return
	}
	log.Info("ai job finished", "status", status, "progress", prog)
}

// chunkFraction 把块数换算成进度（总数为 0 时视为完成）。
func chunkFraction(done, total int) float64 {
	if total <= 0 {
		return 1
	}
	if done >= total {
		return 1
	}
	return float64(done) / float64(total)
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
