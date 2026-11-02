// Package db 负责数据库连接池与迁移执行。
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect 打开连接池并做一次 ping。
func Connect(ctx context.Context, dsn string, maxConns int32, timeout time.Duration) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 15 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// WithUser 在事务内设置 RLS 会话变量 app.current_user_id，
// 使该事务的所有查询自动受租户隔离策略约束。
//
// 用法：tx, err := db.WithUser(ctx, pool, userID)；defer tx.Rollback(ctx)。
func WithUser(ctx context.Context, pool *pgxpool.Pool, userID string) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SELECT app_set_user($1::uuid)", userID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set rls user: %w", err)
	}
	return tx, nil
}
