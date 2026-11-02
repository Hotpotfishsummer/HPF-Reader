package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/normalize"
)

// TestGlossaryRequiresAuth 锁定**鉴权**：未登录不得读术语表。
//
// 术语表能暴露用户读了什么书、书里有什么人名——是内容侧数据，
// 不是「无害的偏好设置」。漏鉴权等于泄漏阅读内容。
func TestGlossaryRequiresAuth(t *testing.T) {
	_, h := newTestServer(t)
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/v1/books/0192a3f4-c1b0-7000-8000-000000000000/glossary?targetLang=zh"},
		{http.MethodPut, "/v1/books/0192a3f4-c1b0-7000-8000-000000000000/glossary"},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s 未鉴权 = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// TestGlossaryRejectsNonUUIDBookID 锁定入参校验：bookId 必须是 UUID。
//
// 不校验的话非 UUID 会一路走到 SQL 层触发 22P02，返回 500 ——
// 客户端会把它当可重试错误无限重试。
func TestGlossaryRejectsNonUUIDBookID(t *testing.T) {
	srv, h := newTestServer(t)
	if srv.tokens == nil {
		t.Skip("no token issuer")
	}
	tok, _, err := srv.tokens.IssueAccessToken("0192a3f4-c1b0-7000-8000-000000000001", "d1", "user")
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/books/not-a-uuid/glossary?targetLang=zh", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("非 UUID bookId = %d, want 400（不能走到 SQL 层）", rec.Code)
	}
}

// TestGlossaryPutRequiresTargetLang 锁定：targetLang 必填。
//
// 不默认成 zh 是因为「猜用户想要哪种语言」会产生难以解释的行为：
// 用户以为在改中文术语表，实际改了日文的。
func TestGlossaryPutRequiresTargetLang(t *testing.T) {
	srv, h := newTestServer(t)
	if srv.tokens == nil {
		t.Skip("no token issuer")
	}
	tok, _, err := srv.tokens.IssueAccessToken("0192a3f4-c1b0-7000-8000-000000000001", "d1", "user")
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut,
		"/v1/books/0192a3f4-c1b0-7000-8000-000000000000/glossary",
		strings.NewReader(`{"terms":[{"display":"Darcy","target":"达西"}]}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("缺 targetLang = %d, want 400", rec.Code)
	}
}

// TestGlossaryDerivesKeyFromDisplay 锁定「服务端算 key」这条契约。
//
// 客户端不必实现归一化逻辑：那是一套有版本的规则，
// 客户端重复实现必然与服务端不一致，导致同一个人两条术语。
func TestGlossaryDerivesKeyFromDisplay(t *testing.T) {
	cases := []struct{ display, wantKey string }{
		{"Mr. Darcy", "darcy"},
		{"达西先生", "达西"},
		{"伊丽莎白", "伊丽莎白"},
	}
	for _, c := range cases {
		got := normalize.Normalize(c.display).NormKey
		if got != c.wantKey {
			t.Errorf("Normalize(%q).NormKey = %q, want %q", c.display, got, c.wantKey)
		}
	}
}
