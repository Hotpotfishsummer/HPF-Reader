package db

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrations 是内嵌的迁移文件系统。
// 迁移文件放在本包目录下（internal/db/migrations），因为 go:embed 不允许 "`..`" 路径；
// 它也充当这些迁移 SQL 的 canonical 存放位置（Dockerfile 会把它复制到 /app/migrations 供外部工具使用）。
//
//go:embed migrations/*.sql
var Migrations embed.FS

// migrationsFS 是包内使用的别名。
var migrationsFS embed.FS = Migrations

// migration 是一个待执行/已执行的迁移文件。
type migration struct {
	Name     string
	Up       string
	Checksum string
}

// Migrate 执行所有未应用的迁移。
//
// 为什么自己写而不用 goose CLI：
//  1. 迁移文件必须与镜像一起分发，不能要求运行环境再装一个 goose 二进制；
//  2. 迁移 SQL 与 go**ose 格式兼容（-- +goose Up / -- +goose Down），
//     将来要切回 goose CLI 时文件不用改；
//  3. 每个迁移在独立事务中执行，失败时该迁移整体回滚，已成功的迁移保留。
func Migrate(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    TEXT PRIMARY KEY,
			checksum   TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied, err := loadApplied(ctx, pool)
	if err != nil {
		return err
	}
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	for _, m := range migs {
		if prev, ok := applied[m.Name]; ok {
			if prev != m.Checksum {
				// 已应用的迁移被改写：这是危险信号（不同副本的 schema 会漂移）。
				logger.Warn("migration checksum changed after being applied; skipping",
					"version", m.Name, "applied", prev, "current", m.Checksum)
			}
			continue
		}
		logger.Info("applying migration", "version", m.Name)
		if err := applyOne(ctx, pool, m); err != nil {
			return fmt.Errorf("apply %s: %w", m.Name, err)
		}
		logger.Info("migration applied", "version", m.Name)
	}
	return nil
}

func applyOne(ctx context.Context, pool *pgxpool.Pool, m migration) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, m.Up); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`, m.Name, m.Checksum); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AppliedMigration 是一条已应用的迁移记录。
type AppliedMigration struct {
	Version   string
	Checksum  string
	AppliedAt time.Time
}

// AppliedMigrations 返回已应用的迁移列表（供 migrate -status 使用）。
func AppliedMigrations(ctx context.Context, pool *pgxpool.Pool) ([]AppliedMigration, error) {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		checksum   TEXT NOT NULL,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, `SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppliedMigration{}
	for rows.Next() {
		var m AppliedMigration
		if err := rows.Scan(&m.Version, &m.Checksum, &m.AppliedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func loadApplied(ctx context.Context, pool *pgxpool.Pool) (map[string]string, error) {
	rows, err := pool.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var v, c string
		if err := rows.Scan(&v, &c); err != nil {
			return nil, err
		}
		out[v] = c
	}
	return out, rows.Err()
}

// loadMigrations 读取 embed 的迁移文件，按文件名排序（00001_、00002_ …）。
func loadMigrations() ([]migration, error) {
	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("no migration files embedded")
	}
	out := make([]migration, 0, len(entries))
	for _, name := range entries {
		raw, err := migrationsFS.ReadFile(name)
		if err != nil {
			return nil, err
		}
		up, err := splitUp(string(raw))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		sum := sha256.Sum256([]byte(up))
		out = append(out, migration{
			Name:     name[strings.LastIndex(name, "/")+1:],
			Up:       up,
			Checksum: hex.EncodeToString(sum[:]),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// splitUp 从 goose 兼容的迁移文件中取出 Up 段，并剔除 goose 指令行。
func splitUp(raw string) (string, error) {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	var up []string
	inUp := false
	sawUp := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "-- +goose Up"):
			inUp = true
			sawUp = true
			continue
		case strings.HasPrefix(trimmed, "-- +goose Down"):
			inUp = false
			continue
		case strings.HasPrefix(trimmed, "-- +goose"):
			continue
		}
		if inUp {
			up = append(up, line)
		}
	}
	if !sawUp {
		return "", fmt.Errorf("missing \"-- +goose Up\" marker")
	}
	body := strings.TrimSpace(strings.Join(up, "\n"))
	if body == "" {
		return "", fmt.Errorf("empty Up section")
	}
	return body, nil
}
