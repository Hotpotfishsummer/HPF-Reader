package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/booktext"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// bookTranslateOptions 是 book_translate 任务的 options 结构。
type bookTranslateOptions struct {
	TargetLang string            `json:"targetLang"`
	SourceLang string            `json:"sourceLang,omitempty"`
	Model      string            `json:"model,omitempty"`
	Glossary   map[string]string `json:"glossary,omitempty"`
}

// translateResult 是任务完成后的 result JSON。
type translateResult struct {
	TargetLang      string            `json:"targetLang"`
	Model           string            `json:"model"`
	TotalChunks     int               `json:"totalChunks"`
	DoneChunks      int               `json:"doneChunks"`
	TranslatedChars int               `json:"translatedChars"`
	Consistency     consistencyResult `json:"consistency"`
	ReusedChunks    int               `json:"reusedChunks"`
	Paused          bool              `json:"paused,omitempty"`
}

// consistencyResult 是译后扫描的对外形态。
type consistencyResult struct {
	CheckedTerms    int                    `json:"checkedTerms"`
	ViolatingChunks int                    `json:"violatingChunks"`
	Violations      []consistencyViolation `json:"violations,omitempty"`
}

type consistencyViolation struct {
	ChunkIndex int    `json:"chunkIndex"`
	Source     string `json:"source"`
	Target     string `json:"target"`
}

// 任务级别的哨兵错误：用于把「暂停」与「取消」同真正的失败区分开。
var (
	errJobPaused   = errors.New("worker: job paused (quota exhausted)")
	errJobCanceled = errors.New("worker: job canceled by user")
)

// maxChunkAttempts 是单块最大尝试次数。
// 超过就判定整个任务失败，而不是无限重试——重试也花钱。
const maxChunkAttempts = 3

// runBookTranslate 真正执行整书翻译。
//
// 执行模型（断点续跑的全部秘密）：
//  1. 从 EPUB 抽出章节 → 切成约 6000 token 的块 → 幂等写入 book_translation_chunks；
//  2. 循环取「第一个未完成的块」，翻译它，落库；
//  3. 进程被杀 → 下次启动同样的循环会跳过已 done 的块，从断点继续；
//  4. 每块前检查配额，超限就暂停（paused）并保留全部已完成块。
func (w *Worker) runBookTranslate(ctx context.Context, job store.AIJob) (translateResult, error) {
	log := w.deps.Logger.With("job_id", job.ID, "kind", job.Kind)
	if job.BookID == nil {
		return translateResult{}, fmt.Errorf("book_translate requires bookId")
	}
	var opts bookTranslateOptions
	if len(job.Options) > 0 {
		if err := json.Unmarshal(job.Options, &opts); err != nil {
			return translateResult{}, fmt.Errorf("bad options: %w", err)
		}
	}
	if strings.TrimSpace(opts.TargetLang) == "" {
		return translateResult{}, fmt.Errorf("options.targetLang is required")
	}

	// ---- 准备块清单（幂等）----
	existing, err := w.deps.Store.ListChunks(ctx, job.ID)
	if err != nil {
		return translateResult{}, fmt.Errorf("list chunks: %w", err)
	}
	if len(existing) == 0 {
		chunks, err := w.buildChunks(ctx, job, opts)
		if err != nil {
			return translateResult{}, err
		}
		if err := w.deps.Store.EnsureChunks(ctx, chunks); err != nil {
			return translateResult{}, fmt.Errorf("ensure chunks: %w", err)
		}
		existing, err = w.deps.Store.ListChunks(ctx, job.ID)
		if err != nil {
			return translateResult{}, fmt.Errorf("reload chunks: %w", err)
		}
		log.Info("chunk plan created", "total_chunks", len(existing))
	} else {
		done := 0
		for _, c := range existing {
			if c.Status == "done" || c.Status == "skipped" {
				done++
			}
		}
		log.Info("resuming job from checkpoint", "total_chunks", len(existing), "already_done", done)
	}

	// 崩溃恢复：把残留的 running 块重置（用超时判断，避免抢健康 worker 正在跑的块）。
	if n, err := w.deps.Store.ResetStaleRunningChunks(ctx, job.ID, 5*time.Minute); err != nil {
		log.Warn("reset stale chunks failed", "error", err)
	} else if n > 0 {
		log.Info("reset stale running chunks", "count", n)
	}

	res := translateResult{
		TargetLang:  opts.TargetLang,
		Model:       w.providerName(),
		TotalChunks: len(existing),
	}
	if opts.Model != "" {
		res.Model = opts.Model
	}

	// ---- 逐块执行 ----
	for {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		// 取消语义：每块前检查任务状态，取消后不再烧钱。
		cur, err := w.deps.Store.GetAIJob(ctx, job.UserID, job.ID)
		if err != nil {
			return res, fmt.Errorf("recheck job: %w", err)
		}
		if cur.Status == "canceled" {
			log.Info("job canceled by user; stopping before next chunk")
			return res, errJobCanceled
		}

		chunk, err := w.deps.Store.NextPendingChunk(ctx, job.ID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				break
			}
			return res, fmt.Errorf("next chunk: %w", err)
		}

		// ---- 配额闸门：每块前预扣（M5-1 预留的结构）----
		reserve := int64(ai.EstimateTokens(chunk.SourceText)) +
			int64(ai.EstimateTokens(chunk.SourceText))/2
		if _, err := w.deps.Store.Reserve(ctx, job.UserID, reserve); err != nil {
			var qe *store.ErrQuotaExceeded
			if errors.As(err, &qe) {
				log.Info("quota exhausted; pausing job (resumable)",
					"dimension", qe.Dimension, "used", qe.Used, "limit", qe.Limit, "chunk", chunk.ChunkIndex)
				res.Paused = true
				res.DoneChunks = w.countDone(ctx, job.ID)
				return res, errJobPaused
			}
			return res, fmt.Errorf("reserve quota: %w", err)
		}

		if err := w.deps.Store.MarkChunkRunning(ctx, job.ID, chunk.ChunkIndex); err != nil {
			return res, fmt.Errorf("mark chunk running: %w", err)
		}

		started := time.Now()
		out, usage, trErr := w.translateChunk(ctx, chunk, opts)
		elapsed := time.Since(started)

		// 无论成功失败都结算并记账（失败也是花钱的）。
		w.settleChunk(ctx, job, chunk, reserve, usage, trErr)

		if trErr != nil {
			log.Warn("chunk translate failed", "chunk", chunk.ChunkIndex,
				"error", trErr, "elapsed", elapsed.String())
			chunk.Status = "failed"
			msg := trErr.Error()
			chunk.Error = &msg
			if err := w.deps.Store.FinishChunk(ctx, chunk); err != nil {
				log.Error("record chunk failure", "error", err)
			}
			if chunk.Attempt >= maxChunkAttempts {
				return res, fmt.Errorf("chunk %d failed after %d attempts: %w",
					chunk.ChunkIndex, chunk.Attempt, trErr)
			}
			continue
		}

		text := out
		chunk.Status = "done"
		chunk.OutputText = &text
		chunk.InputTokens = usage.InputTokens
		chunk.OutputTokens = usage.OutputTokens
		src := usage.Source
		chunk.UsageSource = &src
		chunk.Error = nil
		if err := w.deps.Store.FinishChunk(ctx, chunk); err != nil {
			return res, fmt.Errorf("finish chunk: %w", err)
		}
		res.TranslatedChars += len([]rune(text))

		// 进度回写：按真实块数算。
		done, total := w.progress(ctx, job.ID)
		if total > 0 {
			frac := float64(done) / float64(total)
			if err := w.deps.Store.UpdateAIJobProgress(ctx, job.ID, frac); err != nil {
				log.Warn("update progress failed", "error", err)
			}
		}
		log.Info("chunk done", "chunk", chunk.ChunkIndex, "of", total,
			"chars", len([]rune(text)), "elapsed", elapsed.String())
	}

	// ---- 译后确定性扫描（§A8）----
	res.DoneChunks = w.countDone(ctx, job.ID)
	res.Consistency = w.scanConsistency(ctx, job.ID, opts)
	log.Info("book translate finished",
		"total", res.TotalChunks, "done", res.DoneChunks,
		"checked_terms", res.Consistency.CheckedTerms,
		"violating_chunks", res.Consistency.ViolatingChunks)
	return res, nil
}

// buildChunks 读取书籍文件、抽取章节并切块。
func (w *Worker) buildChunks(ctx context.Context, job store.AIJob, opts bookTranslateOptions) ([]store.TranslationChunk, error) {
	book, err := w.deps.Store.GetBook(ctx, job.UserID, *job.BookID)
	if err != nil {
		return nil, fmt.Errorf("get book: %w", err)
	}
	if book.StorageKey == nil || *book.StorageKey == "" {
		return nil, fmt.Errorf("book has no uploaded file yet")
	}
	if book.Format != "epub" {
		return nil, fmt.Errorf("%w: format %q (only epub is supported for now)",
			booktext.ErrUnsupportedFormat, book.Format)
	}

	f, _, err := w.deps.Storage.Open(ctx, *book.StorageKey)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return nil, fmt.Errorf("book file missing from storage: %s", *book.StorageKey)
		}
		return nil, fmt.Errorf("open book file: %w", err)
	}
	defer func() { _ = f.Close() }()

	size, err := w.deps.Storage.Stat(ctx, *book.StorageKey)
	if err != nil {
		return nil, fmt.Errorf("stat book file: %w", err)
	}
	chapters, err := booktext.ExtractEPUB(f, size)
	if err != nil {
		return nil, fmt.Errorf("extract epub: %w", err)
	}
	chunks := booktext.ChunkChapters(chapters, ai.EstimateTokens)
	if len(chunks) == 0 {
		return nil, fmt.Errorf("book yielded no translatable text (chapters=%d)", len(chapters))
	}

	out := make([]store.TranslationChunk, 0, len(chunks))
	for _, c := range chunks {
		out = append(out, store.TranslationChunk{
			JobID:        job.ID,
			ChunkIndex:   c.Index,
			ChapterIndex: c.ChapterIndex,
			InputHash:    chunkInputHash(c, opts),
			SourceText:   c.Text,
		})
	}
	return out, nil
}

// chunkInputHash 计算块级幂等键。
//
// 参与 hash 的每一项都会影响译文内容：
//
//	原文 + 目标语言 + 源语言 + 模型 + 术语表 + prompt 版本。
//
// 任何一项变化都必须产生不同 hash，否则会复用错误的译文；
// 反之 hash 相同就一定能安全复用——这是「不重复计费」的地基。
//
// 术语表参与 hash 意味着「用户改了一个译名」会让相关块全部重译。
// 这是刻意的：术语变更后旧译文就是错的，省钱复用反而害了用户。
func chunkInputHash(c booktext.Chunk, opts bookTranslateOptions) string {
	var b strings.Builder
	b.WriteString(promptVersion)
	b.WriteString("\x00")
	b.WriteString(c.Text)
	b.WriteString("\x00")
	b.WriteString(opts.TargetLang)
	b.WriteString("\x00")
	b.WriteString(opts.SourceLang)
	b.WriteString("\x00")
	b.WriteString(opts.Model)
	b.WriteString("\x00")
	// 术语表按键排序后拼接，保证 map 迭代顺序不影响 hash。
	if len(opts.Glossary) > 0 {
		keys := make([]string, 0, len(opts.Glossary))
		for k := range opts.Glossary {
			keys = append(keys, k)
		}
		sortStrings(keys)
		for _, k := range keys {
			b.WriteString(k)
			b.WriteString("=")
			b.WriteString(opts.Glossary[k])
			b.WriteString(";")
		}
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// promptVersion 是 prompt 构造逻辑的版本号。
// 改动 BuildMessages 的措辞或结构时必须递增它，
// 否则老译文会被当成「同样的输入」而复用，用户的翻译质量不会提升。
const promptVersion = "translate-v1"

// translateChunk 翻译单个块。
func (w *Worker) translateChunk(ctx context.Context, chunk store.TranslationChunk,
	opts bookTranslateOptions) (string, ai.Usage, error) {
	if w.deps.Translator == nil {
		return "", ai.Usage{}, fmt.Errorf("no translator configured")
	}
	req := ai.TranslateRequest{
		Text:       chunk.SourceText,
		TargetLang: opts.TargetLang,
		SourceLang: opts.SourceLang,
		Glossary:   opts.Glossary,
		Model:      opts.Model,
	}
	stream, errs, usageCh, err := w.deps.Translator.TranslateStreamWithUsage(ctx, req)
	if err != nil {
		return "", ai.Usage{Source: ai.UsageSourceEstimated}, err
	}
	var b strings.Builder
	for part := range stream {
		b.WriteString(part)
	}
	streamErr := <-errs
	usage := <-usageCh
	if streamErr != nil && !errors.Is(streamErr, context.Canceled) {
		return "", usage, streamErr
	}
	return b.String(), usage, nil
}

// settleChunk 结算预扣并写 ai_usage。
//
// 记账失败只记日志：块已经处理完了，因为记账写库失败就丢掉译文属于本末倒置。
func (w *Worker) settleChunk(ctx context.Context, job store.AIJob, chunk store.TranslationChunk,
	reserved int64, usage ai.Usage, trErr error) {
	u := store.AIUsage{
		Feature:      "book_translate",
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		UsageSource:  usage.Source,
		Outcome:      "ok",
	}
	if u.UsageSource == "" {
		u.UsageSource = ai.UsageSourceEstimated
	}
	if model := w.providerName(); model != "" {
		u.Model = &model
	}
	if trErr != nil {
		u.Outcome = "failed"
		msg := trErr.Error()
		u.Error = &msg
	}
	// 用 WithoutCancel：任务 ctx 可能已取消（用户 cancel 或进程关闭），
	// 但已经花掉的钱必须记进账本。
	if _, err := w.deps.Store.Settle(context.WithoutCancel(ctx), job.UserID, reserved, u); err != nil {
		w.deps.Logger.Error("settle chunk usage failed", "error", err,
			"job_id", job.ID, "chunk", chunk.ChunkIndex)
	}
}

// countDone 统计已完成块数。
func (w *Worker) countDone(ctx context.Context, jobID string) int {
	done, _, err := w.deps.Store.ChunkProgress(context.WithoutCancel(ctx), jobID)
	if err != nil {
		return 0
	}
	return done
}

// progress 返回 (已完成, 总数)，用于进度回写。
func (w *Worker) progress(ctx context.Context, jobID string) (int, int) {
	done, total, err := w.deps.Store.ChunkProgress(ctx, jobID)
	if err != nil {
		return 0, 0
	}
	return done, total
}

// scanConsistency 做译后确定性扫描（§A8）。
//
// 纯字符串统计，不调用 LLM，因此零成本。它把「祈祷模型听话」
// 变成「可验证断言」：每个标准译名在译文里出现 0 次 = 该段忽略了术语表。
func (w *Worker) scanConsistency(ctx context.Context, jobID string, opts bookTranslateOptions) consistencyResult {
	var out consistencyResult
	if len(opts.Glossary) == 0 {
		return out // 没有术语表就没有一致性可查
	}
	chunks, err := w.deps.Store.ListChunks(ctx, jobID)
	if err != nil {
		w.deps.Logger.Warn("consistency scan: list chunks failed", "error", err)
		return out
	}
	translated := map[int]string{}
	sources := map[int]string{}
	for _, c := range chunks {
		if c.OutputText == nil {
			continue // 未完成的块不参与扫描
		}
		translated[c.ChunkIndex] = *c.OutputText
		sources[c.ChunkIndex] = c.SourceText
	}
	glossary := make([]booktext.GlossaryTerm, 0, len(opts.Glossary))
	keys := make([]string, 0, len(opts.Glossary))
	for k := range opts.Glossary {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		glossary = append(glossary, booktext.GlossaryTerm{Source: k, Target: opts.Glossary[k]})
	}
	scan := booktext.ScanTerminology(translated, sources, glossary)
	out.CheckedTerms = scan.CheckedTerms
	out.ViolatingChunks = scan.ViolatingChunks
	for _, v := range scan.Violations {
		out.Violations = append(out.Violations, consistencyViolation{
			ChunkIndex: v.ChunkIndex, Source: v.Source, Target: v.Target,
		})
	}
	return out
}

// sortStrings 是插入排序（术语表通常只有几十条，够用且无额外依赖）。
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
