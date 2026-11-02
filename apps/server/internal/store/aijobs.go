package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// AIJob 是 ai_jobs 表映射。
type AIJob struct {
	ID        string
	UserID    string
	BookID    *string
	Kind      string
	Status    string
	Progress  float64
	Options   json.RawMessage
	Result    json.RawMessage
	Error     *string
	Attempts  int
	CreatedAt time.Time
	UpdatedAt time.Time
}

const aiJobColumns = `id, user_id, book_id, kind, status, progress, options, result, error, attempts, created_at, updated_at`

func scanAIJob(row pgx.Row) (AIJob, error) {
	var j AIJob
	err := row.Scan(&j.ID, &j.UserID, &j.BookID, &j.Kind, &j.Status, &j.Progress, &j.Options,
		&j.Result, &j.Error, &j.Attempts, &j.CreatedAt, &j.UpdatedAt)
	return j, wrap(err)
}

// CreateAIJob 入队一个 AI 后台任务。
//
// bookID 可以为空（例如不绑定具体书的 summarize），此时 book_id 必须写 NULL 而不是空串：
// book_id 是 uuid 列，空串会触发 SQLSTATE 22P02，冒成 500。
// 这与 F-02（非法 opId 冒 500 → 客户端无限重试）是同一类问题，只是发生在服务端内部调用上。
func (s *Store) CreateAIJob(ctx context.Context, userID, bookID, kind string, options json.RawMessage) (AIJob, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO ai_jobs (id, user_id, book_id, kind, options)
		VALUES (gen_random_uuid(), $1, NULLIF($2,'')::uuid, $3, COALESCE($4::jsonb, '{}'::jsonb))
		RETURNING `+aiJobColumns, userID, bookID, kind, jsonOrNull(options))
	return scanAIJob(row)
}

// GetAIJob 查询任务状态。
func (s *Store) GetAIJob(ctx context.Context, userID, id string) (AIJob, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+aiJobColumns+` FROM ai_jobs WHERE id = $1 AND user_id = $2`, id, userID)
	return scanAIJob(row)
}

// ListAIJobs 列出用户的任务。
func (s *Store) ListAIJobs(ctx context.Context, userID string, limit int) ([]AIJob, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+aiJobColumns+` FROM ai_jobs WHERE user_id = $1
		ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []AIJob{}
	for rows.Next() {
		j, err := scanAIJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ClaimAIJob 抢占一个待处理任务（FOR UPDATE SKIP LOCKED，多 worker 安全）。
// 返回 ErrNotFound 表示当前没有可处理任务。
func (s *Store) ClaimAIJob(ctx context.Context, workerID string) (AIJob, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE ai_jobs SET status = 'running', locked_at = now(), locked_by = $1,
		    attempts = attempts + 1, updated_at = now()
		WHERE id = (
		    SELECT id FROM ai_jobs
		    WHERE status = 'queued'
		    ORDER BY created_at
		    FOR UPDATE SKIP LOCKED
		    LIMIT 1
		)
		RETURNING `+aiJobColumns, workerID)
	return scanAIJob(row)
}

// ReclaimStaleJobs 把卡在 running 且租约超时的任务退回 queued。
//
// 为什么必须有：ClaimAIJob 只捞 status='queued'（见上），所以 worker 在任务执行中
// 崩溃 / 被 kill / 机器重启后，那条任务会**永远停在 running**——既不会被重试，
// 也不会被任何 worker 再捞到。这不是「少数情况」：任何一次部署重启都会命中。
//
// 用 locked_at 作为租约（lease）而不是 updated_at：updated_at 会被
// UpdateAIJobProgress 在每次进度推进时刷新，拿它判超时会让「正在慢慢跑的长任务」
// 被误判成卡死，从而被重复执行（整书翻译会重复烧钱）。
//
// 只退回到 queued 而不是直接 failed：任务本身没问题，只是执行它的 worker 没了。
func (s *Store) ReclaimStaleJobs(ctx context.Context, olderThan time.Duration, maxAttempts int) (int64, error) {
	if olderThan <= 0 {
		olderThan = 15 * time.Minute
	}
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE ai_jobs
		SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now()
		WHERE status = 'running'
		  AND locked_at IS NOT NULL
		  AND locked_at < now() - $1::interval
		  AND attempts < $2`, intervalSeconds(olderThan), maxAttempts)
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// intervalSeconds 把时长转成 PostgreSQL interval 可接受的字符串。
func intervalSeconds(d time.Duration) string {
	return fmt.Sprintf("%d seconds", int64(d/time.Second))
}

// FinishAIJob 结束任务（成功或失败）。
func (s *Store) FinishAIJob(ctx context.Context, id, status string, progress float64, result json.RawMessage, errMsg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE ai_jobs SET status = $2, progress = $3, result = $4, error = NULLIF($5,''),
		    locked_at = NULL, locked_by = NULL, updated_at = now()
		WHERE id = $1`, id, status, progress, jsonOrNull(result), errMsg)
	return wrap(err)
}

// RequireUser 读取用户；不存在返回 ErrNotFound。
func (s *Store) RequireUser(ctx context.Context, userID string) (User, error) {
	return s.GetUserByID(ctx, userID)
}

// UpdateAIJobProgress 只更新进度（不动状态与 result）。
//
// 单独一个方法而不是复用 FinishAIJob：整书翻译要逐块推进进度，
// 若每次都走 FinishAIJob 就会把 status 反复写回 running、把 locked_* 清空，
// 多 worker 场景下会被别的 worker 抢走。
func (s *Store) UpdateAIJobProgress(ctx context.Context, id string, progress float64) error {
	_, err := s.pool.Exec(ctx, `
        UPDATE ai_jobs SET progress = $2, updated_at = now() WHERE id = $1`, id, progress)
	return wrap(err)
}

// PauseAIJob 把任务置为 paused（可续跑），保留进度与已完成块。
//
// 与 failed 的区别是**可续跑性**：paused 表示「额度不够了，下个周期接着来」，
// 已完成的工作全部保留；failed 表示需要用户重新发起。
// 配额耗尽必须用 paused —— 用 failed 会让用户以为任务坏了，且白扔掉已付费的进度。
func (s *Store) PauseAIJob(ctx context.Context, id string, progress float64, result json.RawMessage, reason string) error {
	_, err := s.pool.Exec(ctx, `
        UPDATE ai_jobs SET status = 'paused', progress = $2, result = $4, error = NULLIF($3,''),
            locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = $1`, id, progress, reason, jsonOrNull(result))
	return wrap(err)
}
