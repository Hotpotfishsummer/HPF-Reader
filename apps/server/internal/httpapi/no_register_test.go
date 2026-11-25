package httpapi

// ★ 契约门禁：**HTTP 层不得存在任何注册入口**。
//
// 为什么需要这个测试（这是产品决定，不是技术细节）：
//   HPF-Reader 不提供公开注册。账号只能由运维在服务器上执行
//   `api createuser --email ...` 创建。早期实现里注册是「注册了路由 + 用
//   HPF_REGISTER_OPEN 开关在 handler 里返回 403」，这条路径有两个问题：
//     1. 端点依然存在于路由表里，公网扫描器能探测到它；
//     2. 建号代码（校验 / argon2 哈希 / 建用户+设备事务）必须一直留着，
//        而「开关被误设成 true」就足以让任何人凭空造号，烧 AI 配额与磁盘。
//
//   现在改为**不注册路由**，这个测试把决定钉死：
//   任何人以后想「顺手把注册加回来」，必须先删掉这条断言 —— 那是一次显式的产品决策。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 曾经用过的注册路径。列全是为了让「换个名字又加回来」也能被抓住。
var forbiddenRegistrationPaths = []string{
	"/v1/auth/register",
	"/v1/auth/signup",
	"/v1/auth/sign-up",
	"/v1/users",
}

// TestNoRegistrationRouteExists 断言这些路径一律 404（而不是 201 / 403 / 405）。
//
// 特别地，不能是 403：403 说明端点还在、只是被开关拦住了，
// 那就还是「误配即开放」的结构。必须是 404（路由根本不存在）。
func TestNoRegistrationRouteExists(t *testing.T) {
	_, h := newTestServer(t)

	for _, path := range forbiddenRegistrationPaths {
		t.Run(path, func(t *testing.T) {
			body := `{"email":"attacker@example.com","password":"attack-password-1"}`
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Fatalf(
					"POST %s = %d, want 404：本产品不提供公开注册，注册路由必须不存在"+
						"（403 也不行——那意味着端点还在，只是被开关拦住）。body=%s",
					path, rec.Code, rec.Body.String(),
				)
			}
		})
	}
}

// TestLoginRouteStillExists 是对上面那条断言的**反向保护**：
// 证明 newTestServer 的路由确实是通的、404 不是因为整张 mux 都没挂上。
//
// 用 GET 而不是 POST：mux 上只注册了 POST，方法不匹配时由 ServeMux 直接返回
// 405（Allow: POST），**根本不会进入 handler**——所以这里不需要真数据库，
// 也不会因为 store 为 nil 而 panic。
func TestLoginRouteStillExists(t *testing.T) {
	_, h := newTestServer(t)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/auth/login", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf(
			"GET /v1/auth/login = %d, want 405（Allow: POST）：登录路由丢了，"+
				"上面的注册断言会变成假绿",
			rec.Code,
		)
	}
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, http.MethodPost) {
		t.Fatalf("GET /v1/auth/login Allow = %q, want 含 POST", allow)
	}
}
