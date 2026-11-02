package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/corrections"
	"github.com/jackc/pgx/v5"
)

// CorrectionEvent 是 book_correction 的一行（含审计字段）。
type CorrectionEvent struct {
	ID        string
	BookID    string
	UserID    string
	Seq       int64
	Op        corrections.Op
	Payload   json.RawMessage
	CreatedAt time.Time
}

// AppendCorrection 追加一条修正事件。
//
// **这张表永不 UPDATE / DELETE**：它是 append-only 的事件日志，
// 不是「当前状态的快照」。改状态要追加新事件，而不是改旧事件。
//
// 幂等由 (book_id, seq) 唯一约束保证：客户端重试同一条事件不会产生重复。
// 用 ON CONFLICT DO NOTHING 而不是报错——重试是正常现象，不该让用户看到失败。
func (s *Store) AppendCorrection(ctx context.Context, userID, bookID string, seq int64, op corrections.Op, payload json.RawMessage) (CorrectionEvent, error) {
	if !op.Valid() {
		return CorrectionEvent{}, fmt.Errorf("invalid correction op %q", op)
	}
	if !json.Valid(payload) {
		return CorrectionEvent{}, fmt.Errorf("payload is not valid JSON")
	}
	var ev CorrectionEvent
	err := s.pool.QueryRow(ctx, `
        INSERT INTO book_correction (id, book_id, user_id, seq, op, payload)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
        ON CONFLICT (book_id, seq) DO NOTHING
        RETURNING id, book_id, user_id, seq, op, payload, created_at`,
		bookID, userID, seq, string(op), payload).
		Scan(&ev.ID, &ev.BookID, &ev.UserID, &ev.Seq, &ev.Op, &ev.Payload, &ev.CreatedAt)
	if err == pgx.ErrNoRows {
		// 冲突（已存在同一 seq）：读回既有那条，保证调用方拿到稳定结果。
		return s.getCorrectionBySeq(ctx, bookID, seq)
	}
	if err != nil {
		return CorrectionEvent{}, wrap(err)
	}
	return ev, nil
}

func (s *Store) getCorrectionBySeq(ctx context.Context, bookID string, seq int64) (CorrectionEvent, error) {
	var ev CorrectionEvent
	err := s.pool.QueryRow(ctx, `
        SELECT id, book_id, user_id, seq, op, payload, created_at
        FROM book_correction WHERE book_id = $1 AND seq = $2`, bookID, seq).
		Scan(&ev.ID, &ev.BookID, &ev.UserID, &ev.Seq, &ev.Op, &ev.Payload, &ev.CreatedAt)
	return ev, wrap(err)
}

// ListCorrections 按 seq 升序读出某本书的全部修正事件。
//
// 必须按 seq 而不是 created_at 排序：
// 时钟回拨会让 created_at 乱序，重放顺序就错了。
func (s *Store) ListCorrections(ctx context.Context, bookID string) ([]CorrectionEvent, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT id, book_id, user_id, seq, op, payload, created_at
        FROM book_correction WHERE book_id = $1 ORDER BY seq ASC`, bookID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	var out []CorrectionEvent
	for rows.Next() {
		var ev CorrectionEvent
		if err := rows.Scan(&ev.ID, &ev.BookID, &ev.UserID, &ev.Seq, &ev.Op, &ev.Payload, &ev.CreatedAt); err != nil {
			return nil, wrap(err)
		}
		out = append(out, ev)
	}
	return out, wrap(rows.Err())
}

// NextCorrectionSeq 返回该书的下一可用 seq。
//
// 客户端通常自己生成 seq，这个函数供「服务端代生成」的场景使用
// （例如用户在服务端 UI 上操作，不需要先拉全量日志算 seq）。
func (s *Store) NextCorrectionSeq(ctx context.Context, bookID string) (int64, error) {
	var next int64
	err := s.pool.QueryRow(ctx, `
        SELECT COALESCE(MAX(seq), 0) + 1 FROM book_correction WHERE book_id = $1`, bookID).Scan(&next)
	return next, wrap(err)
}

// BlockedPair 是一对禁止合并的写法。
type BlockedPair struct {
	NormKeyA string
	NormKeyB string
}

// UpsertBlockedPairs 写入负样本对。
//
// 由 split 事件派生。独立成表而不是每次解析 JSON 日志，
// 是因为自动聚类每次都要查它——解析上百条 JSON 太慢。
func (s *Store) UpsertBlockedPairs(ctx context.Context, bookID string, pairs []BlockedPair) error {
	if len(pairs) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, pr := range pairs {
		// 规范化顺序，让 (a,b) 与 (b,a) 落到同一行（主键覆盖两个方向）。
		a, b := pr.NormKeyA, pr.NormKeyB
		if a > b {
			a, b = b, a
		}
		batch.Queue(`INSERT INTO book_blocked_pair (book_id, norm_key_a, norm_key_b)
		      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, bookID, a, b)
	}
	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range pairs {
		if _, err := br.Exec(); err != nil {
			return wrap(err)
		}
	}
	return nil
}

// ListBlockedPairs 读出某本书的全部负样本对。
func (s *Store) ListBlockedPairs(ctx context.Context, bookID string) ([]BlockedPair, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT norm_key_a, norm_key_b FROM book_blocked_pair
        WHERE book_id = $1 ORDER BY norm_key_a, norm_key_b`, bookID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	var out []BlockedPair
	for rows.Next() {
		var pr BlockedPair
		if err := rows.Scan(&pr.NormKeyA, &pr.NormKeyB); err != nil {
			return nil, wrap(err)
		}
		out = append(out, pr)
	}
	return out, wrap(rows.Err())
}
