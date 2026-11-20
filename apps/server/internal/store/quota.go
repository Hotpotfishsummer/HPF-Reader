package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- 配额闸门 ----
//
// 设计要点（为什么这样写，而不是「先 SELECT 再判断」）：
//
//  1. **单条原子 SQL**。并发场景下「先查已用量 → 判断 → 再累加」是典型的 TOCTOU 竞态：
//     10 个请求同时读到 used=2/quota=3，全部判定通过，实际写了 10 次。
//     这里把「判定」和「累加」压进同一条 UPDATE，靠行锁串行化：
//     后到的事务会等前一个提交，再基于最新值重新判定，因此不会超发。
//  2. **周期在 SQL 里原子翻转**。跨月时若「判定用旧周期、累加用新周期」就会出现账目错乱，
//     所以重置与累加必须同一条语句完成（见下面 CASE 里的 period_reset）。
//  3. **预扣 + 结算**，而不是「先调用后记账」。先调用后记账等于没有闸门：
//     并发的 N 个请求会同时穿过判定，然后才一起把额度用掉。
//     因此进流式之前先预扣一个估计值（Reserve），调用结束后用真实用量结算（Settle）。
//     这也是 M5-2 整书任务「每块处理前检查剩余额度、超了就暂停」所依赖的结构。

// ErrQuotaExceeded 表示用户本周期配额已耗尽。
//
// 携带维度信息：客户端需要知道是「调用次数」还是「token 额度」超了，
// 否则用户只知道被拒、不知道该怎么办（等重置 / 删大任务 / 升级配额）。
type ErrQuotaExceeded struct {
	Dimension string // calls | tokens
	Limit     int64
	Used      int64
	ResetAt   time.Time
	// Scope 区分「这个账号的额度」与「全站额度」：global 表示
	// 全站月度上限已耗尽（与用户自己的用量无关，换个账号也一样被拒）。
	// 空字符串等价于 "user"，以保持既有调用点不用改。
	Scope string
}

func (e *ErrQuotaExceeded) Error() string {
	scope := e.Scope
	if scope == "" {
		scope = "user"
	}
	return fmt.Sprintf("store: quota exceeded (%s/%s): used %d of %d, resets at %s",
		scope, e.Dimension, e.Used, e.Limit, e.ResetAt.UTC().Format(time.RFC3339))
}

// Is 让 errors.Is(err, ErrQuotaExceeded) 对这种指针类型也成立。
//
// 因为 ErrQuotaExceeded 是结构体而不是哨兵值（要带维度与重置时间），
// 上层用 errors.Is 判断时必须显式实现 Is，否则只能做类型断言。
func (e *ErrQuotaExceeded) Is(target error) bool {
	_, ok := target.(*ErrQuotaExceeded)
	return ok
}

// AIUsage 是一次 AI 调用的记账结果（写进 ai_usage 表）。
type AIUsage struct {
	ID           int64
	UserID       string
	Feature      string
	Model        *string
	InputTokens  int
	OutputTokens int
	CostCents    int
	UsageSource  string // upstream | estimated
	Outcome      string // ok | failed | canceled
	Error        *string
	RequestID    *string
	CreatedAt    time.Time
}

// QuotaSnapshot 是用户当前周期的配额状态（供 GET /v1/ai/usage 与 429 的 details 使用）。
type QuotaSnapshot struct {
	PeriodStart time.Time
	ResetAt     time.Time
	CallsUsed   int64
	CallsQuota  int64
	TokensUsed  int64
	TokensQuota int64
}

// CallsRemaining 返回剩余调用次数。
func (q QuotaSnapshot) CallsRemaining() int64 { return maxInt64(0, q.CallsQuota-q.CallsUsed) }

// TokensRemaining 返回剩余 token 额度。
func (q QuotaSnapshot) TokensRemaining() int64 { return maxInt64(0, q.TokensQuota-q.TokensUsed) }

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// quotaColumns 是配额状态查询的公共列清单。
const quotaColumns = `ai_period_start, ai_calls_used, ai_tokens_used, quota_ai_calls, quota_ai_tokens`

func scanQuota(row pgx.Row) (QuotaSnapshot, error) {
	var q QuotaSnapshot
	err := row.Scan(&q.PeriodStart, &q.CallsUsed, &q.TokensUsed, &q.CallsQuota, &q.TokensQuota)
	if err != nil {
		return q, wrap(err)
	}
	q.ResetAt = nextPeriodStart(q.PeriodStart)
	return q, nil
}

// nextPeriodStart 返回给定周期起点的下一个月首（= 本次额度的重置时刻）。
//
// 与 SQL 里的 ai_period_for() 保持一致：都在 UTC 边界上按自然月切分。
func nextPeriodStart(periodStart time.Time) time.Time {
	return periodStart.UTC().AddDate(0, 1, 0)
}

// GlobalQuota 是全站维度的用量快照（供 HPF_AI_GLOBAL_MONTHLY_CALLS 判定）。
type GlobalQuota struct {
	PeriodStart time.Time
	ResetAt     time.Time
	CallsUsed   int64
	CallsLimit  int64
}

// Exhausted 报告全站调用次数是否已用尽（limit <= 0 表示不限）。
func (g GlobalQuota) Exhausted() bool {
	return g.CallsLimit > 0 && g.CallsUsed >= g.CallsLimit
}

// GlobalAICalls 汇总**全站**本周期（UTC 自然月）的 AI 调用次数。
//
// 数据来源是 users.ai_calls_used 而不是 ai_usage 的行数，原因有两条：
//
//  1. **时点正确**：ai_calls_used 在 Reserve（进流式之前）就 +1，而 ai_usage
//     要等 Settle 才写入。用 ai_usage 计数等于「先花钱后记账」，
//     并发的 N 个请求会全部读到同一个旧值一起穿过闸门。
//  2. **成本低**：users 表有 (id) 主键、量级远小于 ai_usage 的流水表，
//     一次 SUM 聚合即可；ai_usage 每次调用一行，一个月可能上百万行。
//
// 只统计 ai_period_start = 当前周期的行：跨月未活动的用户还停在旧周期，
// 他们的历史计数属于上个月，必须排除，否则「新月份一开局就已经超额」。
//
// 这是**尽力而为**的闸门：它没有行锁，N 个并发请求可能同时看到「还剩 1 次」
// 而一起通过。要严格串行化需要一条独立的全局计数行（见 STATUS 里的遗留风险），
// 当前实现刻意选择「多放行几次」而不是「引入单点锁」——见调用点的说明。
func (s *Store) GlobalAICalls(ctx context.Context, limit int) (GlobalQuota, error) {
	var g GlobalQuota
	var calls int64
	err := s.pool.QueryRow(ctx, `
		SELECT ai_period_for(now()),
		       COALESCE(SUM(ai_calls_used) FILTER (WHERE ai_period_start = ai_period_for(now())), 0)
		FROM users`).Scan(&g.PeriodStart, &calls)
	if err != nil {
		return GlobalQuota{}, wrap(err)
	}
	g.CallsUsed = calls
	g.CallsLimit = int64(limit)
	g.ResetAt = nextPeriodStart(g.PeriodStart)
	return g, nil
}

// CheckGlobalAICallBudget 在**用户自己的配额判定之外**再加一道全站闸门。
//
// 存在的理由：每用户配额只约束「一个账号能花多少」。注册开放时，
// 攻击者注册 N 个账号就得到 N 份额度，账单按 N 倍增长——
// 每用户配额对「多账号绕过」完全无效。全站上限是最后一道成本闸门。
//
// limit <= 0 表示不限，此时直接返回 nil（不查库）。
func (s *Store) CheckGlobalAICallBudget(ctx context.Context, limit int) error {
	if limit <= 0 {
		return nil
	}
	g, err := s.GlobalAICalls(ctx, limit)
	if err != nil {
		return err
	}
	if !g.Exhausted() {
		return nil
	}
	return &ErrQuotaExceeded{
		Dimension: "calls",
		Limit:     g.CallsLimit,
		Used:      g.CallsUsed,
		ResetAt:   g.ResetAt,
		Scope:     "global",
	}
}

// Reserve 在**进入流式之前**原子地预扣一次调用与若干 token 额度。
//
// 这是整个闸门的关键：判定与累加在同一条 UPDATE 里完成，并发请求靠行锁串行化，
// 因此不会出现「10 个请求都读到 used=2、全部判定通过」的超发。
//
// 返回预扣后的配额快照（调用方可用它算出剩余额度）；配额不足时返回 *ErrQuotaExceeded。
//
// 两个维度都要过：任一超限即拒绝。
func (s *Store) Reserve(ctx context.Context, userID string, estimatedTokens int64) (QuotaSnapshot, error) {
	if estimatedTokens < 0 {
		estimatedTokens = 0
	}
	row := s.pool.QueryRow(ctx, `
        UPDATE users u SET
            ai_calls_used  = (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_calls_used  END) + 1,
            ai_tokens_used = (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_tokens_used END) + $2,
            ai_period_start = p.period,
            updated_at = now()
        FROM (SELECT ai_period_for(now()) AS period) p
        WHERE u.id = $1
          AND (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_calls_used END) + 1 <= u.quota_ai_calls
          AND (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_tokens_used END) + $2 <= u.quota_ai_tokens
        RETURNING `+quotaColumns, userID, estimatedTokens)
	q, err := scanQuota(row)
	if err == nil {
		return q, nil
	}
	if !errors.Is(err, ErrNotFound) {
		// 真·数据库错误：不能悄悄放行，否则闸门形同虚设。
		return QuotaSnapshot{}, err
	}
	// 没有更新到行，有两种可能：用户不存在，或配额不足。必须分清：
	// 前者是 404，后者是 429，混在一起会让客户端做出完全错误的反应。
	snap, selErr := s.GetQuota(ctx, userID)
	if selErr != nil {
		return QuotaSnapshot{}, selErr // 用户不存在 → ErrNotFound
	}
	// 重新判定，指出到底是哪个维度超了。
	if snap.CallsUsed+1 > snap.CallsQuota {
		return snap, &ErrQuotaExceeded{Dimension: "calls", Limit: snap.CallsQuota, Used: snap.CallsUsed, ResetAt: snap.ResetAt}
	}
	return snap, &ErrQuotaExceeded{Dimension: "tokens", Limit: snap.TokensQuota, Used: snap.TokensUsed, ResetAt: snap.ResetAt}
}

// GetQuota 读取用户当前周期的配额状态（跨月时返回重置后的视图，但不写库）。
//
// 刻意做成只读：查询接口不应该顺手改状态，否则「看一眼用量」就会把周期翻篇。
func (s *Store) GetQuota(ctx context.Context, userID string) (QuotaSnapshot, error) {
	row := s.pool.QueryRow(ctx, `
        SELECT CASE WHEN ai_period_start <> ai_period_for(now()) THEN ai_period_for(now()) ELSE ai_period_start END,
               CASE WHEN ai_period_start <> ai_period_for(now()) THEN 0 ELSE ai_calls_used  END,
               CASE WHEN ai_period_start <> ai_period_for(now()) THEN 0 ELSE ai_tokens_used END,
               quota_ai_calls, quota_ai_tokens
        FROM users WHERE id = $1`, userID)
	return scanQuota(row)
}

// Settle 用真实用量结算一次预扣，并写入 ai_usage 记账行。
//
// 为什么要「预扣 → 结算」而不是「事后直接累加」：预扣发生在进流式之前，是闸门的判定点；
// 而真实 token 数要等流结束才知道。若只在结束时累加，并发请求会全部穿过判定。
// 结算时把 (实际 - 预扣) 的差额补上，因此记账最终仍是精确的。
//
// 失败调用同样要结算并记账：上游可能已经计费，不记就是账目缺口。
//
// 差额可能为负（预扣多了），用 GREATEST(0, ...) 兜底，绝不让已用量变成负数
// ——负数会让后续判定全部放行，是比超发更危险的失效模式。
func (s *Store) Settle(ctx context.Context, userID string, reservedTokens int64, u AIUsage) (AIUsage, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AIUsage{}, wrap(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actual := int64(u.InputTokens + u.OutputTokens)
	if _, err := tx.Exec(ctx, `
        UPDATE users SET
            ai_tokens_used = GREATEST(0, ai_tokens_used + $2 - $3),
            updated_at = now()
        WHERE id = $1`, userID, actual, reservedTokens); err != nil {
		return AIUsage{}, wrap(err)
	}
	if err := insertAIUsage(ctx, tx, userID, &u); err != nil {
		return AIUsage{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AIUsage{}, wrap(err)
	}
	return u, nil
}

// RecordAIUsage 只记账、不碰配额（用于没有预扣路径的调用，例如后台任务的逐块记账）。
func (s *Store) RecordAIUsage(ctx context.Context, userID string, u AIUsage) (AIUsage, error) {
	if err := insertAIUsage(ctx, s.pool, userID, &u); err != nil {
		return AIUsage{}, err
	}
	return u, nil
}

// insertAIUsage 写入一行记账。
//
// 复用 auth.go 里已有的 rowQuerier（*pgxpool.Pool 与 pgx.Tx 都满足），
// 因此同一个函数既能独立执行（RecordAIUsage），也能在事务内执行（Settle）。
// 用 QueryRow 而不是 Exec，是因为需要 RETURNING 回填自增主键。
func insertAIUsage(ctx context.Context, q rowQuerier, userID string, u *AIUsage) error {
	row := q.QueryRow(ctx, `
        INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens,
                              cost_cents, usage_source, outcome, error, request_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, created_at`, userID, u.Feature, nullStrPtr(u.Model), u.InputTokens, u.OutputTokens,
		u.CostCents, u.UsageSource, u.Outcome, nullStrPtr(u.Error), nullStrPtr(u.RequestID))
	if err := row.Scan(&u.ID, &u.CreatedAt); err != nil {
		return wrap(err)
	}
	u.UserID = userID
	return nil
}

// nullStrPtr 处理可空字符串列。
func nullStrPtr(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// ListAIUsage 列出用户最近的记账行（供运维排查与 GET /v1/ai/usage 的明细）。
func (s *Store) ListAIUsage(ctx context.Context, userID string, limit int) ([]AIUsage, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
        SELECT id, user_id, feature, model, input_tokens, output_tokens, cost_cents,
               usage_source, outcome, error, request_id, created_at
        FROM ai_usage WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []AIUsage{}
	for rows.Next() {
		var u AIUsage
		if err := rows.Scan(&u.ID, &u.UserID, &u.Feature, &u.Model, &u.InputTokens, &u.OutputTokens,
			&u.CostCents, &u.UsageSource, &u.Outcome, &u.Error, &u.RequestID, &u.CreatedAt); err != nil {
			return nil, wrap(err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SumAIUsage 汇总用户本周期内的实际用量（按 feature 分组），用于成本核算。
func (s *Store) SumAIUsage(ctx context.Context, userID string, since time.Time) (map[string]UsageAggregate, error) {
	rows, err := s.pool.Query(ctx, `
        SELECT feature,
               count(*),
               COALESCE(sum(input_tokens), 0),
               COALESCE(sum(output_tokens), 0),
               COALESCE(sum(cost_cents), 0)
        FROM ai_usage WHERE user_id = $1 AND created_at >= $2
        GROUP BY feature`, userID, since)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := map[string]UsageAggregate{}
	for rows.Next() {
		var feature string
		var a UsageAggregate
		if err := rows.Scan(&feature, &a.Calls, &a.InputTokens, &a.OutputTokens, &a.CostCents); err != nil {
			return nil, wrap(err)
		}
		out[feature] = a
	}
	return out, rows.Err()
}

// UsageAggregate 是按 feature 汇总的用量。
type UsageAggregate struct {
	Calls        int64
	InputTokens  int64
	OutputTokens int64
	CostCents    int64
}

// ReleaseTokens 退回预扣的 token 额度（不退调用次数）。
//
// 使用场景：预扣成功但后续步骤失败（例如入队失败、任务被立即取消）。
// 只退 token 不退次数，是因为这次调用确实发生了：
// 退掉次数会让「高频刷必然失败的请求」绕过调用次数闸门。
//
// GREATEST(0, ...) 兜底：已用量永远不能是负数，负数会让后续判定全部放行。
func (s *Store) ReleaseTokens(ctx context.Context, userID string, tokens int64) error {
	if tokens <= 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
        UPDATE users SET ai_tokens_used = GREATEST(0, ai_tokens_used - $2), updated_at = now()
        WHERE id = $1`, userID, tokens)
	return wrap(err)
}
