package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// Annotation 是 annotations 表映射。
type Annotation struct {
	ID        string
	UserID    string
	BookID    string
	Kind      string
	Locator   json.RawMessage
	Color     *string
	Text      *string
	Note      *string
	Payload   json.RawMessage
	HLC       *string
	DeviceID  *string
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

const annotationColumns = `id, user_id, book_id, kind, locator, color, text, note, payload,
	hlc, device_id, created_at, updated_at, deleted_at`

func scanAnnotation(row pgx.Row) (Annotation, error) {
	var a Annotation
	err := row.Scan(&a.ID, &a.UserID, &a.BookID, &a.Kind, &a.Locator, &a.Color, &a.Text, &a.Note,
		&a.Payload, &a.HLC, &a.DeviceID, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt)
	return a, wrap(err)
}

// AnnotationInput 是创建/更新标注的输入。
type AnnotationInput struct {
	ID       string
	UserID   string
	BookID   string
	Kind     string
	Locator  json.RawMessage
	Color    *string
	Text     *string
	Note     *string
	Payload  json.RawMessage
	HLC      string
	DeviceID *string
}

// CreateAnnotation 创建标注。
func (s *Store) CreateAnnotation(ctx context.Context, in AnnotationInput) (Annotation, error) {
	if in.ID == "" {
		in.ID = "gen" // 让 SQL 生成
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO annotations (id, user_id, book_id, kind, locator, color, text, note, payload, hlc, device_id)
		VALUES (COALESCE(NULLIF($1,''), gen_random_uuid()::text)::uuid, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::jsonb, '{}'::jsonb), $10, $11)
		RETURNING `+annotationColumns,
		in.ID, in.UserID, in.BookID, in.Kind, in.Locator, in.Color, in.Text, in.Note,
		jsonOrNull(in.Payload), in.HLC, in.DeviceID)
	return scanAnnotation(row)
}

// GetAnnotation 按 ID 查询（未删除）。
func (s *Store) GetAnnotation(ctx context.Context, userID, id string) (Annotation, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+annotationColumns+` FROM annotations
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, id, userID)
	return scanAnnotation(row)
}

// ListAnnotations 列出某本书的标注（未删除，按创建时间）。
func (s *Store) ListAnnotations(ctx context.Context, userID, bookID string) ([]Annotation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+annotationColumns+` FROM annotations
		WHERE user_id = $1 AND book_id = $2 AND deleted_at IS NULL
		ORDER BY created_at, id`, userID, bookID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []Annotation{}
	for rows.Next() {
		a, err := scanAnnotation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AnnotationPatch 是部分更新（nil 表示不修改）。
type AnnotationPatch struct {
	Kind     *string
	Locator  json.RawMessage
	Color    *string
	ColorSet bool
	Text     *string
	TextSet  bool
	Note     *string
	NoteSet  bool
	HLC      string
}

// UpdateAnnotation 更新标注（字段级，含显式置空）。
func (s *Store) UpdateAnnotation(ctx context.Context, userID, id string, p AnnotationPatch) (Annotation, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE annotations SET
		    kind = COALESCE($3, kind),
		    locator = COALESCE($4::jsonb, locator),
		    color = CASE WHEN $5::boolean THEN $6 ELSE color END,
		    text  = CASE WHEN $7::boolean THEN $8 ELSE text END,
		    note  = CASE WHEN $9::boolean THEN $10 ELSE note END,
		    hlc = COALESCE(NULLIF($11,''), hlc),
		    updated_at = now()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING `+annotationColumns,
		id, userID, p.Kind, jsonOrNull(p.Locator), p.ColorSet, p.Color, p.TextSet, p.Text, p.NoteSet, p.Note, p.HLC)
	return scanAnnotation(row)
}

// SoftDeleteAnnotation 软删除标注（墓碑，供同步 remove-wins 使用）。
func (s *Store) SoftDeleteAnnotation(ctx context.Context, userID, id, hlc string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE annotations SET deleted_at = now(), updated_at = now(), hlc = COALESCE(NULLIF($3,''), hlc)
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, id, userID, hlc)
	if err != nil {
		return wrap(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
