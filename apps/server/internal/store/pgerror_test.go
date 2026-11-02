package store

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// pgxErrNoRows 返回 pgx 的「无行」错误，用于验证错误翻译。
func pgxErrNoRows() error { return pgx.ErrNoRows }

// pgError 构造一个指定 SQLSTATE 的 *pgconn.PgError。
func pgError(code string) error {
	return &pgconn.PgError{Code: code, Message: "test error " + code}
}

var _ = errors.New
