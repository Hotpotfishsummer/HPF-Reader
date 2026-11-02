// Package store 是数据访问层（Repository）。
//
// 约定：
//   - 所有按用户隔离的查询都显式带 user_id（RLS 作为兜底，见 internal/db/migrations/00002_rls.sql）；
//   - 全部使用参数化查询，绝不拼接用户输入；
//   - 返回 domain struct/指针，不把 pgx.Rows 泄漏到上层。
package store

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound 表示记录不存在。
var ErrNotFound = errors.New("store: not found")

// ErrConflict 表示唯一约束冲突（例如邮箱已注册、同 hash 文件已存在）。
var ErrConflict = errors.New("store: conflict")

// Store 暴露全部数据访问方法。
type Store struct {
	pool *pgxpool.Pool
}

// New 构造 Store。
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Pool 暴露连接池（供 healthz / 事务使用）。
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23503"
	}
	return false
}

// wrap 把常见的 pg 错误翻译成领域错误。
func wrap(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, pgx.ErrNoRows):
		return ErrNotFound
	case isUniqueViolation(err):
		return fmt.Errorf("%w: %v", ErrConflict, err)
	default:
		return err
	}
}

// nullStr 把空字符串转成 SQL NULL。
func nullStr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// jsonOrNull 处理可空 JSONB。
func jsonOrNull(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

// Cursor 是 (timestamp, id) 复合游标，用于稳定的游标分页：
// 单纯按 created_at 分页在时间相同时会漏记录，必须带上 id 作为 tie-break。
type Cursor struct {
	TS time.Time `json:"ts"`
	ID string    `json:"id"`
}

// Encode 把游标编码成 URL 安全的字符串。
func (c Cursor) Encode() string {
	if c.ID == "" {
		return ""
	}
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeCursor 解析游标；空字符串返回零值游标。
func DecodeCursor(s string) (Cursor, error) {
	if strings.TrimSpace(s) == "" {
		return Cursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
	}
	var c Cursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
	}
	return c, nil
}
