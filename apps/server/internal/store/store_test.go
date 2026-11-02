package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

// ---- 游标编码：分页的正确性依赖它 ----

func TestCursorRoundTrip(t *testing.T) {
	c := Cursor{TS: time.Date(2026, 11, 2, 12, 30, 0, 0, time.UTC), ID: "11111111-1111-4111-8111-111111111111"}
	encoded := c.Encode()
	if encoded == "" {
		t.Fatal("Encode returned an empty cursor")
	}
	back, err := DecodeCursor(encoded)
	if err != nil {
		t.Fatalf("DecodeCursor: %v", err)
	}
	if !back.TS.Equal(c.TS) || back.ID != c.ID {
		t.Fatalf("round trip mismatch: %+v vs %+v", back, c)
	}
	// 空游标表示「从头开始」，不能报错。
	empty, err := DecodeCursor("")
	if err != nil {
		t.Fatalf("empty cursor must decode: %v", err)
	}
	if empty.ID != "" || !empty.TS.IsZero() {
		t.Fatalf("empty cursor should be zero value, got %+v", empty)
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"not-base64!!", "aGVsbG8", "eyJ0cyI6IngifQ"} {
		if _, err := DecodeCursor(bad); err == nil {
			t.Fatalf("DecodeCursor(%q) should fail", bad)
		}
	}
}

func TestCursorEncodeEmptyIsEmpty(t *testing.T) {
	if got := (Cursor{}).Encode(); got != "" {
		t.Fatalf("zero cursor should encode to empty string, got %q", got)
	}
}

// ---- 错误翻译：HTTP 状态码依赖它 ----

func TestWrapTranslatesErrors(t *testing.T) {
	if err := wrap(nil); err != nil {
		t.Fatalf("wrap(nil) = %v, want nil", err)
	}
	if err := wrap(pgxErrNoRows()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no rows should map to ErrNotFound, got %v", err)
	}
	// 唯一约束冲突（SQLSTATE 23505）→ ErrConflict
	uniqueErr := fmt.Errorf("insert: %w", pgError("23505"))
	if err := wrap(uniqueErr); !errors.Is(err, ErrConflict) {
		t.Fatalf("unique violation should map to ErrConflict, got %v", err)
	}
	// 其它错误原样返回（由 HTTP 层兜成 500），不能被误判成 404/409。
	other := errors.New("connection reset")
	if got := wrap(other); !errors.Is(got, other) {
		t.Fatalf("unrelated error must pass through, got %v", got)
	}
}

// ---- 可空字段助手 ----

func TestNullStr(t *testing.T) {
	if nullStr("") != nil || nullStr("   ") != nil {
		t.Fatal("blank strings must be NULL")
	}
	got := nullStr("hpf")
	if got == nil || *got != "hpf" {
		t.Fatalf("nullStr = %v", got)
	}
}

func TestJSONOrNull(t *testing.T) {
	if jsonOrNull(nil) != nil || jsonOrNull(json.RawMessage{}) != nil {
		t.Fatal("empty payloads must be NULL")
	}
	if got := jsonOrNull(json.RawMessage(`{"a":1}`)); string(got) != `{"a":1}` {
		t.Fatalf("jsonOrNull = %s", got)
	}
}

// ---- 同步载荷解析助手（服务端权威结果的字段抽取） ----

func TestPayloadHelpers(t *testing.T) {
	payload := []byte(`{"type":"highlight","color":"yellow","note":null,"locator":{"href":"c1.xhtml"}}`)

	if got := payloadString(payload, "type", "highlight"); got != "highlight" {
		t.Fatalf("payloadString = %q", got)
	}
	// 缺失字段 → 默认值
	if got := payloadString(payload, "missing", "fallback"); got != "fallback" {
		t.Fatalf("missing key should use default, got %q", got)
	}
	// 显式 null → 默认值（不是字符串 "null"）
	if got := payloadString(payload, "note", "fallback"); got != "fallback" {
		t.Fatalf("null value should use default, got %q", got)
	}
	if got := nullableString(payload, "color"); got == nil || *got != "yellow" {
		t.Fatalf("nullableString = %v", got)
	}
	if got := nullableString(payload, "note"); got != nil {
		t.Fatalf("explicit null should stay nil, got %v", *got)
	}
	raw := payloadRaw(payload, "locator")
	if string(raw) != `{"href":"c1.xhtml"}` {
		t.Fatalf("payloadRaw = %s", raw)
	}
	if payloadRaw(payload, "nope") != nil {
		t.Fatal("missing key must return nil")
	}
	// 非法 JSON 不能 panic。
	if payloadRaw([]byte("not json"), "x") != nil || nullableString([]byte("not json"), "x") != nil {
		t.Fatal("malformed payload must return nil, not panic")
	}
}

func TestMaxF(t *testing.T) {
	if maxF(0.3, 0.9) != 0.9 || maxF(0.9, 0.3) != 0.9 || maxF(0.5, 0.5) != 0.5 {
		t.Fatal("maxF is wrong")
	}
}

// pseudoHLC 必须与客户端 HLC 同构（同长度、同分隔符），否则字符串比较会出错。
func TestPseudoHLCShape(t *testing.T) {
	got := pseudoHLC(time.UnixMilli(1_700_000_000_000))
	// 13 位毫秒 + '-' + 8 位计数器 + '-' + 8 位设备前缀 = 31。
	// 必须与 sync.HLC 的宽度完全一致，否则字符串比较会得出错误的先后关系。
	if len(got) != 31 {
		t.Fatalf("pseudo HLC length = %d, want 31 (%q)", len(got), got)
	}
	if got[13] != '-' || got[22] != '-' {
		t.Fatalf("pseudo HLC separators missing: %q", got)
	}
	// 时间更大的输入必须产生字典序更大的输出。
	if !(pseudoHLC(time.UnixMilli(1000)) < pseudoHLC(time.UnixMilli(2000))) {
		t.Fatal("pseudo HLC must preserve time ordering")
	}
}

func TestBookIDOrNil(t *testing.T) {
	if bookIDOrNil(nil) != nil {
		t.Fatal("nil should stay nil")
	}
	empty := ""
	if bookIDOrNil(&empty) != nil {
		t.Fatal("empty string should become NULL")
	}
	id := "11111111-1111-4111-8111-111111111111"
	if got := bookIDOrNil(&id); got != id {
		t.Fatalf("bookIDOrNil = %v", got)
	}
}

func TestStrOrAndNullUUID(t *testing.T) {
	if strOr(nil, "def") != "def" {
		t.Fatal("nil should use default")
	}
	s := "v"
	if strOr(&s, "def") != "v" {
		t.Fatal("value should win")
	}
	if nullUUID("") != nil {
		t.Fatal("empty uuid should be NULL")
	}
	if got := nullUUID("abc"); got == nil || *got != "abc" {
		t.Fatalf("nullUUID = %v", got)
	}
}

func TestUserIsLocked(t *testing.T) {
	now := time.Now()
	past := now.Add(-time.Minute)
	future := now.Add(time.Minute)
	if (User{}).IsLocked(now) {
		t.Fatal("user without lock must not be locked")
	}
	if (User{LockedUntil: &past}).IsLocked(now) {
		t.Fatal("expired lock must not count")
	}
	if !(User{LockedUntil: &future}).IsLocked(now) {
		t.Fatal("active lock must count")
	}
}
