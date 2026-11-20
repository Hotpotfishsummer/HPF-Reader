package httpapi

// 改密 / 全部设备下线 / 全站 AI 预算的**端到端**测试（真库 + 真 argon2）。
//
// 与 auth_password_test.go 的分工：
//   - auth_password_test.go：不碰库，覆盖「请求还没触库就该被拒」的部分；
//   - 本文件：连真库跑完整链路，覆盖「必须真的发生」的部分
//     （会话真的被吊销、口令真的换了、全站预算真的会拒）。
//
// 未设置 HPF_TEST_DATABASE_URL 时整体 skip，保证默认路径仍然全绿。

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// stubTranslator 是一个永远返回固定译文的最小 Translator 实现。
//
// 为什么需要它：`handleTranslate` 在 `s.translator == nil` 时直接返回 503，
// 而 503 发生在成本闸门之前。没有 translator 的测试只能证明「网关没配」，
// 根本走不到预算判定——那样的断言是假绿的。
type stubTranslator struct{}

func (stubTranslator) Name() string { return "stub" }

func (stubTranslator) TranslateStream(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, error) {
	out, errc, _, err := stubTranslator{}.TranslateStreamWithUsage(ctx, req)
	return out, errc, err
}

func (stubTranslator) TranslateStreamWithUsage(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, <-chan ai.Usage, error) {
	out := make(chan string, 1)
	errc := make(chan error, 1)
	usagec := make(chan ai.Usage, 1)
	out <- "translated"
	close(out)
	close(errc)
	usagec <- ai.Usage{InputTokens: 5, OutputTokens: 5, Source: ai.UsageSourceUpstream}
	close(usagec)
	return out, errc, usagec, nil
}

// e2eServer 构造一个**带真库**的 Server。
//
// argon2 参数被降到最低档（内存 8MiB、1 次迭代）：测试里要跑几十次哈希，
// 用生产参数（64MiB × 3）会让整个包跑到分钟级。安全性不在测试里验证。
func e2eServer(t *testing.T, cfg config.Config) (*Server, http.Handler, *store.Store) {
	t.Helper()
	dsn := os.Getenv("HPF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("HPF_TEST_DATABASE_URL not set; skipping end-to-end auth test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	st := store.New(pool)

	cfg.Env = "dev"
	if cfg.RateLimitAPI == 0 {
		cfg.RateLimitAPI = 10000
	}
	if cfg.RateLimitAuth == 0 {
		cfg.RateLimitAuth = 10000
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	tokens, err := auth.NewTokenIssuer("e2e-secret-that-is-long-enough-32b!", "hpf-reader", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	srv, h := New(Deps{Config: cfg, Logger: logger, Store: st, Tokens: tokens, Translator: stubTranslator{}})
	// 最低成本参数：测试不关心抗暴力破解强度。
	srv.SetArgonParams(e2eArgon)
	return srv, h, st
}

// e2eArgon 是测试专用的最低成本 argon2 参数。
var e2eArgon = auth.Argon2Params{
	Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
}

// e2eUser 建一个用户，返回 (userID, email, 明文口令)。
func e2eUser(t *testing.T, st *store.Store, quotaCalls int) (string, string, string) {
	t.Helper()
	ctx := context.Background()
	email := "e2e-" + idgen.NewUUID() + "@example.com"
	const password = "original-password-123"
	hash, err := auth.HashPassword(password, e2eArgon)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	u, err := st.CreateUser(ctx, email, hash, "")
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if quotaCalls > 0 {
		if _, err := st.Pool().Exec(ctx, `UPDATE users SET quota_ai_calls = $2 WHERE id = $1`, u.ID, quotaCalls); err != nil {
			t.Fatalf("set quota: %v", err)
		}
	}
	return u.ID, email, password
}

// seedRefreshTokens 给用户塞 n 条不同 family 的 refresh token。
func seedRefreshTokens(t *testing.T, st *store.Store, userID string, n int) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		id := idgen.NewUUID()
		if err := st.CreateRefreshToken(ctx, id, userID, idgen.NewUUID(), "hash-"+id,
			nil, time.Now().Add(time.Hour), "e2e"); err != nil {
			t.Fatalf("CreateRefreshToken: %v", err)
		}
	}
}

// unrevokedTokens 数该用户未吊销的 refresh token 数。
func unrevokedTokens(t *testing.T, st *store.Store, userID string) int {
	t.Helper()
	var n int
	if err := st.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
		userID).Scan(&n); err != nil {
		t.Fatalf("count tokens: %v", err)
	}
	return n
}

// TestE2EChangePasswordRevokesAllSessions 是本次改动的核心验收：
// 「口令泄露后用户能自救」必须真的成立。
//
// 缺陷背景（这条链路缺失时的真实后果）：改密不吊销会话 → 攻击者用一条
// 旧的 refresh token 就能持续换到新 access token，改密完全白改。
func TestE2EChangePasswordRevokesAllSessions(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{})
	userID, email, oldPassword := e2eUser(t, st, 0)
	seedRefreshTokens(t, st, userID, 3)

	if got := unrevokedTokens(t, st, userID); got != 3 {
		t.Fatalf("precondition: unrevoked = %d, want 3", got)
	}
	token := issueTestToken(t, srv, userID)

	const newPassword = "brand-new-password-456"
	rec := postJSON(h, "/v1/auth/password", token,
		`{"currentPassword":"`+oldPassword+`","newPassword":"`+newPassword+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("204 不该有响应体，got %q", rec.Body.String())
	}

	// 1) 全部会话被吊销（含别的设备）。
	if got := unrevokedTokens(t, st, userID); got != 0 {
		t.Fatalf("改密后仍有 %d 条未吊销的 refresh token", got)
	}
	// 2) 旧口令失效、新口令可用 —— 直接查库比对哈希（不依赖登录端点）。
	u, err := st.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	okOld, err := auth.VerifyPassword(oldPassword, u.PasswordHash)
	if err != nil {
		t.Fatalf("verify old: %v", err)
	}
	if okOld {
		t.Fatal("旧口令在改密后仍然可用——改密没有真正生效")
	}
	okNew, err := auth.VerifyPassword(newPassword, u.PasswordHash)
	if err != nil {
		t.Fatalf("verify new: %v", err)
	}
	if !okNew {
		t.Fatal("新口令无法通过校验——用户会被锁在门外")
	}
	_ = email
}

// TestE2EChangePasswordWrongCurrentIsRejected 验证「必须知道当前口令」这道闸门。
//
// 这是本端点最重要的安全性质：只凭一个有效 access token 就允许改密，
// 等于把「15 分钟内被偷到的 token」升级成「永久接管账号」。
func TestE2EChangePasswordWrongCurrentIsRejected(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{})
	userID, _, _ := e2eUser(t, st, 0)
	seedRefreshTokens(t, st, userID, 1)
	token := issueTestToken(t, srv, userID)

	rec := postJSON(h, "/v1/auth/password", token,
		`{"currentPassword":"wrong-password","newPassword":"whatever-123"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body.String())
	}
	body := decodeErrorBody(t, rec)
	if body.Code != codeInvalidCredentials {
		t.Fatalf("code = %q, want %q", body.Code, codeInvalidCredentials)
	}
	// 口令错误时**绝不能**吊销会话或改口令：否则攻击者只要乱试一次
	// 就能把真实用户全端踢下线（拒绝服务），成本极低。
	if got := unrevokedTokens(t, st, userID); got != 1 {
		t.Fatalf("口令错误时不该吊销会话，unrevoked = %d, want 1", got)
	}
}

// TestE2ELogoutAllRevokesEverySession 验证 logout-all 真的吊销所有设备。
func TestE2ELogoutAllRevokesEverySession(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{})
	userID, _, _ := e2eUser(t, st, 0)
	seedRefreshTokens(t, st, userID, 4)
	// 旁观者：必须完全不受影响。
	otherID, _, _ := e2eUser(t, st, 0)
	seedRefreshTokens(t, st, otherID, 2)

	token := issueTestToken(t, srv, userID)
	rec := postJSON(h, "/v1/auth/logout-all", token, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body.String())
	}
	if got := unrevokedTokens(t, st, userID); got != 0 {
		t.Fatalf("logout-all 后仍有 %d 条会话未吊销", got)
	}
	if got := unrevokedTokens(t, st, otherID); got != 2 {
		t.Fatalf("另一个账号被误伤：unrevoked = %d, want 2", got)
	}
}

// TestE2EGlobalBudgetBlocksTranslate 验证全站预算真的会拦住 AI 请求。
//
// 断言 details.scope=global：这是客户端唯一能区分
// 「我的额度用完了」与「全站预算用完了」的信号。
func TestE2EGlobalBudgetBlocksTranslate(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{AIGlobalMonthlyCalls: 1})
	ctx := context.Background()
	userID, _, _ := e2eUser(t, st, 1000) // 用户自己的额度充足
	// 别的账号把全站用量顶到上限之上。
	hog, _, _ := e2eUser(t, st, 1000)
	if _, err := st.Pool().Exec(ctx,
		`UPDATE users SET ai_calls_used = 999999, ai_period_start = ai_period_for(now()) WHERE id = $1`,
		hog); err != nil {
		t.Fatalf("seed hog: %v", err)
	}
	token := issueTestToken(t, srv, userID)

	rec := postJSON(h, "/v1/ai/translate", token,
		`{"text":"hello world","targetLang":"zh"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body.Code != codeQuotaExceeded {
		t.Fatalf("code = %q, want %q", body.Code, codeQuotaExceeded)
	}
	if body.Details["scope"] != "global" {
		t.Fatalf("details.scope = %v, want global（客户端靠它区分全站/个人额度）", body.Details["scope"])
	}
	if body.Details["dimension"] != "calls" {
		t.Fatalf("details.dimension = %v, want calls", body.Details["dimension"])
	}
}

// TestE2EGlobalBudgetBlocksJobCreation 验证超额时任务**不入队**。
//
// 入队了再等 worker 发现超额，用户会一直盯着一个永远不会跑的任务；
// 队列也会堆到下个月。必须在入队前就拒。
func TestE2EGlobalBudgetBlocksJobCreation(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{AIGlobalMonthlyCalls: 1})
	ctx := context.Background()
	userID, _, _ := e2eUser(t, st, 1000)
	hog, _, _ := e2eUser(t, st, 1000)
	if _, err := st.Pool().Exec(ctx,
		`UPDATE users SET ai_calls_used = 999999, ai_period_start = ai_period_for(now()) WHERE id = $1`,
		hog); err != nil {
		t.Fatalf("seed hog: %v", err)
	}
	bookID := idgen.NewUUID()
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO books (id, user_id, title, format, reincarnation) VALUES ($1, $2, 't', 'epub', gen_random_uuid())`,
		bookID, userID); err != nil {
		t.Fatalf("insert book: %v", err)
	}
	token := issueTestToken(t, srv, userID)

	rec := postJSON(h, "/v1/ai/jobs", token,
		`{"bookId":"`+bookID+`","kind":"book_translate","options":{"targetLang":"zh"}}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (%s)", rec.Code, rec.Body.String())
	}
	// 队列里不该多出任务。
	var n int
	if err := st.Pool().QueryRow(ctx,
		`SELECT count(*) FROM ai_jobs WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count jobs: %v", err)
	}
	if n != 0 {
		t.Fatalf("全站超额时仍然创建了 %d 个任务——应当直接拒绝而不是入队", n)
	}
}

// TestE2EGlobalBudgetUnlimitedByDefault 保证默认配置不会误伤 AI 功能。
//
// 这是最容易造成全站故障的回归点：默认值 0 若被当成「上限 0」，
// 所有部署升级后 AI 会立刻全线 429。
func TestE2EGlobalBudgetUnlimitedByDefault(t *testing.T) {
	srv, h, st := e2eServer(t, config.Config{}) // AIGlobalMonthlyCalls 零值
	ctx := context.Background()
	userID, _, _ := e2eUser(t, st, 1000)
	hog, _, _ := e2eUser(t, st, 1000)
	if _, err := st.Pool().Exec(ctx,
		`UPDATE users SET ai_calls_used = 999999, ai_period_start = ai_period_for(now()) WHERE id = $1`,
		hog); err != nil {
		t.Fatalf("seed hog: %v", err)
	}
	token := issueTestToken(t, srv, userID)

	rec := postJSON(h, "/v1/ai/translate", token,
		`{"text":"hello","targetLang":"zh"}`)
	// 没有配置 AI 网关时会是 503，但**绝不能**是 429：
	// 429 意味着「默认配置就把功能关掉了」。
	if rec.Code == http.StatusTooManyRequests {
		t.Fatalf("默认配置（0=不限）不该 429：%s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "global") {
		t.Fatalf("默认配置不该出现全站预算错误：%s", rec.Body.String())
	}
}
