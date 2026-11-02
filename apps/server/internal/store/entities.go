package store

import (
	"context"
	"fmt"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/corrections"
	"github.com/jackc/pgx/v5"
)

// Entity 是 book_entity 的领域映射。
type Entity struct {
	ID         string
	BookID     string
	UserID     string
	Canonical  string
	TargetName *string
	Kind       string
	Locked     bool
	FromUser   bool
	// Members 是组内归一 key，来自 book_entity_member。
	Members []EntityMember
}

// EntityMember 是一个归一 key 及其观察到的原始写法。
type EntityMember struct {
	NormKey  string
	Surfaces []string
}

// ReplaceEntities 用一次重放的结果**整体替换**某本书的实体表。
//
// 为什么是「整体替换」而不是「增量更新」：
// book_entity 存的是自动流水线的**可重算输出**，不是权威数据。
// 权威数据是 book_correction 的事件日志。
//
// 增量更新会带来一个隐蔽的 bug：重跑后自动分组变了（比如模型升级），
// 旧的实体行残留下来，用户会看到「同一个人出现两次」。
// 整体替换没有这个问题——重放结果就是全部真相。
func (s *Store) ReplaceEntities(ctx context.Context, userID, bookID string, ents []Entity) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return wrap(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM book_entity WHERE book_id = $1`, bookID); err != nil {
		return wrap(err)
	}
	for _, e := range ents {
		var entityID string
		err := tx.QueryRow(ctx, `
            INSERT INTO book_entity (book_id, user_id, canonical, target_name, kind, locked, from_user)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			bookID, userID, e.Canonical, e.TargetName, e.Kind, e.Locked, e.FromUser).Scan(&entityID)
		if err != nil {
			return wrap(err)
		}
		for _, m := range e.Members {
			surfaces := m.Surfaces
			if surfaces == nil {
				surfaces = []string{}
			}
			if _, err := tx.Exec(ctx, `
                INSERT INTO book_entity_member (entity_id, norm_key, surfaces)
                VALUES ($1, $2, $3) ON CONFLICT (entity_id, norm_key) DO NOTHING`,
				entityID, m.NormKey, surfaces); err != nil {
				return wrap(err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return wrap(err)
	}
	return nil
}

// ListEntities 读出某本书的实体分组（含成员）。
func (s *Store) ListEntities(ctx context.Context, bookID string) ([]Entity, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT id, book_id, user_id, canonical, target_name, kind, locked, from_user
        FROM book_entity WHERE book_id = $1 ORDER BY canonical`, bookID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	var out []Entity
	for rows.Next() {
		var e Entity
		if err := rows.Scan(&e.ID, &e.BookID, &e.UserID, &e.Canonical, &e.TargetName,
			&e.Kind, &e.Locked, &e.FromUser); err != nil {
			return nil, wrap(err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, wrap(err)
	}
	// 逐个补成员。N+1 查询在这里可接受：一本书的实体数通常 < 200，
	// 而且这个接口不在翻译热路径上（翻译用的是术语表，不是实体表）。
	for i := range out {
		members, err := s.listEntityMembers(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Members = members
	}
	return out, nil
}

func (s *Store) listEntityMembers(ctx context.Context, entityID string) ([]EntityMember, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT norm_key, surfaces FROM book_entity_member
        WHERE entity_id = $1 ORDER BY norm_key`, entityID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	var out []EntityMember
	for rows.Next() {
		var m EntityMember
		if err := rows.Scan(&m.NormKey, &m.Surfaces); err != nil {
			return nil, wrap(err)
		}
		out = append(out, m)
	}
	return out, wrap(rows.Err())
}

// RebuildEntities 是「重跑自动流水线 + 重放用户修正」的完整入口。
//
// 顺序（不可调换）：
//  1. 自动聚类给出基线分组
//  2. 重放 book_correction 事件（merge/split/rename/alias_add/lock）
//  3. 把 split 产生的负样本对写进 book_blocked_pair（防下次重跑回退）
//  4. 整体替换 book_entity
//
// 第 3 步是关键：不写负样本对，下次重跑时自动聚类又会把用户拆开的合回去。
func (s *Store) RebuildEntities(ctx context.Context, userID, bookID string, autoGroups [][]string) (corrections.ReplayResult, error) {
	events, err := s.ListCorrections(ctx, bookID)
	if err != nil {
		return corrections.ReplayResult{}, fmt.Errorf("list corrections: %w", err)
	}
	ce := make([]corrections.Event, 0, len(events))
	for _, ev := range events {
		ce = append(ce, corrections.Event{Seq: ev.Seq, Op: ev.Op, Payload: ev.Payload})
	}

	res, err := corrections.Replay(autoGroups, ce)
	if err != nil {
		return res, fmt.Errorf("replay: %w", err)
	}

	// 把 split 产生的负样本对落库（幂等）。
	if len(res.BlockedPairs) > 0 {
		pairs := make([]BlockedPair, 0, len(res.BlockedPairs))
		for _, bp := range res.BlockedPairs {
			pairs = append(pairs, BlockedPair{NormKeyA: bp.A, NormKeyB: bp.B})
		}
		if err := s.UpsertBlockedPairs(ctx, bookID, pairs); err != nil {
			return res, fmt.Errorf("upsert blocked pairs: %w", err)
		}
	}

	// 转成实体行并整体替换。
	ents := make([]Entity, 0, len(res.Entities))
	for _, e := range res.Entities {
		ent := Entity{
			BookID: bookID, UserID: userID,
			Canonical: e.Canonical, Kind: "person",
			Locked: e.Locked, FromUser: e.FromUser,
		}
		for _, m := range e.Members {
			ent.Members = append(ent.Members, EntityMember{NormKey: m, Surfaces: []string{m}})
		}
		ents = append(ents, ent)
	}
	if err := s.ReplaceEntities(ctx, userID, bookID, ents); err != nil {
		return res, fmt.Errorf("replace entities: %w", err)
	}
	return res, nil
}

var _ = pgx.ErrNoRows
