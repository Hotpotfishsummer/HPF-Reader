package store

import (
	"context"
	"encoding/json"
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
func (s *Store) CreateAIJob(ctx context.Context, userID, bookID, kind string, options json.RawMessage) (AIJob, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO ai_jobs (id, user_id, book_id, kind, options)
		VALUES (gen_random_uuid(), $1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
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
