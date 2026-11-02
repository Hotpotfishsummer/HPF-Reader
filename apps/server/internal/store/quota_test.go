package store

// 配额闸门的真实数据库测试（不是 mock）。
//
// 这些用例必须连真实 PostgreSQL 才有意义：
//   * 「并发不超发」依赖 Postgres 的行锁语义，mock 断言不出来；
//   * 「跨月重置」依赖 SQL 里的 CASE 与 ai_period_for()，mock 同样测不到。
// 未设置 HPF_TEST_DATABASE_URL 时整体 skip，保证 CI 默认路径（无 DB）仍然全绿。

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
)

// quotaTestStore 连接测试库并清空数据。
//
// 注意：每个测试自建独立用户，因此可以指向共享测试库而不会互相干扰。
// 与 register_account_test.go 里的 testStore 共用同一个连接助手，但独立命名避免重复定义。
func quotaTestStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("HPF_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("HPF_TEST_DATABASE_URL not set; skipping database-backed test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	// 不 TRUNCATE：每个测试自建独立用户，靠 user_id 隔离。
	//
	// 之前的版本用 `TRUNCATE users CASCADE` + advisory lock 串行化，
	// 但锁挂在池连接上、连接归还后锁仍在别的会话里，跨包并行时依然踩踏，
	// 表现为「单独跑绿、全量跑红」的间歇性失败。
	// 隔离到用户级别后，两个包的 DB 测试可以真正并行，也不需要任何锁。
	return New(pool)
}

// newQuotaUser 建一个用户并按需设置配额。
func newQuotaUser(t *testing.T, s *Store, calls, tokens int64) string {
	t.Helper()
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "quota-"+idgen.NewUUID()+"@example.com", "hash", "")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, "UPDATE users SET quota_ai_calls = $2, quota_ai_tokens = $3 WHERE id = $1",
		u.ID, calls, tokens); err != nil {
		t.Fatalf("set quota: %v", err)
	}
	return u.ID
}

// TestReserveRejectsWhenCallsExhausted 验证次数维度耗尽后返回带维度的错误。
func TestReserveRejectsWhenCallsExhausted(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 2, 1000000)

	for i := 0; i < 2; i++ {
		if _, err := s.Reserve(ctx, userID, 100); err != nil {
			t.Fatalf("reserve %d should succeed: %v", i+1, err)
		}
	}
	_, err := s.Reserve(ctx, userID, 100)
	var qe *ErrQuotaExceeded
	if !errors.As(err, &qe) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if qe.Dimension != "calls" {
		t.Fatalf("want dimension=calls, got %q", qe.Dimension)
	}
	if qe.Limit != 2 {
		t.Fatalf("want limit=2, got %d", qe.Limit)
	}
	if qe.ResetAt.Before(time.Now()) {
		t.Fatalf("resetAt should be in the future, got %v", qe.ResetAt)
	}
}

// TestReserveRejectsWhenTokensExhausted 验证 token 维度耗尽（次数还够也不行）。
func TestReserveRejectsWhenTokensExhausted(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 1000, 500)

	if _, err := s.Reserve(ctx, userID, 400); err != nil {
		t.Fatalf("first reserve should succeed: %v", err)
	}
	_, err := s.Reserve(ctx, userID, 400)
	var qe *ErrQuotaExceeded
	if !errors.As(err, &qe) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if qe.Dimension != "tokens" {
		t.Fatalf("want dimension=tokens, got %q", qe.Dimension)
	}
}

// TestReserveConcurrentDoesNotOverIssue 是并发不超发的核心用例。
//
// 10 个 goroutine 同时抢 3 个名额：必须恰好 3 个成功。
// 如果实现改成「先 SELECT 再 UPDATE」，这个用例会稳定失败（10 个都读到 used=0）。
func TestReserveConcurrentDoesNotOverIssue(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 3, 1000000)

	const goroutines = 10
	var okCount, rejectedCount int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Reserve(ctx, userID, 100)
			var qe *ErrQuotaExceeded
			switch {
			case err == nil:
				atomic.AddInt32(&okCount, 1)
			case errors.As(err, &qe):
				atomic.AddInt32(&rejectedCount, 1)
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if okCount != 3 {
		t.Fatalf("want exactly 3 successful reservations, got %d (rejected %d)", okCount, rejectedCount)
	}
	if rejectedCount != 7 {
		t.Fatalf("want exactly 7 rejections, got %d", rejectedCount)
	}
	snap, err := s.GetQuota(ctx, userID)
	if err != nil {
		t.Fatalf("get quota: %v", err)
	}
	if snap.CallsUsed != 3 {
		t.Fatalf("want calls_used=3 in db, got %d", snap.CallsUsed)
	}
}

// TestSettleAdjustsReservationToActualUsage 验证「预扣 → 用真实用量结算」的差额被正确补齐。
//
// 这是预扣制能成立的关键：预扣只是闸门判定，最终账目必须精确。
func TestSettleAdjustsReservationToActualUsage(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 10, 1000000)

	const reserved = int64(1000)
	if _, err := s.Reserve(ctx, userID, reserved); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	model := "deepseek-chat"
	usage, err := s.Settle(ctx, userID, reserved, AIUsage{
		Feature:      "translate",
		Model:        &model,
		InputTokens:  300,
		OutputTokens: 200,
		UsageSource:  "estimated",
		Outcome:      "ok",
	})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if usage.ID == 0 {
		t.Fatalf("settled usage should have a generated id")
	}
	snap, err := s.GetQuota(ctx, userID)
	if err != nil {
		t.Fatalf("get quota: %v", err)
	}
	if snap.TokensUsed != 500 {
		t.Fatalf("want tokens_used=500 (actual), got %d", snap.TokensUsed)
	}
	if snap.CallsUsed != 1 {
		t.Fatalf("want calls_used=1, got %d", snap.CallsUsed)
	}
}

// TestSettleFailureStillRecordsUsage 验证失败调用也记账。
//
// 失败也是花钱的：上游可能已经生成并计费了部分 token。不记就是账目缺口。
func TestSettleFailureStillRecordsUsage(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 10, 1000000)

	if _, err := s.Reserve(ctx, userID, 500); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	errMsg := "upstream status 500: internal error"
	if _, err := s.Settle(ctx, userID, 500, AIUsage{
		Feature:      "translate",
		InputTokens:  400,
		OutputTokens: 0,
		UsageSource:  "estimated",
		Outcome:      "failed",
		Error:        &errMsg,
	}); err != nil {
		t.Fatalf("settle failed call: %v", err)
	}

	rows, err := s.ListAIUsage(ctx, userID, 10)
	if err != nil {
		t.Fatalf("list usage: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 usage row for failed call, got %d", len(rows))
	}
	if rows[0].Outcome != "failed" {
		t.Fatalf("want outcome=failed, got %q", rows[0].Outcome)
	}
	if rows[0].Error == nil || *rows[0].Error == "" {
		t.Fatalf("failed call should record an error message")
	}
	if rows[0].InputTokens != 400 {
		t.Fatalf("want input_tokens=400 recorded even on failure, got %d", rows[0].InputTokens)
	}
}

// TestUsageSourceIsPersisted 验证 usage_source 被如实存下来（不假装精确）。
func TestUsageSourceIsPersisted(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 10, 1000000)

	if _, err := s.RecordAIUsage(ctx, userID, AIUsage{
		Feature: "translate", InputTokens: 10, OutputTokens: 5,
		UsageSource: "upstream", Outcome: "ok",
	}); err != nil {
		t.Fatalf("record: %v", err)
	}
	rows, err := s.ListAIUsage(ctx, userID, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if rows[0].UsageSource != "upstream" {
		t.Fatalf("want usage_source=upstream, got %q", rows[0].UsageSource)
	}
}

// TestPeriodRolloverResetsUsage 验证跨月自动重置。
//
// 把周期起点回拨一个月，下一次 Reserve 应当把已用量清零后重新计数。
func TestPeriodRolloverResetsUsage(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 5, 1000000)

	for i := 0; i < 5; i++ {
		if _, err := s.Reserve(ctx, userID, 100); err != nil {
			t.Fatalf("reserve %d: %v", i+1, err)
		}
	}
	if _, err := s.Reserve(ctx, userID, 100); err == nil {
		t.Fatalf("6th reserve should be rejected before rollover")
	}

	// 用 make_interval 而不是 interval 字面量，避免 SQL 里的单引号。
	if _, err := s.Pool().Exec(ctx, "UPDATE users SET ai_period_start = ai_period_start - make_interval(months => 1) WHERE id = $1", userID); err != nil {
		t.Fatalf("backdate period: %v", err)
	}

	snap, err := s.Reserve(ctx, userID, 100)
	if err != nil {
		t.Fatalf("reserve after rollover should succeed: %v", err)
	}
	if snap.CallsUsed != 1 {
		t.Fatalf("want calls_used reset to 1, got %d", snap.CallsUsed)
	}
	if snap.TokensUsed != 100 {
		t.Fatalf("want tokens_used reset to 100, got %d", snap.TokensUsed)
	}
}

// TestReleaseTokensNeverGoesNegative 验证退回额度不会把已用量打成负数。
//
// 负数已用量会让后续判定全部放行，是比超发更危险的失效模式。
func TestReleaseTokensNeverGoesNegative(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID := newQuotaUser(t, s, 10, 1000000)

	if err := s.ReleaseTokens(ctx, userID, 99999); err != nil {
		t.Fatalf("release: %v", err)
	}
	snap, err := s.GetQuota(ctx, userID)
	if err != nil {
		t.Fatalf("get quota: %v", err)
	}
	if snap.TokensUsed < 0 {
		t.Fatalf("tokens_used must never be negative, got %d", snap.TokensUsed)
	}
}
