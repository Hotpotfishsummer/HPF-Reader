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

// ErrDeviceTaken 表示该 deviceId 已经绑定在另一个账号下。
//
// 与 ErrConflict 区分开：同样是 409，但客户端能据此判断「换个设备 ID 或换账号」，
// 而不是以为邮箱重复。
var ErrDeviceTaken = errors.New("store: device already registered to another account")

// ErrInvalidInput 表示入参在数据库层面无法解释（例如把 "abc" 当 UUID 传进来，SQLSTATE 22P02）。
//
// 这是**客户端**问题，必须映射成 400，绝不能变成 500：
// 客户端会把 5xx 当可重试错误，于是一条永远不可能成功的请求会被无限重试。
var ErrInvalidInput = errors.New("store: invalid input")

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

// isInvalidTextRepresentation 判断是不是 PostgreSQL 的 22P02
// （invalid input syntax for type ...，典型场景：非 UUID 字符串塞进 uuid 列）。
func isInvalidTextRepresentation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "22P02"
	}
	return false
}

// isForeignKeyViolation 判断是不是 PostgreSQL 的 23503（引用了不存在的父行）。
//
// 在同步链路上，这通常意味着客户端推送的 progress/annotation 引用了一本
// 还没上传的书——这是客户端可以先修复的前置条件问题，不是服务端故障。
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
	case isInvalidTextRepresentation(err):
		// 兜底：即便某个入口漏了 UUID 校验，也只暴露成 400，而不是 500。
		return fmt.Errorf("%w: %v", ErrInvalidInput, err)
	case isForeignKeyViolation(err):
		// 引用了不存在的父行（典型：push 的 progress 指向一本还没上传的书）。
		// 同样不能是 500：客户端 5xx 会无限重试，而这里重试永远不会成功。
		return fmt.Errorf("%w: %v", ErrInvalidInput, err)
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
