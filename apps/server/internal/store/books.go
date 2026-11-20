package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Book 是 books 表 + 进度的领域映射。
type Book struct {
	ID            string
	UserID        string
	Title         string
	Author        *string
	Language      *string
	Format        string
	FileHash      *string
	FileSize      int64
	StorageKey    *string
	CoverKey      *string
	Metadata      json.RawMessage
	ReadingState  string
	Rating        *int
	Reincarnation string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	DeletedAt     *time.Time
}

// BookWithProgress 是列表/详情返回的形态。
type BookWithProgress struct {
	Book
	Progress *Progress
}

// Progress 是 reading_progress 行的领域映射。
type Progress struct {
	UserID              string
	BookID              string
	Locator             json.RawMessage
	TotalProgression    float64
	FurthestLocator     json.RawMessage
	FurthestProgression float64
	ExplicitRewind      bool
	ContentHash         *string
	HLC                 string
	DeviceID            *string
	UpdatedAt           time.Time
	SyncedAt            time.Time
}

// BookFile 是 book_files 表映射（按 content hash 全局去重）。
type BookFile struct {
	ContentHash string
	SizeBytes   int64
	StorageKey  string
	RefCount    int
	CreatedAt   time.Time
}

// BookCreateInput 是创建书籍的输入。
type BookCreateInput struct {
	UserID       string
	Title        string
	Author       *string
	Language     *string
	Format       string
	ContentHash  *string
	Series       *string
	Metadata     json.RawMessage
	ReadingState string
}

const bookColumns = `id, user_id, title, author, language, format, file_hash, file_size,
	storage_key, cover_key, metadata, reading_state, rating, reincarnation, created_at, updated_at, deleted_at`

func scanBook(row pgx.Row) (Book, error) {
	var b Book
	err := row.Scan(&b.ID, &b.UserID, &b.Title, &b.Author, &b.Language, &b.Format, &b.FileHash, &b.FileSize,
		&b.StorageKey, &b.CoverKey, &b.Metadata, &b.ReadingState, &b.Rating, &b.Reincarnation, &b.CreatedAt, &b.UpdatedAt, &b.DeletedAt)
	return b, err
}

// CreateBook 创建书籍记录。若同用户同 hash 已有有效记录，返回 ErrConflict 与已存在记录。
func (s *Store) CreateBook(ctx context.Context, in BookCreateInput) (Book, error) {
	if in.ReadingState == "" {
		in.ReadingState = "unread"
	}
	if in.Format == "" {
		in.Format = "epub"
	}
	row := s.pool.QueryRow(ctx, `
		INSERT INTO books (id, user_id, title, author, language, format, file_hash, series, metadata, reading_state, reincarnation)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb), $9, gen_random_uuid())
		RETURNING `+bookColumns,
		in.UserID, in.Title, in.Author, in.Language, in.Format, in.ContentHash, in.Series,
		jsonOrNull(in.Metadata), in.ReadingState)
	b, err := scanBook(row)
	return b, wrap(err)
}

// GetBook 按 (user_id, id) 查询未删除的书。
func (s *Store) GetBook(ctx context.Context, userID, bookID string) (Book, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+bookColumns+` FROM books
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, bookID, userID)
	b, err := scanBook(row)
	return b, wrap(err)
}

// GetBookWithProgress 查询书籍及其进度。
func (s *Store) GetBookWithProgress(ctx context.Context, userID, bookID string) (BookWithProgress, error) {
	b, err := s.GetBook(ctx, userID, bookID)
	if err != nil {
		return BookWithProgress{}, err
	}
	p, err := s.GetProgress(ctx, userID, bookID)
	if err != nil && err != ErrNotFound {
		return BookWithProgress{}, err
	}
	out := BookWithProgress{Book: b}
	if err == nil {
		out.Progress = &p
	}
	return out, nil
}

// ListBooksParams 是列表查询参数。
type ListBooksParams struct {
	UserID       string
	Limit        int
	Cursor       Cursor
	UpdatedSince *time.Time
}

// ListBooks 返回按 (created_at DESC, id DESC) 排序的一页书籍，并返回下一页游标。
//
// 用「复合游标」(created_at, id) 而不是 offset：offset 在并发插入时会漏记录 / 重复，
// 而同步场景对「不漏」有硬要求。
func (s *Store) ListBooks(ctx context.Context, p ListBooksParams) ([]BookWithProgress, string, error) {
	if p.Limit <= 0 || p.Limit > 200 {
		p.Limit = 50
	}
	args := []any{p.UserID}
	where := `user_id = $1 AND deleted_at IS NULL`
	if p.UpdatedSince != nil {
		args = append(args, *p.UpdatedSince)
		where += ` AND updated_at >= $` + itoa(len(args))
	}
	if p.Cursor.ID != "" {
		args = append(args, p.Cursor.TS, p.Cursor.ID)
		where += ` AND (created_at, id) < ($` + itoa(len(args)-1) + `, $` + itoa(len(args)) + `)`
	}
	args = append(args, p.Limit+1)
	query := `SELECT ` + bookColumns + ` FROM books WHERE ` + where +
		` ORDER BY created_at DESC, id DESC LIMIT $` + itoa(len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", wrap(err)
	}
	defer rows.Close()
	books := []Book{}
	for rows.Next() {
		b, err := scanBook(rows)
		if err != nil {
			return nil, "", err
		}
		books = append(books, b)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	next := ""
	if len(books) > p.Limit {
		books = books[:p.Limit]
		last := books[len(books)-1]
		next = Cursor{TS: last.CreatedAt, ID: last.ID}.Encode()
	}
	out := make([]BookWithProgress, 0, len(books))
	for _, b := range books {
		item := BookWithProgress{Book: b}
		if pr, err := s.GetProgress(ctx, p.UserID, b.ID); err == nil {
			item.Progress = &pr
		}
		out = append(out, item)
	}
	return out, next, nil
}

// BookPatch 是部分更新（nil 表示不修改该字段）。
type BookPatch struct {
	Title        *string
	Author       *string
	Language     *string
	ReadingState *string
	Rating       *int
	RatingSet    bool // 是否显式设置 rating（支持置空）
	Series       *string
	Metadata     json.RawMessage
}

// UpdateBook 部分更新书籍元数据。
func (s *Store) UpdateBook(ctx context.Context, userID, bookID string, patch BookPatch) (Book, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE books SET
		    title = COALESCE($3, title),
		    author = CASE WHEN $4::boolean THEN $5 ELSE author END,
		    language = CASE WHEN $6::boolean THEN $7 ELSE language END,
		    reading_state = COALESCE($8, reading_state),
		    rating = CASE WHEN $9::boolean THEN $10 ELSE rating END,
		    series = CASE WHEN $11::boolean THEN $12 ELSE series END,
		    metadata = COALESCE($13::jsonb, metadata),
		    updated_at = now()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING `+bookColumns,
		bookID, userID,
		patch.Title,
		patch.Author != nil, deref(patch.Author),
		patch.Language != nil, deref(patch.Language),
		patch.ReadingState,
		patch.RatingSet, derefInt(patch.Rating),
		patch.Series != nil, deref(patch.Series),
		jsonOrNull(patch.Metadata))
	b, err := scanBook(row)
	return b, wrap(err)
}

// SoftDeleteBook 软删除书籍（保留进度与标注，供回收站/恢复）。
func (s *Store) SoftDeleteBook(ctx context.Context, userID, bookID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE books SET deleted_at = now(), updated_at = now()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, bookID, userID)
	if err != nil {
		return wrap(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// EnsureBookFile 登记一个文件字节（按 content_hash 去重），返回登记结果与是否新建。
// 秒传的核心：命中已有 hash 时不重复写盘，只把 ref_count +1。
func (s *Store) EnsureBookFile(ctx context.Context, contentHash, storageKey string, size int64) (BookFile, bool, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO book_files (content_hash, size_bytes, storage_key, ref_count)
		VALUES ($1, $2, $3, 1)
		ON CONFLICT (content_hash) DO UPDATE SET ref_count = book_files.ref_count + 1
		RETURNING content_hash, size_bytes, storage_key, ref_count, created_at, (xmax = 0) AS inserted`,
		contentHash, size, storageKey)
	var f BookFile
	var inserted bool
	if err := row.Scan(&f.ContentHash, &f.SizeBytes, &f.StorageKey, &f.RefCount, &f.CreatedAt, &inserted); err != nil {
		return BookFile{}, false, wrap(err)
	}
	return f, inserted, nil
}

// GetBookFile 按 hash 查询文件元数据。
func (s *Store) GetBookFile(ctx context.Context, contentHash string) (BookFile, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT content_hash, size_bytes, storage_key, ref_count, created_at
		FROM book_files WHERE content_hash = $1`, contentHash)
	var f BookFile
	err := row.Scan(&f.ContentHash, &f.SizeBytes, &f.StorageKey, &f.RefCount, &f.CreatedAt)
	return f, wrap(err)
}

// BookBytesUsed 返回用户当前占用的存储字节数（按逻辑大小统计有效书籍）。
//
// 秒传（同一 hash 已被他人上传）不会新增物理字节，但用户的书架仍然「占用」
// 这份书的逻辑大小 —— 配额按逻辑大小计算，否则换个小号就能无限存书。
func (s *Store) BookBytesUsed(ctx context.Context, userID string) (int64, error) {
	var used int64
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(file_size), 0)::bigint
		FROM books
		WHERE user_id = $1 AND deleted_at IS NULL`, userID).Scan(&used)
	return used, wrap(err)
}

// AttachBookFile 把已登记的文件绑定到书籍记录。
func (s *Store) AttachBookFile(ctx context.Context, userID, bookID, contentHash string, size int64) (Book, error) {
	row := s.pool.QueryRow(ctx, `
		UPDATE books SET file_hash = $3, file_size = $4,
		    storage_key = (SELECT storage_key FROM book_files WHERE content_hash = $3),
		    updated_at = now()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING `+bookColumns, bookID, userID, contentHash, size)
	b, err := scanBook(row)
	return b, wrap(err)
}

// GetProgress 查询单本书的进度。
func (s *Store) GetProgress(ctx context.Context, userID, bookID string) (Progress, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT user_id, book_id, locator, total_progression, furthest_locator, furthest_progression,
		       explicit_rewind, content_hash, hlc, device_id, updated_at, synced_at
		FROM reading_progress WHERE user_id = $1 AND book_id = $2`, userID, bookID)
	return scanProgress(row)
}

func scanProgress(row pgx.Row) (Progress, error) {
	var p Progress
	err := row.Scan(&p.UserID, &p.BookID, &p.Locator, &p.TotalProgression, &p.FurthestLocator,
		&p.FurthestProgression, &p.ExplicitRewind, &p.ContentHash, &p.HLC, &p.DeviceID, &p.UpdatedAt, &p.SyncedAt)
	return p, wrap(err)
}

// UpsertProgress 写入/更新进度（REST 路径使用；同步路径走 sync_store.go 的事务实现）。
func (s *Store) UpsertProgress(ctx context.Context, p Progress) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO reading_progress (user_id, book_id, locator, total_progression, furthest_locator,
		    furthest_progression, explicit_rewind, content_hash, hlc, device_id, updated_at, synced_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
		ON CONFLICT (user_id, book_id) DO UPDATE SET
		    locator = EXCLUDED.locator,
		    total_progression = EXCLUDED.total_progression,
		    furthest_locator = EXCLUDED.furthest_locator,
		    furthest_progression = EXCLUDED.furthest_progression,
		    explicit_rewind = EXCLUDED.explicit_rewind,
		    content_hash = EXCLUDED.content_hash,
		    hlc = EXCLUDED.hlc,
		    device_id = EXCLUDED.device_id,
		    updated_at = now(),
		    synced_at = now()`,
		p.UserID, p.BookID, p.Locator, p.TotalProgression, jsonOrNull(p.FurthestLocator),
		p.FurthestProgression, p.ExplicitRewind, p.ContentHash, p.HLC, p.DeviceID)
	return wrap(err)
}

// WithTx 在事务中执行 fn（供需要跨多表原子写入的用例）。
func (s *Store) WithTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Pool 暴露底层连接池给需要自定义事务的调用方。
func (s *Store) DB() *pgxpool.Pool { return s.pool }

func deref(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
