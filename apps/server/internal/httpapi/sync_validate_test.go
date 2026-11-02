package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
)

const testDeviceID = "11111111-1111-4111-8111-111111111111"
const testBookID = "b73e1887-d3f6-466f-bdb5-cc02081dc1df"

// TestSyncPushInvalidOpIDReturns400Not500 是 F-02 的回归测试。
//
// 缺陷复现（spikes/sync 联调，见 spikes/sync/RESULTS.md §6.2）：
// opId = "01a19d1b-66b3-000-7b27-85780e478194"（第三段只有 3 位，不是合法 UUID）
// 被直接绑进 uuid 列，PostgreSQL 抛 SQLSTATE 22P02，服务端回 500；
// 客户端把 5xx 当可重试错误，于是永久重试这条永远不可能成功的 op。
//
// 断言：400 且不是 500，并指明是哪个字段错了。
// 测试服务器**没有数据库**（newTestServer 不建 pool）：若校验发生在触库之后，
// 这里会 panic 并被 recover 中间件转成 500。因此本测试同时证明「校验先于触库」。
func TestSyncPushInvalidOpIDReturns400Not500(t *testing.T) {
	srv, h := newTestServer(t)
	access := mustAccessToken(t, srv)

	payload := fmt.Sprintf(`{"deviceId":"%s","ops":[{"opId":"01a19d1b-66b3-000-7b27-85780e478194",`+
		`"entity":"progress","entityId":"%s","kind":"upsert",`+
		`"hlc":"001a19d234913-00000000-a1a1a1a1","payload":{"totalProgression":0.01}}]}`,
		testDeviceID, testBookID)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	h.ServeHTTP(rec, req)

	if rec.Code == http.StatusInternalServerError {
		t.Fatalf("非法 opId 仍然触发了 500（客户端会无限重试）: %s", rec.Body.String())
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Code    string `json:"code"`
		Details struct {
			Ops []struct {
				Index   int    `json:"index"`
				OpID    string `json:"opId"`
				Field   string `json:"field"`
				Message string `json:"message"`
			} `json:"ops"`
		} `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body.Code != "invalid_request" {
		t.Fatalf("code = %q, want invalid_request", body.Code)
	}
	if len(body.Details.Ops) != 1 {
		t.Fatalf("details.ops len = %d, want 1 (%s)", len(body.Details.Ops), rec.Body.String())
	}
	got := body.Details.Ops[0]
	if got.Index != 0 || got.Field != "opId" {
		t.Fatalf("details.ops[0] = %+v, want index 0 field opId", got)
	}
	if !strings.Contains(got.Message, "UUID") {
		t.Fatalf("message 没有说明原因: %q", got.Message)
	}
}

// TestSyncPushBatchReportsEveryInvalidOp 覆盖坏 op 与好 op 混在同一批的情况。
//
// 选择「整批 400 并逐条指明」而不是「跳过坏 op 继续」：HTTP 200 必须意味着
// 本批每条 op 都拿到了服务端裁决，否则客户端会把没被处理的 op 当成已出队而丢数据。
func TestSyncPushBatchReportsEveryInvalidOp(t *testing.T) {
	srv, h := newTestServer(t)
	access := mustAccessToken(t, srv)
	payload := fmt.Sprintf(`{"deviceId":"%s","ops":[`+
		`{"opId":"22222222-2222-4222-8222-222222222222","entity":"progress","entityId":"%s",`+
		`"kind":"upsert","hlc":"001a19d234913-00000000-a1a1a1a1","payload":{"totalProgression":0.01}},`+
		`{"opId":"not-a-uuid","entity":"progress","entityId":"%s",`+
		`"kind":"upsert","hlc":"001a19d234914-00000000-a1a1a1a1","payload":{"totalProgression":0.02}},`+
		`{"opId":"33333333-3333-4333-8333-333333333333","entity":"progress","entityId":"%s",`+
		`"kind":"upsert","hlc":"001a19d234915-00000000-a1a1a1a1","bookId":"junk",`+
		`"payload":{"totalProgression":0.03}}]}`,
		testDeviceID, testBookID, testBookID, testBookID)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+access)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Details struct {
			Ops []struct {
				Index int    `json:"index"`
				Field string `json:"field"`
			} `json:"ops"`
		} `json:"details"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if len(body.Details.Ops) != 2 {
		t.Fatalf("details.ops len = %d, want 2 (%s)", len(body.Details.Ops), rec.Body.String())
	}
	if body.Details.Ops[0].Index != 1 || body.Details.Ops[0].Field != "opId" {
		t.Fatalf("ops[0] = %+v, want index 1 field opId", body.Details.Ops[0])
	}
	if body.Details.Ops[1].Index != 2 || body.Details.Ops[1].Field != "bookId" {
		t.Fatalf("ops[1] = %+v, want index 2 field bookId", body.Details.Ops[1])
	}
}

// mustAccessToken 用测试服务器的签发器造一个合法 access token
// （鉴权中间件只校验 JWT 签名与声明，不查库，所以无需数据库）。
func mustAccessToken(t *testing.T, srv *Server) string {
	t.Helper()
	access, _, err := srv.tokens.IssueAccessToken(idgen.NewUUID(), idgen.NewUUID(), "user")
	if err != nil {
		t.Fatalf("IssueAccessToken: %v", err)
	}
	return access
}
