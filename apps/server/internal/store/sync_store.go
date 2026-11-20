package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// SyncStore 是 sync.SyncStore 的 Postgres 实现。
//
// 关键语义：
//   - Push 在**同一个事务**里完成 幂等记录 + 实体状态写入 + change_log 游标分配，
//     任意一步失败整批回滚（全成或全败）；
//   - 游标由 change_log 的 BIGINT IDENTITY 分配，服务端单调递增，客户端永不参与；
//   - Pull 只读 change_log，任何「被合并过」的结果都会作为新行出现（Readest #4678 的教训）。
type SyncStore struct {
	s *Store
}

// NewSyncStore 构造同步存储适配器。
func NewSyncStore(s *Store) *SyncStore { return &SyncStore{s: s} }

// 编译期断言：确保两个包的数据结构始终兼容。
var _ syncengine.SyncStore = (*SyncStore)(nil)

func (y *SyncStore) LookupOp(ctx context.Context, userID, opID string) (syncengine.OpOutcome, bool, error) {
	var raw []byte
	var deviceID *string
	var appliedAt time.Time
	err := y.s.pool.QueryRow(ctx, `
		SELECT result, device_id, applied_at FROM sync_idempotency
		WHERE user_id = $1 AND op_id = $2 AND applied_at > now() - $3::interval`,
		userID, opID, idempotencyRetention.String()).Scan(&raw, &deviceID, &appliedAt)
	if err == pgx.ErrNoRows {
		return syncengine.OpOutcome{}, false, nil
	}
	if err != nil {
		return syncengine.OpOutcome{}, false, wrap(err)
	}
	out := syncengine.OpOutcome{OpID: opID, Status: syncengine.StatusApplied}
	if len(raw) > 0 {
		var parsed struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(raw, &parsed) == nil {
			if parsed.Status != "" {
				out.Status = syncengine.MergeStatus(parsed.Status)
			}
			out.Reason = syncengine.Reason(parsed.Reason)
		}
	}
	return out, true, nil
}

// idempotencyRetention 与设计文档一致：保留 7 天，覆盖最长离线窗口。
const idempotencyRetention = 7 * 24 * time.Hour

// LoadPending 读取实体的服务端权威状态。
func (y *SyncStore) LoadPending(ctx context.Context, userID, entity, entityID string) (syncengine.PendingState, bool, error) {
	switch entity {
	case syncengine.EntityProgress:
		return y.loadProgress(ctx, userID, entityID)
	case syncengine.EntityAnnotation:
		return y.loadAnnotation(ctx, userID, entityID)
	case syncengine.EntityBook:
		return y.loadBook(ctx, userID, entityID)
	case syncengine.EntityBookConfig:
		// 书籍级配置 / 术语表：entityId 是**任意键名**，不是 UUID，所以不能查 reading_progress。
		//
		// 缺陷背景（F-05）：这里原本无条件走 loadProgress，把 entityID 当 book_id 绑进 uuid 列。
		// 于是任何 `glossary:<bookId>:<key>` 这样的键都会触发 SQLSTATE 22P02，
		// 而 Push 循环是无条件调用 LoadPending 的——**每一批 push 都会 500**。
		// ValidateOp 已经豁免了 book_config 的 UUID 校验（见 engine.go:237），
		// 所以校验层放行了、却在存储层炸掉，这是最糟的组合：客户端看到 5xx 会无限重试。
		//
		// 权威状态直接取 change_log 里该键最新的一条：change_log.entity_id 是 TEXT，
		// 天生支持任意键名，book_config 的语义本来就只有 change_log 承载。
		return y.loadBookConfig(ctx, userID, entityID)
	default:
		return syncengine.PendingState{}, false, fmt.Errorf("unsupported entity %q", entity)
	}
}

// loadBookConfig 读取 book_config 类实体的权威状态（任意键名，不是 UUID）。
//
// 数据源是 change_log 而不是独立表：book_config 的语义就是「字段级 LWW，
// 状态由最后一次 op 决定」，而 change_log 恰好按 (user_id, entity, entity_id)
// 保存了每一次 op 及其 HLC。取最新一条即得到权威状态，无需再维护一份副本
// （维护副本就多了一致性风险，且术语表键是动态的，建表反而更麻烦）。
//
// 已删除（墓碑）的键返回 found=false：remove-wins 语义要求「删除后不复活」，
// 而 LoadPending 的 found 语义正是「当前是否有权威状态」。
func (y *SyncStore) loadBookConfig(ctx context.Context, userID, entityID string) (syncengine.PendingState, bool, error) {
	row := y.s.pool.QueryRow(ctx, `
		SELECT op, payload, hlc, device_id, server_ts, book_id
		FROM change_log
		WHERE user_id = $1 AND entity = $2 AND entity_id = $3
		ORDER BY seq DESC
		LIMIT 1`, userID, syncengine.EntityBookConfig, entityID)

	var (
		op       string
		payload  []byte
		hlc      string
		deviceID *string
		serverTS time.Time
		bookID   *string
	)
	err := row.Scan(&op, &payload, &hlc, &deviceID, &serverTS, &bookID)
	if err == pgx.ErrNoRows {
		return syncengine.PendingState{}, false, nil
	}
	if err != nil {
		return syncengine.PendingState{}, false, wrap(err)
	}
	if op == "delete" {
		// 墓碑：键已被删除，没有权威状态。
		return syncengine.PendingState{}, false, nil
	}
	return syncengine.PendingState{
		Entity:    syncengine.EntityBookConfig,
		EntityID:  entityID,
		BookID:    bookID,
		Payload:   payload,
		HLC:       hlc,
		DeviceID:  strOr(deviceID, ""),
		UpdatedAt: serverTS,
	}, true, nil
}

func (y *SyncStore) loadProgress(ctx context.Context, userID, bookID string) (syncengine.PendingState, bool, error) {
	row := y.s.pool.QueryRow(ctx, `
		SELECT locator, total_progression, furthest_locator, furthest_progression,
		       explicit_rewind, content_hash, hlc, device_id, updated_at
		FROM reading_progress WHERE user_id = $1 AND book_id = $2`, userID, bookID)
	var (
		locator, furthest []byte
		total, furthestP  float64
		rewind            bool
		contentHash       *string
		hlc               string
		deviceID          *string
		updatedAt         time.Time
	)
	err := row.Scan(&locator, &total, &furthest, &furthestP, &rewind, &contentHash, &hlc, &deviceID, &updatedAt)
	if err == pgx.ErrNoRows {
		return syncengine.PendingState{}, false, nil
	}
	if err != nil {
		return syncengine.PendingState{}, false, wrap(err)
	}
	bk := bookID
	st := syncengine.PendingState{
		Entity:    syncengine.EntityProgress,
		EntityID:  bookID,
		BookID:    &bk,
		Payload:   locator,
		HLC:       hlc,
		DeviceID:  strOr(deviceID, ""),
		UpdatedAt: updatedAt,
		Progress: &syncengine.ProgressState{
			ContentHash:         strOr(contentHash, ""),
			Locator:             json.RawMessage(locator),
			TotalProgression:    total,
			FurthestLocator:     json.RawMessage(furthest),
			FurthestProgression: furthestP,
			ExplicitRewind:      rewind,
			HLC:                 hlc,
			DeviceID:            strOr(deviceID, ""),
		},
	}
	return st, true, nil
}

func (y *SyncStore) loadAnnotation(ctx context.Context, userID, annID string) (syncengine.PendingState, bool, error) {
	row := y.s.pool.QueryRow(ctx, `
		SELECT book_id, payload, COALESCE(hlc, ''), device_id, updated_at, deleted_at
		FROM annotations WHERE user_id = $1 AND id = $2`, userID, annID)
	var (
		bookID    string
		payload   []byte
		hlc       string
		deviceID  *string
		updatedAt time.Time
		deletedAt *time.Time
	)
	err := row.Scan(&bookID, &payload, &hlc, &deviceID, &updatedAt, &deletedAt)
	if err == pgx.ErrNoRows {
		return syncengine.PendingState{}, false, nil
	}
	if err != nil {
		return syncengine.PendingState{}, false, wrap(err)
	}
	st := syncengine.PendingState{
		Entity:    syncengine.EntityAnnotation,
		EntityID:  annID,
		BookID:    &bookID,
		Payload:   payload,
		HLC:       hlc,
		DeviceID:  strOr(deviceID, ""),
		UpdatedAt: updatedAt,
	}
	if deletedAt != nil {
		st.Deleted = true
		st.DeletedHLC = hlc
		st.DeletedNanos = deletedAt.UnixNano()
	}
	return st, true, nil
}

func (y *SyncStore) loadBook(ctx context.Context, userID, bookID string) (syncengine.PendingState, bool, error) {
	row := y.s.pool.QueryRow(ctx, `
		SELECT title, author, language, format, file_hash, metadata, reading_state, rating, updated_at, deleted_at
		FROM books WHERE user_id = $1 AND id = $2`, userID, bookID)
	var (
		title        string
		author, lang *string
		format       string
		fileHash     *string
		metadata     []byte
		readingState string
		rating       *int
		updatedAt    time.Time
		deletedAt    *time.Time
	)
	err := row.Scan(&title, &author, &lang, &format, &fileHash, &metadata, &readingState, &rating, &updatedAt, &deletedAt)
	if err == pgx.ErrNoRows {
		return syncengine.PendingState{}, false, nil
	}
	if err != nil {
		return syncengine.PendingState{}, false, wrap(err)
	}
	payload, _ := json.Marshal(bookPayload{
		Title: title, Author: author, Language: lang, Format: format,
		ContentHash: fileHash, Metadata: json.RawMessage(metadata), ReadingState: readingState, Rating: rating,
	})
	bk := bookID
	st := syncengine.PendingState{
		Entity:    syncengine.EntityBook,
		EntityID:  bookID,
		BookID:    &bk,
		Payload:   payload,
		UpdatedAt: updatedAt,
		// 书籍元数据没有客户端 HLC（REST 路径直接改库），用本地时间构造一个可比较的伪 HLC，
		// 保证「客户端 push 的更新」在语义上晚于当前服务端值（见 loadBookHLC 注释）。
		HLC:      pseudoHLC(updatedAt),
		DeviceID: "",
	}
	if deletedAt != nil {
		st.Deleted = true
		st.DeletedHLC = st.HLC
		st.DeletedNanos = deletedAt.UnixNano()
	}
	return st, true, nil
}

// bookPayload 是 book 实体在同步层的中性表示。
type bookPayload struct {
	Title        string          `json:"title"`
	Author       *string         `json:"author,omitempty"`
	Language     *string         `json:"language,omitempty"`
	Format       string          `json:"format"`
	ContentHash  *string         `json:"contentHash,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
	ReadingState string          `json:"readingState,omitempty"`
	Rating       *int            `json:"rating,omitempty"`
}

// pseudoHLC 把服务端时间编码成 HLC 形态，用于没有客户端 HLC 的服务端行。
// 设备段固定为 8 个 0：它只会与客户端真实 HLC 比较，不会与另一台服务端比较。
func pseudoHLC(t time.Time) string {
	return fmt.Sprintf("%013x-%08x-00000000", uint64(t.UnixMilli()), 0)
}

// Push 在一个事务内应用一批变更。
func (y *SyncStore) Push(ctx context.Context, userID, deviceID string, ops []syncengine.StoreOp, idem []syncengine.IdempotencyRecord) (int64, error) {
	var maxSeq int64
	err := y.s.WithTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT app_set_user($1::uuid)`, userID); err != nil {
			return fmt.Errorf("set rls user: %w", err)
		}
		for _, rec := range idem {
			if _, err := tx.Exec(ctx, `
				INSERT INTO sync_idempotency (op_id, user_id, device_id, result)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (user_id, op_id) DO NOTHING`,
				rec.OpID, userID, nullUUID(rec.DeviceID), jsonOrNull(rec.Result)); err != nil {
				return fmt.Errorf("write idempotency %s: %w", rec.OpID, err)
			}
		}
		for _, op := range ops {
			if err := applyEntity(ctx, tx, userID, deviceID, op); err != nil {
				return err
			}
			var seq int64
			if err := tx.QueryRow(ctx, `
				INSERT INTO change_log (user_id, entity, entity_id, book_id, op, payload, hlc, device_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				RETURNING seq`,
				userID, op.Entity, op.EntityID, op.BookID, op.Kind,
				jsonOrNull(op.Payload), op.HLC, nullUUID(deviceID)).Scan(&seq); err != nil {
				return fmt.Errorf("append change_log: %w", err)
			}
			if seq > maxSeq {
				maxSeq = seq
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if maxSeq == 0 {
		if err := y.s.pool.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM change_log WHERE user_id = $1`, userID).Scan(&maxSeq); err != nil {
			return 0, wrap(err)
		}
	}
	return maxSeq, nil
}

// applyEntity 把一条裁决为 applied 的变更写入实体表。
func applyEntity(ctx context.Context, tx pgx.Tx, userID, deviceID string, op syncengine.StoreOp) error {
	dev := nullUUID(deviceID)
	switch op.Entity {
	case syncengine.EntityProgress:
		if op.Kind == syncengine.KindDelete {
			_, err := tx.Exec(ctx, `
				DELETE FROM reading_progress WHERE user_id = $1 AND book_id = $2`, userID, op.EntityID)
			return wrap(err)
		}
		p, err := syncengine.ParseProgressPayload(op.Payload)
		if err != nil {
			return fmt.Errorf("parse progress payload: %w", err)
		}
		// 服务端权威结果按「客户端单条 op = 客户端权威载荷」覆盖；
		// furthest 的单调性由引擎裁决，此处只需保证不倒退。
		_, err = tx.Exec(ctx, `
			INSERT INTO reading_progress (user_id, book_id, locator, total_progression, furthest_locator,
			    furthest_progression, explicit_rewind, content_hash, hlc, device_id, updated_at, synced_at)
			VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, COALESCE($5::jsonb, $3::jsonb), $6, $7, $8, $9, $10, now(), now())
			ON CONFLICT (user_id, book_id) DO UPDATE SET
			    locator = EXCLUDED.locator,
			    total_progression = EXCLUDED.total_progression,
			    furthest_locator = CASE
			        WHEN EXCLUDED.furthest_progression >= reading_progress.furthest_progression
			        THEN EXCLUDED.furthest_locator ELSE reading_progress.furthest_locator END,
			    furthest_progression = GREATEST(EXCLUDED.furthest_progression, reading_progress.furthest_progression),
			    explicit_rewind = EXCLUDED.explicit_rewind,
			    content_hash = EXCLUDED.content_hash,
			    hlc = EXCLUDED.hlc,
			    device_id = EXCLUDED.device_id,
			    updated_at = now(),
			    synced_at = now()`,
			userID, op.EntityID, jsonOrNull(p.Locator), p.TotalProgression,
			jsonOrNull(p.FurthestLocator), maxF(p.FurthestProgression, p.TotalProgression),
			p.ExplicitRewind, nullStr(p.ContentHash), op.HLC, dev)
		return wrap(err)

	case syncengine.EntityAnnotation:
		if op.Kind == syncengine.KindDelete {
			_, err := tx.Exec(ctx, `
				INSERT INTO annotations (id, user_id, book_id, kind, locator, payload, hlc, device_id, deleted_at)
				VALUES ($1, $2, $3, 'highlight', '{}'::jsonb, '{}'::jsonb, $4, $5, now())
				ON CONFLICT (id) DO UPDATE SET deleted_at = now(), hlc = EXCLUDED.hlc, device_id = EXCLUDED.device_id, updated_at = now()`,
				op.EntityID, userID, bookIDOrNil(op.BookID), op.HLC, dev)
			return wrap(err)
		}
		payload := op.Payload
		if len(payload) == 0 {
			payload = []byte(`{}`)
		}
		kind := payloadString(payload, "type", "highlight")
		_, err := tx.Exec(ctx, `
			INSERT INTO annotations (id, user_id, book_id, kind, locator, color, text, note, payload, hlc, device_id, updated_at)
			VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, $7, $8, $9, $10, $11, now())
			ON CONFLICT (id) DO UPDATE SET
			    kind = EXCLUDED.kind,
			    locator = EXCLUDED.locator,
			    color = EXCLUDED.color,
			    text = EXCLUDED.text,
			    note = EXCLUDED.note,
			    payload = EXCLUDED.payload,
			    deleted_at = NULL,
			    hlc = EXCLUDED.hlc,
			    device_id = EXCLUDED.device_id,
			    updated_at = now()`,
			op.EntityID, userID, bookIDOrNil(op.BookID), kind,
			jsonOrNull(payloadRaw(payload, "locator")), nullableString(payload, "color"),
			nullableString(payload, "text"), nullableString(payload, "note"),
			payload, op.HLC, dev)
		return wrap(err)

	case syncengine.EntityBook:
		if op.Kind == syncengine.KindDelete {
			_, err := tx.Exec(ctx, `
				UPDATE books SET deleted_at = now(), updated_at = now()
				WHERE id = $1 AND user_id = $2`, op.EntityID, userID)
			return wrap(err)
		}
		var bp bookPayload
		if err := json.Unmarshal(op.Payload, &bp); err != nil {
			return fmt.Errorf("parse book payload: %w", err)
		}
		_, err := tx.Exec(ctx, `
			UPDATE books SET
			    title = COALESCE(NULLIF($3, ''), title),
			    reading_state = COALESCE(NULLIF($4, ''), reading_state),
			    rating = COALESCE($5, rating),
			    metadata = COALESCE($6::jsonb, metadata),
			    updated_at = now()
			WHERE id = $1 AND user_id = $2`,
			op.EntityID, userID, bp.Title, bp.ReadingState, bp.Rating, jsonOrNull(bp.Metadata))
		return wrap(err)

	case syncengine.EntityBookConfig:
		// book_config / 术语表**没有独立表**，权威状态就是 change_log 本身
		// （upsert 与 delete 都已写进 change_log，见 AppendChange）。
		//
		// 缺陷背景（F-06）：这里原本和 EntityBook 合并成一个分支，delete 时执行
		//   UPDATE books WHERE id = $1
		// 而 book_config 的 entityId 是任意键名（如 glossary:<bookId>:<key>），
		// 于是删一个术语表条目会触发 SQLSTATE 22P02 —— 和 F-05 是同一类错误，
		// 只是发生在写入路径而不是读取路径。
		//
		// 必须与 EntityBook 拆开：两者 entityId 的类型语义根本不同。
		return nil
	}
	return fmt.Errorf("unsupported entity %q", op.Entity)
}

// Pull 拉取 cursor 之后的变更。
func (y *SyncStore) Pull(ctx context.Context, userID string, cursor int64, limit int) ([]syncengine.Change, error) {
	rows, err := y.s.pool.Query(ctx, `
		SELECT seq, entity, entity_id, book_id, op, COALESCE(payload, '{}'::jsonb), hlc, COALESCE(device_id::text, '')
		FROM change_log
		WHERE user_id = $1 AND seq > $2
		ORDER BY seq ASC
		LIMIT $3`, userID, cursor, limit)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []syncengine.Change{}
	for rows.Next() {
		var c syncengine.Change
		var bookID *string
		if err := rows.Scan(&c.Cursor, &c.Entity, &c.EntityID, &bookID, &c.Kind, &c.Payload, &c.HLC, &c.DeviceID); err != nil {
			return nil, err
		}
		c.BookID = bookID
		out = append(out, c)
	}
	return out, rows.Err()
}

// MaxCursor 返回该用户 change_log 的最大游标。
func (y *SyncStore) MaxCursor(ctx context.Context, userID string) (int64, error) {
	var maxSeq int64
	err := y.s.pool.QueryRow(ctx, `
		SELECT COALESCE(MAX(seq), 0) FROM change_log WHERE user_id = $1`, userID).Scan(&maxSeq)
	return maxSeq, wrap(err)
}

// Snapshot 返回新设备首同步需要的全量投影。
func (y *SyncStore) Snapshot(ctx context.Context, userID string) (syncengine.Projection, error) {
	proj := syncengine.Projection{}

	bookRows, err := y.s.pool.Query(ctx, `
		SELECT id, title, author, language, format, file_hash, metadata, reading_state, rating
		FROM books WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id`, userID)
	if err != nil {
		return proj, wrap(err)
	}
	for bookRows.Next() {
		var (
			id, title, format, readingState string
			author, lang, fileHash          *string
			metadata                        []byte
			rating                          *int
		)
		if err := bookRows.Scan(&id, &title, &author, &lang, &format, &fileHash, &metadata, &readingState, &rating); err != nil {
			bookRows.Close()
			return proj, err
		}
		b, _ := json.Marshal(map[string]any{
			"id": id, "title": title, "author": author, "language": lang, "format": format,
			"contentHash": fileHash, "metadata": json.RawMessage(metadata), "readingState": readingState, "rating": rating,
		})
		proj.Books = append(proj.Books, b)
	}
	bookRows.Close()
	if err := bookRows.Err(); err != nil {
		return proj, err
	}

	progRows, err := y.s.pool.Query(ctx, `
		SELECT p.book_id, p.locator, p.total_progression, p.furthest_locator, p.furthest_progression,
		       p.explicit_rewind, p.content_hash, p.hlc, COALESCE(p.device_id::text, ''), p.updated_at
		FROM reading_progress p
		JOIN books b ON b.id = p.book_id AND b.deleted_at IS NULL
		WHERE p.user_id = $1`, userID)
	if err != nil {
		return proj, wrap(err)
	}
	for progRows.Next() {
		var (
			bookID, hlc, deviceID string
			locator, furthest     []byte
			total, furthestP      float64
			rewind                bool
			contentHash           *string
			updatedAt             time.Time
		)
		if err := progRows.Scan(&bookID, &locator, &total, &furthest, &furthestP, &rewind, &contentHash, &hlc, &deviceID, &updatedAt); err != nil {
			progRows.Close()
			return proj, err
		}
		b, _ := json.Marshal(map[string]any{
			"bookId": bookID, "locator": json.RawMessage(locator), "totalProgression": total,
			"furthestLocator": json.RawMessage(furthest), "furthestProgression": furthestP,
			"explicitRewind": rewind, "contentHash": contentHash, "hlc": hlc,
			"deviceId": deviceID, "updatedAt": updatedAt,
		})
		proj.Progress = append(proj.Progress, b)
	}
	progRows.Close()
	if err := progRows.Err(); err != nil {
		return proj, err
	}

	// ★ 快照里的标注必须是**自带身份**的完整对象：
	//   annotations 表的 payload 列存的是客户端上行载荷（{type,locator,text,note,bookId}），
	//   **不含 id**（id 在表主键 / op 的 entityId 上）。直接把 payload 当作标注对象返回，
	//   客户端 applySnapshot 就会写出 annotations[undefined] 这一条幽灵记录 ——
	//   新设备首同步时"服务端明明有标注，本机却按 id 查不到"。
	//   这里用 jsonb 拼接把权威列补进去（右侧同级键覆盖左侧），并补上时间戳，
	//   使快照与 /sync/pull 的载荷结构一致。
	annRows, err := y.s.pool.Query(ctx, `
		SELECT COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
			'id', id,
			'bookId', book_id,
			'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		) FROM annotations
		WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, userID)
	if err != nil {
		return proj, wrap(err)
	}
	for annRows.Next() {
		var payload []byte
		if err := annRows.Scan(&payload); err != nil {
			annRows.Close()
			return proj, err
		}
		proj.Annotations = append(proj.Annotations, payload)
	}
	annRows.Close()
	return proj, annRows.Err()
}

// AppendServerChange 追加一条**服务端发起**的变更（REST 创建的标注等）。
//
// 与客户端 push 走同一条路径：同一事务里 apply 实体 + 分配游标写 change_log。
// 这样保证「游标只由服务端分配」这条铁律在两条路径上都成立，
// 其它设备一定能拉到服务端自己做的修改。
func (y *SyncStore) AppendServerChange(ctx context.Context, userID string, op syncengine.StoreOp) (int64, error) {
	op.DeviceID = ""
	return y.Push(ctx, userID, "", []syncengine.StoreOp{op}, nil)
}

// PurgeIdempotency 清理超过保留窗口的幂等记录（由后台任务调用）。
func (y *SyncStore) PurgeIdempotency(ctx context.Context, retention time.Duration) (int64, error) {
	tag, err := y.s.pool.Exec(ctx, `
		DELETE FROM sync_idempotency WHERE applied_at < now() - $1::interval`, retention.String())
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// ---------- 小工具 ----------

func strOr(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

func nullUUID(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func bookIDOrNil(p *string) any {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

func maxF(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// payloadRaw 取出 payload 中的某个对象字段（用于定位 locator）。
func payloadRaw(payload []byte, key string) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil
	}
	v, ok := m[key]
	if !ok || len(v) == 0 || string(v) == "null" {
		return nil
	}
	return v
}

func payloadString(payload []byte, key, def string) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return def
	}
	v, ok := m[key]
	if !ok {
		return def
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil || s == "" {
		return def
	}
	return s
}

func nullableString(payload []byte, key string) *string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil
	}
	v, ok := m[key]
	if !ok || string(v) == "null" {
		return nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return nil
	}
	return &s
}
