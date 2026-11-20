package httpapi

// 改密 / 全部设备下线 / 全站 AI 预算的 HTTP 层测试。
//
// 这些用例刻意**不需要数据库**：它们覆盖的是「请求还没触库就该被拒」的部分
// ——路由是否挂了鉴权、请求体校验、错误码与 details 的形状。
// 需要真库的语义（事务性吊销、全站聚合）在 store 包的同名测试里，
// 用 HPF_TEST_DATABASE_URL 门控（未设置则 skip）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/config"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// issueTestToken 为某个用户签发一个合法的 access token。
//
// 走真实的 TokenIssuer 而不是手搓 JWT：手搓的 token 一旦与签发端漂移
// （签名算法、issuer、claim 名），测试会通过而线上 401。
func issueTestToken(t *testing.T, srv *Server, userID string) string {
	t.Helper()
	tok, _, err := srv.tokens.IssueAccessToken(userID, "11111111-1111-4111-8111-111111111111", "user")
	if err != nil {
		t.Fatalf("IssueAccessToken: %v", err)
	}
	return tok
}

// postJSON 发一个带 bearer 的 POST 请求。
func postJSON(h http.Handler, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// decodeErrorBody 解析统一错误体。
func decodeErrorBody(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 Error JSON: %v (%s)", err, rec.Body.String())
	}
	return body
}

// TestPasswordAndLogoutAllRoutesRequireBearer 保证两个新端点都挂了 requireAuth。
//
// 这两个端点是「账号接管」类操作：漏挂鉴权等于任何人凭一个 userID
// 就能改别人的密码 / 踢掉别人所有设备。
func TestPasswordAndLogoutAllRoutesRequireBearer(t *testing.T) {
	_, h := newTestServer(t)
	for _, path := range []string{"/v1/auth/password", "/v1/auth/logout-all"} {
		rec := postJSON(h, path, "", `{"currentPassword":"old","newPassword":"newnewnew"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("POST %s 无 token = %d, want 401", path, rec.Code)
		}
		body := decodeErrorBody(t, rec)
		if body.Code != codeUnauthorized {
			t.Fatalf("POST %s code = %q, want %q", path, body.Code, codeUnauthorized)
		}

		// 伪造/过期的 token 同样必须 401（而不是漏到 handler 里）。
		rec = postJSON(h, path, "not-a-real-jwt", `{}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("POST %s 伪造 token = %d, want 401", path, rec.Code)
		}
	}
}

// TestChangePasswordRejectsBadBodies 覆盖所有「不合法请求体」的分支。
//
// 这些校验必须在触库**之前**完成：先查库再校验会让攻击者用畸形请求
// 免费消耗数据库连接，而且 400/401 的语义也会被搅乱。
func TestChangePasswordRejectsBadBodies(t *testing.T) {
	srv, h := newTestServer(t)
	token := issueTestToken(t, srv, "11111111-1111-4111-8111-111111111111")

	for _, tc := range []struct {
		name string
		body string
		want string
	}{
		{"非法 JSON", `{not json`, "invalid JSON body"},
		{"未知字段被拒", `{"currentPassword":"old","newPassword":"newnewnew","extra":1}`, "invalid JSON body"},
		{"缺 currentPassword", `{"newPassword":"newnewnew"}`, "are required"},
		{"缺 newPassword", `{"currentPassword":"old"}`, "are required"},
		{"新口令太短", `{"currentPassword":"old","newPassword":"1234567"}`, "8-200"},
		{"新口令太长", `{"currentPassword":"old","newPassword":"` + strings.Repeat("a", 201) + `"}`, "8-200"},
		{"新旧口令相同", `{"currentPassword":"samepassword","newPassword":"samepassword"}`, "must differ"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := postJSON(h, "/v1/auth/password", token, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
			}
			body := decodeErrorBody(t, rec)
			if body.Code != codeInvalidRequest {
				t.Fatalf("code = %q, want %q", body.Code, codeInvalidRequest)
			}
			if !strings.Contains(body.Message, tc.want) {
				t.Fatalf("message = %q, want to contain %q", body.Message, tc.want)
			}
		})
	}
}

// TestChangePasswordAcceptsEightAndTwoHundredCharBoundaries 守住长度边界。
//
// 注册的规则是 8~200（含），改密必须完全一致：
// 不一致会让「注册能过的口令改不进去」，用户完全无法理解为什么被拒。
//
// 直接测纯校验函数（不经过 HTTP + 数据库）：边界语义只由它决定，
// 走完整链路只会让断言被「没有数据库」的 5xx 噪声掩盖。
func TestChangePasswordAcceptsEightAndTwoHundredCharBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name string
		new  string
	}{
		{"恰好 8 字符", "12345678"},
		{"恰好 200 字符", strings.Repeat("a", 200)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, msg := validateChangePasswordRequest(changePasswordRequest{
				CurrentPassword: "oldpassword",
				NewPassword:     tc.new,
			})
			if code != "" {
				t.Fatalf("边界长度被误判为非法请求: code=%q msg=%q", code, msg)
			}
		})
	}
	// 边界外必须仍然被拒（否则「边界」的断言就只是「它没报错」）。
	for _, tc := range []struct {
		name string
		new  string
	}{
		{"少一个字符", "1234567"},
		{"多一个字符", strings.Repeat("a", 201)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, _ := validateChangePasswordRequest(changePasswordRequest{
				CurrentPassword: "oldpassword",
				NewPassword:     tc.new,
			})
			if code == "" {
				t.Fatal("超出 8~200 的口令必须被拒")
			}
		})
	}
}

// TestQuotaExceededDetailsCarryScope 保证 429 的 details 能区分「谁的额度」。
//
// 这是全站预算唯一的对外可见面：客户端必须能分辨
// 「我的额度用完了（等重置 / 提额）」与「全站预算用完了（换账号也没用）」。
// 不区分的话，客户端会给出「去注册小号」这种既没用又危险的建议。
func TestQuotaExceededDetailsCarryScope(t *testing.T) {
	reset := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		scope     string
		dimension string
		wantScope string
	}{
		{"用户额度", "", "calls", "user"},
		{"用户 token 额度", "user", "tokens", "user"},
		{"全站预算", "global", "calls", "global"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := &store.ErrQuotaExceeded{
				Dimension: tc.dimension,
				Limit:     100,
				Used:      100,
				ResetAt:   reset,
				Scope:     tc.scope,
			}
			rec := httptest.NewRecorder()
			writeQuotaExceeded(rec, err)

			if rec.Code != http.StatusTooManyRequests {
				t.Fatalf("status = %d, want 429", rec.Code)
			}
			var body struct {
				Code    string         `json:"code"`
				Message string         `json:"message"`
				Details map[string]any `json:"details"`
			}
			if e := json.Unmarshal(rec.Body.Bytes(), &body); e != nil {
				t.Fatalf("响应不是合法 JSON: %v", e)
			}
			if body.Code != codeQuotaExceeded {
				t.Fatalf("code = %q, want %q", body.Code, codeQuotaExceeded)
			}
			if got := body.Details["scope"]; got != tc.wantScope {
				t.Fatalf("details.scope = %v, want %q", got, tc.wantScope)
			}
			if got := body.Details["dimension"]; got != tc.dimension {
				t.Fatalf("details.dimension = %v, want %q", got, tc.dimension)
			}
			if body.Details["resetAt"] != reset.Format(time.RFC3339) {
				t.Fatalf("details.resetAt = %v", body.Details["resetAt"])
			}
		})
	}
}

// TestGlobalBudgetIsUnlimitedByZero 保证 0 = 不限，且不查库。
//
// 这条语义很重要：默认值就是 0，如果 0 被当成「上限 0」，
// 那么所有部署升级后 AI 会立刻全线 429 —— 一次配置升级变成全站故障。
func TestGlobalBudgetIsUnlimitedByZero(t *testing.T) {
	srv, _ := newTestServer(t)
	// srv.store 为 nil：若实现试图查库，这里会 panic 而不是返回 nil。
	if err := srv.checkGlobalAIBudget(nil); err != nil { //nolint:staticcheck // nil ctx 是刻意的：不限时根本不该用到它
		t.Fatalf("limit=0 必须放行且不触库，got %v", err)
	}
	if srv.cfg.AIGlobalMonthlyCalls != 0 {
		t.Fatalf("测试前提：默认 AIGlobalMonthlyCalls 应为 0，got %d", srv.cfg.AIGlobalMonthlyCalls)
	}
}

// TestGlobalBudgetSkipsWhenStoreMissing 保证最小 Server（无数据库）不会 500。
//
// 路由级测试构造的 Server 没有 store；若闸门不判空，
// 每一个 AI 请求都会 panic，测试与本地最小跑法全部崩掉。
func TestGlobalBudgetSkipsWhenStoreMissing(t *testing.T) {
	cfg := config.Config{Env: "dev", RateLimitAPI: 1000, RateLimitAuth: 1000}
	srv, _ := New(Deps{Config: cfg})
	if srv.cfg.AIGlobalMonthlyCalls != 0 {
		t.Fatalf("前提：应为 0，got %d", srv.cfg.AIGlobalMonthlyCalls)
	}
	if err := srv.checkGlobalAIBudget(nil); err != nil { //nolint:staticcheck
		t.Fatalf("没有 store 时应当放行，got %v", err)
	}
}

// TestOpenAPIDocumentsPasswordAndLogoutAll 是契约门禁：新接口必须写进 openapi.yaml。
//
// 路由与契约必须一一对应（server.go 顶部注释的承诺）。
// 漏写不会让 Go 侧报错，但前端生成不出对应的方法，整条功能链断掉。
func TestOpenAPIDocumentsPasswordAndLogoutAll(t *testing.T) {
	path := "../../../../api/openapi.yaml"
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("openapi.yaml not found at %s: %v", path, err)
	}
	doc := string(b)

	for _, want := range []string{
		"/v1/auth/password:",
		"/v1/auth/logout-all:",
		"PasswordChangeRequest:",
		"LogoutRequest:",
		"currentPassword",
		"newPassword",
		// 全站预算必须写进契约，否则前端不知道该处理 scope=global。
		"HPF_AI_GLOBAL_MONTHLY_CALLS",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("openapi.yaml 缺少 %q（新接口/新配置必须同步进契约）", want)
		}
	}

	// 两个新端点都必须声明 204（改密/登出成功无响应体）。
	for _, block := range []string{
		doc[strings.Index(doc, "/v1/auth/password:"):strings.Index(doc, "/v1/auth/logout-all:")],
		doc[strings.Index(doc, "/v1/auth/logout-all:"):strings.Index(doc, "/v1/me:")],
	} {
		if !strings.Contains(block, "'204'") {
			t.Fatalf("openapi.yaml 的 auth 端点缺少 204 响应:\n%s", block)
		}
	}
}
