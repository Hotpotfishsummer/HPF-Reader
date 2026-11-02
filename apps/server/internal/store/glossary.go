package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// TermSource 是术语来源，决定优先级。
//
// 优先级不是「都一样」：**用户确认的术语重跑不得覆盖**。
// 用户手工改的译名若被自动流水线冲掉，用户会认为「我改了半天全白费了」——
// 这是比精度不够严重得多的信任问题。
type TermSource string

const (
	// TermUserConfirmed：用户手工确认，重跑不得覆盖。
	TermUserConfirmed TermSource = "user_confirmed"
	// TermLLMExtracted：LLM 抽取，可被重跑更新。
	TermLLMExtracted TermSource = "llm_extracted"
	// TermDeterministic：确定性规则产出（如繁简归一），可被更新。
	TermDeterministic TermSource = "deterministic"
)

// Valid 判断来源是否合法（与迁移的 CHECK 约束一致）。
func (t TermSource) Valid() bool {
	switch t {
	case TermUserConfirmed, TermLLMExtracted, TermDeterministic:
		return true
	}
	return false
}

// Priority 返回来源优先级：数字越大越不可覆盖。
func (t TermSource) Priority() int {
	switch t {
	case TermUserConfirmed:
		return 3
	case TermLLMExtracted:
		return 2
	default:
		return 1
	}
}

// GlossaryTerm 是一条术语。
type GlossaryTerm struct {
	// Key 是归一化后的原文键（如 "darcy"）。
	Key string
	// Display 是展示用原文写法（保留大小写与尊称）。
	Display string
	// Target 是标准译名。
	Target string
	// Aliases 是别名集合。
	Aliases []string
	// Source 是术语来源。
	Source TermSource
}

// Glossary 是一本书一份的术语表。
type Glossary struct {
	ID         string
	BookID     string
	TargetLang string
	// Version 每次变更 +1，参与译文 input_hash。
	Version   int64
	Terms     []GlossaryTerm
	UpdatedAt time.Time
}

// TermMap 返回「原文写法 → 标准译名」的映射，供翻译 prompt 使用。
//
// 用 Display（原始写法）作为键而不是归一 key：
// 送进 prompt 的术语表要让人（和模型）看得懂，
// 「darcy → 达西」不如「Mr. Darcy → 达西先生」清楚。
// 归一 key 用于内部去重，不用于 prompt。
func (g Glossary) TermMap() map[string]string {
	out := make(map[string]string, len(g.Terms))
	for _, t := range g.Terms {
		display := t.Display
		if display == "" {
			display = t.Key
		}
		out[display] = t.Target
	}
	return out
}

// GetGlossary 读取一本书某个目标语言的术语表。
//
// 不存在时返回空术语表而不是 ErrNotFound：
// 翻译流程在没有术语表时也必须能跑（术语表是增强不是前置条件）。
func (s *Store) GetGlossary(ctx context.Context, userID, bookID, targetLang string) (Glossary, error) {
	var g Glossary
	err := s.pool.QueryRow(ctx, `
        SELECT id, book_id, target_lang, version, updated_at
        FROM glossaries WHERE user_id = $1 AND book_id = $2 AND target_lang = $3`,
		userID, bookID, targetLang).
		Scan(&g.ID, &g.BookID, &g.TargetLang, &g.Version, &g.UpdatedAt)
	if err == pgx.ErrNoRows {
		return Glossary{BookID: bookID, TargetLang: targetLang, Terms: []GlossaryTerm{}}, nil
	}
	if err != nil {
		return Glossary{}, wrap(err)
	}
	terms, err := s.listGlossaryTerms(ctx, g.ID)
	if err != nil {
		return Glossary{}, err
	}
	g.Terms = terms
	return g, nil
}

func (s *Store) listGlossaryTerms(ctx context.Context, glossaryID string) ([]GlossaryTerm, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT key, display, target, aliases, source
        FROM glossary_terms WHERE glossary_id = $1 ORDER BY key`, glossaryID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	var out []GlossaryTerm
	for rows.Next() {
		var t GlossaryTerm
		if err := rows.Scan(&t.Key, &t.Display, &t.Target, &t.Aliases, &t.Source); err != nil {
			return nil, wrap(err)
		}
		out = append(out, t)
	}
	return out, wrap(rows.Err())
}

// PutGlossaryTerms 批量写入术语。
//
// **来源优先级规则**（这是本函数最重要的行为）：
//
//	已有术语是 user_confirmed，新写入是 llm_extracted/deterministic
//	  → **保留用户的值**，跳过更新
//	新写入也是 user_confirmed
//	  → 覆盖（用户后来改主意是允许的）
//
// 用 ON CONFLICT DO UPDATE ... WHERE 子句实现，单条 SQL 原子完成，
// 不需要先读再判断（那会有并发窗口）。
func (s *Store) PutGlossaryTerms(ctx context.Context, userID, bookID, targetLang string, terms []GlossaryTerm) (Glossary, error) {
	if len(terms) == 0 {
		return s.GetGlossary(ctx, userID, bookID, targetLang)
	}
	for _, t := range terms {
		if !t.Source.Valid() {
			return Glossary{}, fmt.Errorf("invalid term source %q", t.Source)
		}
		if t.Key == "" || t.Target == "" {
			return Glossary{}, fmt.Errorf("term key and target are required")
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Glossary{}, wrap(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 先确保 glossary 行存在（并发安全：唯一索引 + ON CONFLICT DO NOTHING）。
	var glossaryID string
	err = tx.QueryRow(ctx, `
        INSERT INTO glossaries (user_id, book_id, target_lang)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, book_id, target_lang) DO UPDATE
            SET updated_at = glossaries.updated_at
        RETURNING id`, userID, bookID, targetLang).Scan(&glossaryID)
	if err != nil {
		return Glossary{}, wrap(err)
	}

	batch := &pgx.Batch{}
	for _, t := range terms {
		display := t.Display
		if display == "" {
			display = t.Key
		}
		aliases := t.Aliases
		if aliases == nil {
			aliases = []string{}
		}
		// WHERE 子句是优先级闸门：只有当「已有不是用户确认」或「新值也是用户确认」时才更新。
		batch.Queue(`
            INSERT INTO glossary_terms (glossary_id, key, display, target, aliases, source)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (glossary_id, key) DO UPDATE SET
                display = EXCLUDED.display,
                target = EXCLUDED.target,
                aliases = EXCLUDED.aliases,
                source = EXCLUDED.source,
                updated_at = now()
            WHERE glossary_terms.source <> 'user_confirmed'
               OR EXCLUDED.source = 'user_confirmed'`,
			glossaryID, t.Key, display, t.Target, aliases, string(t.Source))
	}
	br := tx.SendBatch(ctx, batch)
	for range terms {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return Glossary{}, wrap(err)
		}
	}
	if err := br.Close(); err != nil {
		return Glossary{}, wrap(err)
	}

	// version 只在真的有变更时 +1。这里统一 +1：
	// 宁可多一次重译，也不能漏掉（漏掉意味着术语改了但旧译文被复用，那是错的译文）。
	if _, err := tx.Exec(ctx, `
        UPDATE glossaries SET version = version + 1, updated_at = now() WHERE id = $1`, glossaryID); err != nil {
		return Glossary{}, wrap(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Glossary{}, wrap(err)
	}
	return s.GetGlossary(ctx, userID, bookID, targetLang)
}

// DeleteGlossaryTerms 删除若干术语（按归一 key）。
func (s *Store) DeleteGlossaryTerms(ctx context.Context, userID, bookID, targetLang string, keys []string) (Glossary, error) {
	if len(keys) == 0 {
		return s.GetGlossary(ctx, userID, bookID, targetLang)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Glossary{}, wrap(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var glossaryID string
	err = tx.QueryRow(ctx, `
        SELECT id FROM glossaries WHERE user_id = $1 AND book_id = $2 AND target_lang = $3`,
		userID, bookID, targetLang).Scan(&glossaryID)
	if err == pgx.ErrNoRows {
		return Glossary{BookID: bookID, TargetLang: targetLang, Terms: []GlossaryTerm{}}, nil
	}
	if err != nil {
		return Glossary{}, wrap(err)
	}
	if _, err := tx.Exec(ctx, `
        DELETE FROM glossary_terms WHERE glossary_id = $1 AND key = ANY($2)`, glossaryID, keys); err != nil {
		return Glossary{}, wrap(err)
	}
	if _, err := tx.Exec(ctx, `
        UPDATE glossaries SET version = version + 1, updated_at = now() WHERE id = $1`, glossaryID); err != nil {
		return Glossary{}, wrap(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Glossary{}, wrap(err)
	}
	return s.GetGlossary(ctx, userID, bookID, targetLang)
}
