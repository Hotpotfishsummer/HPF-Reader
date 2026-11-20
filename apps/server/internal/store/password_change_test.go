package store

// 改密 / 全会话吊销 / 全站预算的真实数据库测试。
//
// 这些用例必须连真实 PostgreSQL 才有意义：
//   - 「改密与吊销在同一事务」依赖 Postgres 的事务语义，mock 断言不出来；
//   - 「全站聚合只统计当前周期」依赖 SQL 的 FILTER + ai_period_for()；
//   - 「已吊销的 token 不能被 refresh」依赖 UPDATE ... WHERE revoked_at IS NULL 的行锁。
// 未设置 HPF_TEST_DATABASE_URL 时整体 skip，保证默认路径（无 DB）仍然全绿。

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
)

// changePasswordTestUser 建一个用户并给它两条不同 family 的 refresh token。
//
// 两条不同 family 是关键：改密必须吊销**所有** family，
// 只吊销「当前这条」的话，另一台设备上的攻击者会话依然有效。
func changePasswordTestUser(t *testing.T, s *Store) (userID string, tokenIDs []string) {
	t.Helper()
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "pwd-"+idgen.NewUUID()+"@example.com", "old-hash", "")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	for i := 0; i < 2; i++ {
		id := idgen.NewUUID()
		if err := s.CreateRefreshToken(ctx, id, u.ID, idgen.NewUUID(), "hash-"+id,
			nil, time.Now().Add(time.Hour), "test-agent"); err != nil {
			t.Fatalf("create refresh token %d: %v", i, err)
		}
		tokenIDs = append(tokenIDs, id)
	}
	return u.ID, tokenIDs
}

// countUnrevoked 数该用户还有多少条未吊销的 refresh token。
func countUnrevoked(t *testing.T, s *Store, userID string) int {
	t.Helper()
	var n int
	if err := s.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
		userID).Scan(&n); err != nil {
		t.Fatalf("count refresh tokens: %v", err)
	}
	return n
}

// TestChangePasswordRevokesAllRefreshTokens 是「改密即全会话下线」的核心用例。
//
// 缺陷背景（这条链路缺失时的真实后果）：口令泄露后用户无法自救 ——
// 改密码不会吊销任何会话，攻击者用一条旧的 refresh token 就能一直换到新
// access token，改密完全白改。用户以为安全了，实际攻击者还在里面。
func TestChangePasswordRevokesAllRefreshTokens(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID, _ := changePasswordTestUser(t, s)

	if got := countUnrevoked(t, s, userID); got != 2 {
		t.Fatalf("precondition: unrevoked = %d, want 2", got)
	}

	revoked, err := s.ChangePassword(ctx, userID, "new-hash")
	if err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	if revoked != 2 {
		t.Fatalf("revoked = %d, want 2（两条不同 family 都必须吊销）", revoked)
	}
	if got := countUnrevoked(t, s, userID); got != 0 {
		t.Fatalf("after change: unrevoked = %d, want 0", got)
	}

	// 口令哈希必须真的换了，否则「改密」只是吊销了会话。
	var hash string
	if err := s.Pool().QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&hash); err != nil {
		t.Fatalf("read password hash: %v", err)
	}
	if hash != "new-hash" {
		t.Fatalf("password_hash = %q, want new-hash", hash)
	}
}

// TestChangePasswordUnknownUserIsNotFound 保证「token 有效但账号已被删」不会假装成功。
//
// 假装成功会让客户端以为改密完成并丢弃 token，实际账号状态完全没变。
func TestChangePasswordUnknownUserIsNotFound(t *testing.T) {
	s := quotaTestStore(t)
	_, err := s.ChangePassword(context.Background(), idgen.NewUUID(), "new-hash")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// TestChangePasswordClearsLockout 验证改密会清掉失败计数与锁定。
//
// 不清的话，用户在爆破风控窗口内改完密码，新口令仍然会被 429 拦住 ——
// 这是「已经自救成功却还被关在门外」的荒谬状态。
func TestChangePasswordClearsLockout(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	userID, _ := changePasswordTestUser(t, s)

	if err := s.RegisterLoginFailure(ctx, userID, 1, time.Hour); err != nil {
		t.Fatalf("register login failure: %v", err)
	}
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if !u.IsLocked(time.Now()) {
		t.Fatal("precondition: 账号应当已被锁定")
	}

	if _, err := s.ChangePassword(ctx, userID, "new-hash"); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	u, err = s.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatalf("get user after change: %v", err)
	}
	if u.IsLocked(time.Now()) {
		t.Fatal("改密后仍处于锁定状态：用户已经证明了身份，不该继续被拦")
	}
	if u.FailedLogins != 0 {
		t.Fatalf("failed_logins = %d, want 0", u.FailedLogins)
	}
}

// TestRevokeAllUserRefreshTokensIsScopedToUser 验证吊销不会波及别的账号。
//
// 这是最容易写错的地方：漏掉 user_id 条件就会「一个人登出，全站掉线」。
func TestRevokeAllUserRefreshTokensIsScopedToUser(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	victim, _ := changePasswordTestUser(t, s)
	bystander, _ := changePasswordTestUser(t, s)

	n, err := s.RevokeAllUserRefreshTokens(ctx, victim)
	if err != nil {
		t.Fatalf("RevokeAllUserRefreshTokens: %v", err)
	}
	if n != 2 {
		t.Fatalf("revoked = %d, want 2", n)
	}
	if got := countUnrevoked(t, s, bystander); got != 2 {
		t.Fatalf("另一个账号的 token 被误吊销了：unrevoked = %d, want 2", got)
	}

	// 幂等：再吊销一次应当吊销 0 条（不是报错）。
	n, err = s.RevokeAllUserRefreshTokens(ctx, victim)
	if err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	if n != 0 {
		t.Fatalf("second revoke = %d, want 0（已吊销的不能被重复计数）", n)
	}
}

// ---- 全站月度调用预算 ----
//
// ⚠️ 这两条用例的断言必须**相对基线**，不能写死绝对值。
//
// 原因：GlobalAICalls 是全库聚合，而 `go test ./...` 会**并行**跑不同的包，
// 别的包（httpapi / worker）的用例也在往 users.ai_calls_used 里写数。
// 第一版写死了「CallsUsed < 9999」和「limit=1e6 必然放行」，
// 结果全量跑时被别的包留下的 300 万计数打红——单独跑绿、全量跑红。
// 改成「先读基线，再用相对上限」后，无论库里有多少别人的残留都成立。

// globalBaseline 读当前全站已用调用数，作为后续断言的相对基线。
func globalBaseline(t *testing.T, s *Store) int64 {
	t.Helper()
	g, err := s.GlobalAICalls(context.Background(), 0)
	if err != nil {
		t.Fatalf("GlobalAICalls baseline: %v", err)
	}
	return g.CallsUsed
}

// TestGlobalAICallsAggregatesOnlyCurrentPeriod 验证全站聚合只统计当前周期。
//
// 这是最容易写错的一点：跨月未活动的用户还停在旧周期，
// 他们的历史计数属于上个月。若不过滤，新月份一开局就已经「超额」。
//
// 断言方式：造一个「上个月用了 9999 次」的用户，全站计数**不应因此增加**。
func TestGlobalAICallsAggregatesOnlyCurrentPeriod(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()

	before := globalBaseline(t, s)

	// 上个周期的用户：9999 次（必须被排除）。
	stale := newQuotaUser(t, s, 1000, 1000000)
	if _, err := s.Pool().Exec(ctx,
		`UPDATE users SET ai_calls_used = 9999, ai_period_start = ai_period_for(now()) - interval '1 month' WHERE id = $1`,
		stale); err != nil {
		t.Fatalf("seed stale: %v", err)
	}

	after, err := s.GlobalAICalls(ctx, 0)
	if err != nil {
		t.Fatalf("GlobalAICalls: %v", err)
	}
	// 允许别包并发写入造成的少量增长，但绝不能把 9999 算进来。
	if delta := after.CallsUsed - before; delta >= 9999 {
		t.Fatalf("上一个周期的 9999 次被算进了本月（基线 %d → %d）", before, after.CallsUsed)
	}
	if after.ResetAt.Before(time.Now()) {
		t.Fatalf("ResetAt 必须在未来，got %v", after.ResetAt)
	}
}

// TestCheckGlobalAICallBudget 覆盖三档：不限 / 有余量 / 已超额。
//
// 上限同样相对基线取：库里有多少别人的残留都不影响判定语义。
func TestCheckGlobalAICallBudget(t *testing.T) {
	s := quotaTestStore(t)
	ctx := context.Background()
	base := globalBaseline(t, s)

	// 1) 0 = 不限：必须放行，且不查库。
	if err := s.CheckGlobalAICallBudget(ctx, 0); err != nil {
		t.Fatalf("limit=0 must be unlimited, got %v", err)
	}
	// 2) 上限远高于当前已用：放行。
	if err := s.CheckGlobalAICallBudget(ctx, int(base)+1_000_000); err != nil {
		t.Fatalf("limit=base+1e6 must pass, got %v", err)
	}
	// 3) 上限设为 1（全站已用必然 >= 1）：必须返回带 scope=global 的错误。
	err := s.CheckGlobalAICallBudget(ctx, 1)
	var qe *ErrQuotaExceeded
	if !errors.As(err, &qe) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if qe.Scope != "global" {
		t.Fatalf("Scope = %q, want global", qe.Scope)
	}
	if qe.Dimension != "calls" {
		t.Fatalf("Dimension = %q, want calls", qe.Dimension)
	}
	if qe.Limit != 1 {
		t.Fatalf("Limit = %d, want 1", qe.Limit)
	}
	if qe.ResetAt.Before(time.Now()) {
		t.Fatalf("ResetAt 必须在未来，got %v", qe.ResetAt)
	}
}

// TestGlobalQuotaExhaustedBoundary 验证边界语义：用满 vs 还剩一次。
//
// 判定是 used >= limit（而不是 used > limit）：额度用满就该拒，
// 否则实际会多放行一次，全站上限形同虚设。
func TestGlobalQuotaExhaustedBoundary(t *testing.T) {
	for _, tc := range []struct {
		name     string
		used     int64
		limit    int64
		exhausts bool
	}{
		{"还剩一次", 4, 5, false},
		{"正好用满", 5, 5, true},
		{"已经超额", 6, 5, true},
		{"零上限表示不限", 999999, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := GlobalQuota{CallsUsed: tc.used, CallsLimit: tc.limit}
			if got := g.Exhausted(); got != tc.exhausts {
				t.Fatalf("Exhausted() = %v, want %v (used=%d limit=%d)",
					got, tc.exhausts, tc.used, tc.limit)
			}
		})
	}
}
