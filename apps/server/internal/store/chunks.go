package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// TranslationChunk 是 book_translation_chunks 的领域映射。
type TranslationChunk struct {
	JobID        string
	ChunkIndex   int
	ChapterIndex int
	InputHash    string
	SourceText   string
	OutputText   *string
	Status       string
	InputTokens  int
	OutputTokens int
	UsageSource  *string
	Attempt      int
	Error        *string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const chunkColumns = `job_id, chunk_index, chapter_index, input_hash, source_text, output_text,
    status, input_tokens, output_tokens, usage_source, attempt, error, created_at, updated_at`

func scanChunk(row pgx.Row) (TranslationChunk, error) {
	var c TranslationChunk
	err := row.Scan(&c.JobID, &c.ChunkIndex, &c.ChapterIndex, &c.InputHash, &c.SourceText,
		&c.OutputText, &c.Status, &c.InputTokens, &c.OutputTokens, &c.UsageSource,
		&c.Attempt, &c.Error, &c.CreatedAt, &c.UpdatedAt)
	return c, wrap(err)
}

// EnsureChunks 幂等地写入一个任务的块清单。
//
// 「幂等」是关键：worker 可能在写入过程中崩溃，重启后会再写一次。
// 用 ON CONFLICT DO NOTHING 而不是 DO UPDATE：
// **已完成的块绝不能被重新写入覆盖**——那会让断点续跑失效，
// 而且会冲掉已经付过费的译文。
//
// 只有 input_hash 变化时才需要重建该块，这由调用方判断后显式调用 ResetChunk。
func (s *Store) EnsureChunks(ctx context.Context, chunks []TranslationChunk) error {
	if len(chunks) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, c := range chunks {
		batch.Queue(`
            INSERT INTO book_translation_chunks
                (job_id, chunk_index, chapter_index, input_hash, source_text, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
            ON CONFLICT (job_id, chunk_index) DO NOTHING`,
			c.JobID, c.ChunkIndex, c.ChapterIndex, c.InputHash, c.SourceText)
	}
	// SendBatch 在单个往返里执行全部 INSERT，避免上百个块各走一次网络。
	br := s.pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range chunks {
		if _, err := br.Exec(); err != nil {
			return wrap(err)
		}
	}
	return nil
}

// ListChunks 按块序号返回一个任务的全部块。
func (s *Store) ListChunks(ctx context.Context, jobID string) ([]TranslationChunk, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT `+chunkColumns+` FROM book_translation_chunks
        WHERE job_id = $1 ORDER BY chunk_index`, jobID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []TranslationChunk{}
	for rows.Next() {
		c, err := scanChunk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// NextPendingChunk 返回下一个待处理的块（断点续跑的核心查询）。
//
// 为什么用「第一个未完成的块」而不是「按序从头扫」：
// 已完成的块可能不是连续前缀（并发 worker 或部分失败），
// 按 chunk_index 找第一个非 done 的块才能既不重复计费、又不漏块。
//
// 返回 ErrNotFound 表示全部块都已完成。
func (s *Store) NextPendingChunk(ctx context.Context, jobID string) (TranslationChunk, error) {
	row := s.pool.QueryRow(ctx, `
        SELECT `+chunkColumns+` FROM book_translation_chunks
        WHERE job_id = $1 AND status IN ('pending', 'running', 'failed')
        ORDER BY chunk_index LIMIT 1`, jobID)
	return scanChunk(row)
}

// MarkChunkRunning 把块标记为进行中并累加尝试次数。
//
// 顺带把「同任务里残留的 running 块」重置为 pending：
// 进程崩溃后，那些块停在 running 状态永远不会再被选中（因为没人会来收尾）。
// 这是断点续跑必须处理的脏状态。
func (s *Store) MarkChunkRunning(ctx context.Context, jobID string, chunkIndex int) error {
	if _, err := s.pool.Exec(ctx, `
        UPDATE book_translation_chunks SET status = 'pending', updated_at = now()
        WHERE job_id = $1 AND status = 'running'`, jobID); err != nil {
		return wrap(err)
	}
	_, err := s.pool.Exec(ctx, `
        UPDATE book_translation_chunks SET status = 'running', attempt = attempt + 1, updated_at = now()
        WHERE job_id = $1 AND chunk_index = $2`, jobID, chunkIndex)
	return wrap(err)
}

// FinishChunk 写入块的最终结果。
func (s *Store) FinishChunk(ctx context.Context, c TranslationChunk) error {
	_, err := s.pool.Exec(ctx, `
        UPDATE book_translation_chunks SET
            status = $3, output_text = $4, input_tokens = $5, output_tokens = $6,
            usage_source = $7, error = NULLIF($8, ''), updated_at = now()
        WHERE job_id = $1 AND chunk_index = $2`,
		c.JobID, c.ChunkIndex, c.Status, c.OutputText, c.InputTokens, c.OutputTokens,
		c.UsageSource, derefOr(c.Error))
	return wrap(err)
}

// ChunkProgress 返回 (已完成块数, 总块数)。
//
// 进度必须由真实块数算出，而不是 worker 自己累加计数器：
// 累加器在崩溃后会归零，导致进度条倒退，用户以为任务重头开始了。
func (s *Store) ChunkProgress(ctx context.Context, jobID string) (done, total int, err error) {
	row := s.pool.QueryRow(ctx, `
        SELECT count(*) FILTER (WHERE status IN ('done', 'skipped')), count(*)
        FROM book_translation_chunks WHERE job_id = $1`, jobID)
	err = row.Scan(&done, &total)
	return done, total, wrap(err)
}

// ResetStaleRunningChunks 把长时间停在 running 的块重置为 pending。
//
// 崩溃恢复的兜底：若某个 worker 被 kill，它手上的块会一直是 running。
// 用 updated_at 超时判断而不是无条件重置，避免把另一个健康 worker 正在跑的块抢走。
func (s *Store) ResetStaleRunningChunks(ctx context.Context, jobID string, olderThan time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
        UPDATE book_translation_chunks SET status = 'pending', updated_at = now()
        WHERE job_id = $1 AND status = 'running' AND updated_at < now() - $2::interval`,
		jobID, olderThan.String())
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// derefOr 把 *string 解引用，nil 返回空串。
func derefOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// CountCorrections 统计某本书的用户修正事件数。
//
// M5-2 只读使用（骨架阶段用它证明日志表可用），M5-4 会在此基础上做全量重放。
func (s *Store) CountCorrections(ctx context.Context, bookID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
        SELECT count(*) FROM book_correction WHERE book_id = $1`, bookID).Scan(&n)
	return n, wrap(err)
}
