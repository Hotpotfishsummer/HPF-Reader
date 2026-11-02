package store

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// TestPushBookConfigWithNonUUIDKey 是 F-05 的回归测试。
//
// 缺陷：SyncStore.LoadPending 对 EntityBookConfig 无条件走 loadProgress，
// 把 entityID 当 book_id 绑进 uuid 列。而 Push 循环是**无条件**调用 LoadPending 的，
// 所以任何非 UUID 的 book_config 键（例如术语表用的 `glossary:<bookId>:<key>`）
// 都会触发 SQLSTATE 22P02，让整批 push 返回 500。
//
// 这是最糟的组合：ValidateOp 已经明确豁免了 book_config 的 UUID 校验
// （engine.go 注释写着「键名可以是任意配置键」），校验层放行、存储层炸掉；
// 而客户端把 5xx 当可重试错误 —— 一条永远不可能成功的 op 会被无限重试。
//
// 断言：非 UUID 键的 book_config op 能正常 applied，且再次 push 同一键能读到权威状态。
func TestPushBookConfigWithNonUUIDKey(t *testing.T) {
	s, ctx := testStore(t)
	suffix := testEmailSuffix()
	user, _, err := s.RegisterAccount(ctx, "bookcfg-"+suffix+"@example.com", "hash", "C", DeviceRegistration{
		ID: testDeviceID(), Name: "d", Platform: "windows",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	eng, err := sync.NewEngine(NewSyncStore(s), "test", time.Now)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	// 关键：entityId 不是 UUID，是任意键名。
	key := "glossary:" + testDeviceID() + ":darcy"
	op := sync.Op{
		OpID:     testDeviceID(),
		Entity:   sync.EntityBookConfig,
		EntityID: key,
		Kind:     sync.KindUpsert,
		HLC:      "0192a3f4c1b00-0000000a-7f3c9d21",
		Payload:  json.RawMessage(`{"target":"达西","source":"user_confirmed"}`),
	}

	res, err := eng.Push(ctx, user.ID, "", []sync.Op{op})
	if err != nil {
		// 这里若出现 SQLSTATE 22P02，说明 LoadPending 又把键当 UUID 用了。
		if strings.Contains(err.Error(), "22P02") {
			t.Fatalf("push failed with 22P02: non-UUID book_config key reached a uuid column: %v", err)
		}
		t.Fatalf("push: %v", err)
	}
	if len(res.Outcomes) != 1 {
		t.Fatalf("got %d outcomes, want 1", len(res.Outcomes))
	}
	if res.Outcomes[0].Status != sync.StatusApplied {
		t.Fatalf("status = %q, want applied (reason=%q)", res.Outcomes[0].Status, res.Outcomes[0].Reason)
	}

	// 第二次 push 同一键（不同 opId）：应读到已有权威状态，仍然是 applied（LWW 覆盖）。
	op2 := op
	op2.OpID = testDeviceID()
	op2.HLC = "0192a3f4c1b00-0000000b-7f3c9d21"
	op2.Payload = json.RawMessage(`{"target":"达西先生","source":"user_confirmed"}`)
	res2, err := eng.Push(ctx, user.ID, "", []sync.Op{op2})
	if err != nil {
		t.Fatalf("second push: %v", err)
	}
	if res2.Outcomes[0].Status != sync.StatusApplied {
		t.Fatalf("second push status = %q, want applied", res2.Outcomes[0].Status)
	}

	// 权威状态应能读回最新值。
	st, found, err := NewSyncStore(s).LoadPending(ctx, user.ID, sync.EntityBookConfig, key)
	if err != nil {
		t.Fatalf("load pending: %v", err)
	}
	if !found {
		t.Fatal("book_config key not found after push: state must be readable from change_log")
	}
	if !strings.Contains(string(st.Payload), "达西先生") {
		t.Fatalf("payload = %s, want the latest value", st.Payload)
	}
}

// TestLoadBookConfigTombstoneReturnsNotFound 断言删除后的键不复活（remove-wins）。
func TestLoadBookConfigTombstoneReturnsNotFound(t *testing.T) {
	s, ctx := testStore(t)
	suffix := testEmailSuffix()
	user, _, err := s.RegisterAccount(ctx, "cfgdel-"+suffix+"@example.com", "hash", "D", DeviceRegistration{
		ID: testDeviceID(), Name: "d", Platform: "windows",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	eng, err := sync.NewEngine(NewSyncStore(s), "test", time.Now)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}

	key := "glossary:" + testDeviceID() + ":elizabeth"
	upsert := sync.Op{
		OpID: testDeviceID(), Entity: sync.EntityBookConfig, EntityID: key,
		Kind: sync.KindUpsert, HLC: "0192a3f4c1b00-0000000a-7f3c9d21",
		Payload: json.RawMessage(`{"target":"伊丽莎白"}`),
	}
	if _, err := eng.Push(ctx, user.ID, "", []sync.Op{upsert}); err != nil {
		t.Fatalf("upsert push: %v", err)
	}

	del := upsert
	del.OpID = testDeviceID()
	del.Kind = sync.KindDelete
	del.HLC = "0192a3f4c1b00-0000000b-7f3c9d21"
	if _, err := eng.Push(ctx, user.ID, "", []sync.Op{del}); err != nil {
		t.Fatalf("delete push: %v", err)
	}

	_, found, err := NewSyncStore(s).LoadPending(ctx, user.ID, sync.EntityBookConfig, key)
	if err != nil {
		t.Fatalf("load pending: %v", err)
	}
	if found {
		t.Fatal("deleted book_config key still reports authoritative state: tombstones must win")
	}
}
