package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

const (
	bookA  = "11111111-1111-4111-8111-111111111111"
	hashV1 = "sha256:aaaa1111"
	hashV2 = "sha256:bbbb2222"
)

// ---- 幂等 ----

// 同一个 opId 重放：必须命中幂等表，不重复写 change_log，也不改变权威状态。
func TestPushIdempotentByOpID(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)

	op := progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.30, hashV1, false)
	first := seq(t, e, op)
	if first.AppliedCount() != 1 {
		t.Fatalf("first push applied = %d, want 1", first.AppliedCount())
	}
	if first.Cursor != 1 {
		t.Fatalf("first cursor = %d, want 1", first.Cursor)
	}

	second := seq(t, e, op)
	if second.AppliedCount() != 0 {
		t.Fatalf("replay applied = %d, want 0", second.AppliedCount())
	}
	if !second.Outcomes[0].Replayed {
		t.Fatal("replay should be marked as replayed")
	}
	if second.Cursor != 1 {
		t.Fatalf("cursor after replay = %d, want 1 (no new log row)", second.Cursor)
	}
	if n, _ := st.MaxCursor(context.Background(), "user-1"); n != 1 {
		t.Fatalf("change_log len = %d, want 1", n)
	}
	// 幂等重放不得改变进度值。
	got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression
	if got != 0.30 {
		t.Fatalf("progress after replay = %v, want 0.30", got)
	}
}

// 即使重放的 opId 携带不同的 payload，也必须复用首次结果（幂等键语义）。
func TestPushIdempotentIgnoresChangedPayload(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	hlc := makeHLC(1_700_000_000_000, 1, "devA0001")
	seq(t, e, progressOp("op-1", bookA, hlc, "devA", 0.30, hashV1, false))
	// 同一个 opId，内容被篡改（错误客户端行为）。
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_999, 9, "devA0001"), "devA", 0.99, hashV1, false))
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.30 {
		t.Fatalf("progress = %v, want 0.30 (first application wins)", got)
	}
}

// 被忽略（陈旧）的 op 也要落幂等记录，否则客户端会无限重试。
func TestIgnoredOpRecordedAsIdempotent(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-new", bookA, makeHLC(1_700_000_000_500, 1, "devA0001"), "devA", 0.50, hashV1, false))
	res := seq(t, e, progressOp("op-old", bookA, makeHLC(1_700_000_000_100, 1, "devA0001"), "devA", 0.10, hashV1, false))
	if res.Outcomes[0].Reason != ReasonOlderHLC {
		t.Fatalf("reason = %q, want %q", res.Outcomes[0].Reason, ReasonOlderHLC)
	}
	if _, ok, _ := st.LookupOp(context.Background(), "user-1", "op-old"); !ok {
		t.Fatal("ignored op must be recorded for idempotency")
	}
}

// ---- 同一 contentHash：HLC 裁决 + 允许显式回退 ----

func TestProgressSameContentHashNewerHLCWins(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.30, hashV1, false))
	res := seq(t, e, progressOp("op-2", bookA, makeHLC(1_700_000_000_100, 1, "devB0001"), "devB", 0.45, hashV1, false))
	if res.Outcomes[0].Status != StatusApplied {
		t.Fatalf("status = %q, want applied", res.Outcomes[0].Status)
	}
	p := stateOf(t, st, EntityProgress, bookA).Progress
	if p.TotalProgression != 0.45 {
		t.Fatalf("total = %v, want 0.45", p.TotalProgression)
	}
	if p.FurthestProgression != 0.45 {
		t.Fatalf("furthest = %v, want 0.45", p.FurthestProgression)
	}

	// 更旧的 HLC 不能覆盖。
	res = seq(t, e, progressOp("op-3", bookA, makeHLC(1_700_000_000_050, 5, "devA0001"), "devA", 0.20, hashV1, false))
	if res.Outcomes[0].Status != StatusIgnored || res.Outcomes[0].Reason != ReasonOlderHLC {
		t.Fatalf("stale write: status=%q reason=%q", res.Outcomes[0].Status, res.Outcomes[0].Reason)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.45 {
		t.Fatalf("stale write changed state to %v", got)
	}
}

// 同 HLC 时用 deviceId 字典序 tie-break，保证结果确定可复现。
func TestProgressSameHLCTieBreakByDevice(t *testing.T) {
	hlc := makeHLC(1_700_000_000_000, 1, "devX")
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, hlc, "devAAA", 0.30, hashV1, false))
	res := seq(t, e, progressOp("op-2", bookA, hlc, "devZZZ", 0.60, hashV1, false))
	if res.Outcomes[0].Status != StatusApplied {
		t.Fatalf("larger deviceId should win on tie, got %q", res.Outcomes[0].Status)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.60 {
		t.Fatalf("total = %v, want 0.60", got)
	}
	// 反向再来一次必须稳定（不被小 deviceId 改回）。
	res = seq(t, e, progressOp("op-3", bookA, hlc, "devAAA", 0.30, hashV1, false))
	if res.Outcomes[0].Status != StatusIgnored {
		t.Fatalf("smaller deviceId should not win on tie, got %q", res.Outcomes[0].Status)
	}
}

// ---- 跨 contentHash：只允许单调前进（epsilon 0.002） ----

func TestProgressCrossReplicaMonotonicForwardOnly(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.40, hashV1, false))

	// 另一副本读到 0.60：前进，接受。
	res := seq(t, e, progressOp("op-2", bookA, makeHLC(1_700_000_000_100, 1, "devB0001"), "devB", 0.60, hashV2, false))
	if res.Outcomes[0].Status != StatusApplied || res.Outcomes[0].Reason != ReasonForwardOnly {
		t.Fatalf("forward move: status=%q reason=%q, want applied/%s", res.Outcomes[0].Status, res.Outcomes[0].Reason, ReasonForwardOnly)
	}
	p := stateOf(t, st, EntityProgress, bookA).Progress
	if p.TotalProgression != 0.60 || p.ContentHash != hashV2 {
		t.Fatalf("state = %+v", p)
	}

	// 另一副本 HLC 更新但进度更低：必须被拒绝（CFI 不可比，禁止回退）。
	res = seq(t, e, progressOp("op-3", bookA, makeHLC(1_700_000_000_900, 1, "devC0001"), "devC", 0.10, hashV1, false))
	if res.Outcomes[0].Status != StatusIgnored || res.Outcomes[0].Reason != ReasonStaleRewrite {
		t.Fatalf("backward cross-replica: status=%q reason=%q, want ignored/%s", res.Outcomes[0].Status, res.Outcomes[0].Reason, ReasonStaleRewrite)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.60 {
		t.Fatalf("backward write changed state to %v", got)
	}
}

// epsilon 之内视为噪声，不允许回退（避免 0.420/0.4201 抖动）。
func TestProgressCrossReplicaEpsilonNoise(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.5000, hashV1, false))
	res := seq(t, e, progressOp("op-2", bookA, makeHLC(1_700_000_000_100, 1, "devB0001"), "devB", 0.5015, hashV2, false))
	if res.Outcomes[0].Status != StatusIgnored {
		t.Fatalf("delta 0.0015 <= epsilon should be ignored, got %q", res.Outcomes[0].Status)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.5 {
		t.Fatalf("total = %v, want 0.5", got)
	}
	// 超过 epsilon 一点点就应该前进。
	res = seq(t, e, progressOp("op-3", bookA, makeHLC(1_700_000_000_200, 1, "devB0001"), "devB", 0.5025, hashV2, false))
	if res.Outcomes[0].Status != StatusApplied {
		t.Fatalf("delta 0.0025 > epsilon should apply, got %q", res.Outcomes[0].Status)
	}
}

// ---- 回滚不覆盖最远位置（核心不变量） ----

func TestRewindDoesNotOverwriteFurthest(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.80, hashV1, false))

	// 用户在同一副本上主动回退到 0.20。
	res := seq(t, e, progressOp("op-2", bookA, makeHLC(1_700_000_000_100, 1, "devA0001"), "devA", 0.20, hashV1, true))
	if res.Outcomes[0].Status != StatusApplied {
		t.Fatalf("explicit rewind should apply on same replica, got %q (%s)", res.Outcomes[0].Status, res.Outcomes[0].Reason)
	}
	p := stateOf(t, st, EntityProgress, bookA).Progress
	if p.TotalProgression != 0.20 {
		t.Fatalf("current = %v, want 0.20", p.TotalProgression)
	}
	if !p.ExplicitRewind {
		t.Fatal("explicitRewind flag lost")
	}
	if p.FurthestProgression != 0.80 {
		t.Fatalf("furthest = %v, want 0.80 (must not regress)", p.FurthestProgression)
	}

	// 另一设备随后上报它的最远位置 0.75（跨副本）：因为 0.75 <= furthest 0.80，必须被忽略，
	// 这样「用户主动回退」不会被别的设备悄悄拉回去。
	res = seq(t, e, progressOp("op-3", bookA, makeHLC(1_700_000_000_500, 1, "devB0001"), "devB", 0.75, hashV2, false))
	if res.Outcomes[0].Status != StatusIgnored {
		t.Fatalf("cross-replica 0.75 must not beat furthest 0.80, got %q", res.Outcomes[0].Status)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.20 {
		t.Fatalf("rewind was overwritten: %v", got)
	}
}

// 跨副本显式回退允许后退（用户手动拖动进度条）。
func TestCrossReplicaExplicitRewindAllowed(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	seq(t, e, progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.60, hashV1, false))
	res := seq(t, e, progressOp("op-2", bookA, makeHLC(1_700_000_000_100, 1, "devB0001"), "devB", 0.25, hashV2, true))
	if res.Outcomes[0].Status != StatusApplied || res.Outcomes[0].Reason != ReasonExplicitRewind {
		t.Fatalf("status=%q reason=%q", res.Outcomes[0].Status, res.Outcomes[0].Reason)
	}
	p := stateOf(t, st, EntityProgress, bookA).Progress
	if p.TotalProgression != 0.25 || p.FurthestProgression != 0.60 {
		t.Fatalf("state = %+v", p)
	}
}

// ---- 墓碑：remove-wins ----

func TestAnnotationRemoveWins(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	annID := "aaaaaaaa-1111-4111-8111-111111111111"
	seq(t, e, annotationOp("op-1", annID, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", "yellow"))
	seq(t, e, deleteOp("op-2", EntityAnnotation, annID, makeHLC(1_700_000_000_100, 1, "devA0001"), "devA"))

	if !stateOf(t, st, EntityAnnotation, annID).Deleted {
		t.Fatal("annotation should be tombstoned")
	}
	// 慢设备用更新的 HLC 想把标注写回来 → remove-wins，必须失败。
	res := seq(t, e, annotationOp("op-3", annID, makeHLC(1_700_000_000_200, 1, "devB0001"), "devB", "red"))
	if res.Outcomes[0].Status != StatusIgnored || res.Outcomes[0].Reason != ReasonTombstone {
		t.Fatalf("resurrect: status=%q reason=%q, want ignored/%s", res.Outcomes[0].Status, res.Outcomes[0].Reason, ReasonTombstone)
	}
	if !stateOf(t, st, EntityAnnotation, annID).Deleted {
		t.Fatal("tombstone was resurrected")
	}
}

// 墓碑窗口过期后允许重新创建同 ID 实体（重新导入场景兜底）。
func TestAnnotationTombstoneExpiresAfterWindow(t *testing.T) {
	now := int64(1_700_000_000_000)
	// 墓碑 31 天前写入。
	tombNanos := time.UnixMilli(now - 31*24*3600*1000).UnixNano()
	ok, _ := ShouldApplyAnnotation(makeHLC(now-31*24*3600*1000, 1, "devA0001"), tombNanos, makeHLC(now, 1, "devB0001"), time.UnixMilli(now).UnixNano())
	if !ok {
		t.Fatal("stale tombstone should allow re-creation after the retention window")
	}
	// 窗口内则拒绝。
	tombNanos = time.UnixMilli(now - 1000).UnixNano()
	ok, reason := ShouldApplyAnnotation(makeHLC(now-1000, 1, "devA0001"), tombNanos, makeHLC(now, 1, "devB0001"), time.UnixMilli(now).UnixNano())
	if ok || reason != ReasonTombstone {
		t.Fatalf("fresh tombstone must win, got ok=%v reason=%q", ok, reason)
	}
}

// 标注字段级 LWW：逐字段比较 HLC，较新者胜。
func TestAnnotationFieldLevelLWW(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	annID := "bbbbbbbb-1111-4111-8111-111111111111"
	seq(t, e, annotationOp("op-1", annID, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", "yellow"))
	// 更新的 HLC 改颜色。
	seq(t, e, annotationOp("op-2", annID, makeHLC(1_700_000_000_100, 1, "devB0001"), "devB", "green"))
	// 更旧的 HLC 改颜色 → 忽略。
	res := seq(t, e, annotationOp("op-3", annID, makeHLC(1_700_000_000_050, 1, "devC0001"), "devC", "blue"))
	if res.Outcomes[0].Status != StatusIgnored {
		t.Fatalf("older annotation write should be ignored, got %q", res.Outcomes[0].Status)
	}
	var payload map[string]any
	if err := json.Unmarshal(stateOf(t, st, EntityAnnotation, annID).Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload["color"] != "green" {
		t.Fatalf("color = %v, want green", payload["color"])
	}
}

// ---- 游标单调 ----

func TestCursorIsMonotonicAndServerAssigned(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	book2 := "22222222-2222-4222-8222-222222222222"
	book3 := "33333333-3333-4333-8333-333333333333"
	r1 := seq(t, e,
		progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.1, hashV1, false),
		progressOp("op-2", book2, makeHLC(1_700_000_000_000, 2, "devA0001"), "devA", 0.2, hashV1, false),
	)
	if r1.Cursor != 2 {
		t.Fatalf("cursor = %d, want 2", r1.Cursor)
	}
	// 被忽略的 op 不占用游标。
	r2 := seq(t, e, progressOp("op-3", bookA, makeHLC(1_699_999_999_000, 1, "devA0001"), "devA", 0.05, hashV1, false))
	if r2.Cursor != 2 {
		t.Fatalf("cursor after ignored op = %d, want 2", r2.Cursor)
	}
	r3 := seq(t, e, progressOp("op-4", book3, makeHLC(1_700_000_000_300, 1, "devA0001"), "devA", 0.3, hashV1, false))
	if r3.Cursor != 3 {
		t.Fatalf("cursor = %d, want 3", r3.Cursor)
	}
}

func TestPullPagingWithHasMore(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	ops := make([]Op, 0, 5)
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("4444444%d-4444-4444-8444-444444444444", i)
		ops = append(ops, progressOp(fmt.Sprintf("op-%d", i), id, makeHLC(1_700_000_000_000+int64(i), 1, "devA0001"), "devA", float64(i+1)/10, hashV1, false))
	}
	seq(t, e, ops...)

	page1, err := e.Pull(context.Background(), "user-1", 0, 2)
	if err != nil {
		t.Fatalf("Pull: %v", err)
	}
	if len(page1.Changes) != 2 || !page1.HasMore || page1.NextCursor != 2 {
		t.Fatalf("page1 = %+v", page1)
	}
	page2, _ := e.Pull(context.Background(), "user-1", page1.NextCursor, 2)
	if len(page2.Changes) != 2 || page2.NextCursor != 4 {
		t.Fatalf("page2 = %+v", page2)
	}
	page3, _ := e.Pull(context.Background(), "user-1", page2.NextCursor, 2)
	if len(page3.Changes) != 1 || page3.HasMore {
		t.Fatalf("page3 = %+v", page3)
	}
	// 幂等拉取：同一游标重复拉取结果一致。
	again, _ := e.Pull(context.Background(), "user-1", 0, 2)
	if len(again.Changes) != 2 || again.Changes[0].Cursor != page1.Changes[0].Cursor {
		t.Fatalf("pull is not stable: %+v vs %+v", again, page1)
	}
}

// ---- 多设备乱序收敛（属性测试风格） ----

// 三台设备以任意顺序推送同一本书的进度，最终所有设备看到的状态必须一致。
func TestMultiDeviceOutOfOrderConvergence(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	base := int64(1_700_000_000_000)

	type ev struct {
		op Op
	}
	events := []ev{
		{progressOp("op-1", bookA, makeHLC(base+10, 1, "devA0001"), "devA", 0.10, hashV1, false)},
		{progressOp("op-2", bookA, makeHLC(base+90, 1, "devB0001"), "devB", 0.90, hashV1, false)},
		{progressOp("op-3", bookA, makeHLC(base+50, 1, "devC0001"), "devC", 0.50, hashV1, false)},
		{progressOp("op-4", bookA, makeHLC(base+70, 1, "devA0001"), "devA", 0.70, hashV2, false)},
		{annotationOp("op-5", "cccccccc-1111-4111-8111-111111111111", makeHLC(base+30, 1, "devA0001"), "devA", "yellow")},
		{annotationOp("op-6", "cccccccc-1111-4111-8111-111111111111", makeHLC(base+80, 1, "devB0001"), "devB", "green")},
	}
	// 乱序：先推后发生的，再推先发生的，再重复推。
	order := []int{1, 3, 0, 5, 2, 4, 5, 3, 1}
	for _, i := range order {
		seq(t, e, events[i].op)
	}

	// 权威状态：progress 应为 HLC 最大的 0.90（同副本 hashV1），annotation 颜色为绿色。
	p := stateOf(t, st, EntityProgress, bookA).Progress
	if p.TotalProgression != 0.90 {
		t.Fatalf("converged progress = %v, want 0.90", p.TotalProgression)
	}
	if p.FurthestProgression != 0.90 {
		t.Fatalf("furthest = %v, want 0.90", p.FurthestProgression)
	}
	var ann map[string]any
	_ = json.Unmarshal(stateOf(t, st, EntityAnnotation, "cccccccc-1111-4111-8111-111111111111").Payload, &ann)
	if ann["color"] != "green" {
		t.Fatalf("annotation color = %v, want green", ann["color"])
	}

	// 重新推送全部事件（模拟离线设备重放）：状态必须完全不变。
	before := stateOf(t, st, EntityProgress, bookA).Progress.HLC
	for _, ev := range events {
		seq(t, e, ev.op)
	}
	after := stateOf(t, st, EntityProgress, bookA).Progress.HLC
	if before != after {
		t.Fatalf("replay changed HLC: %s -> %s", before, after)
	}
	if got := stateOf(t, st, EntityProgress, bookA).Progress.TotalProgression; got != 0.90 {
		t.Fatalf("replay changed progress: %v", got)
	}
}

// ---- 边界与校验 ----

func TestPushRejectsInvalidOps(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	res := seq(t, e,
		Op{OpID: "op-1", Entity: "bogus", EntityID: bookA, Kind: KindUpsert, HLC: makeHLC(1, 1, "devA0001")},
		Op{OpID: "op-2", Entity: EntityProgress, EntityID: bookA, Kind: "nope", HLC: makeHLC(1, 1, "devA0001")},
		Op{OpID: "op-3", Entity: EntityProgress, EntityID: bookA, Kind: KindUpsert, HLC: "not-an-hlc"},
	)
	for i, o := range res.Outcomes {
		if o.Status == StatusApplied {
			t.Fatalf("outcome %d should not be applied: %+v", i, o)
		}
	}
	if res.Cursor != 0 {
		t.Fatalf("cursor = %d, want 0", res.Cursor)
	}
}

func TestPushRejectsTooManyOps(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	ops := make([]Op, 0, MaxOpsPerPush+1)
	for i := 0; i <= MaxOpsPerPush; i++ {
		ops = append(ops, progressOp(fmt.Sprintf("op-%d", i), bookA, makeHLC(1, 1, "devA0001"), "devA", 0.1, hashV1, false))
	}
	if _, err := e.Push(context.Background(), "user-1", "devA", ops); err == nil {
		t.Fatal("expected error for too many ops")
	}
}

func TestSnapshotExcludesTombstones(t *testing.T) {
	st := newMemStore()
	e := testEngine(t, st, "devA", 1_700_000_000_000)
	bookB := "55555555-5555-4555-8555-555555555555"
	annID := "dddddddd-1111-4111-8111-111111111111"
	seq(t, e,
		progressOp("op-1", bookA, makeHLC(1_700_000_000_000, 1, "devA0001"), "devA", 0.3, hashV1, false),
		annotationOp("op-2", annID, makeHLC(1_700_000_000_000, 2, "devA0001"), "devA", "yellow"),
		deleteOp("op-3", EntityAnnotation, annID, makeHLC(1_700_000_000_100, 1, "devA0001"), "devA"),
		progressOp("op-4", bookB, makeHLC(1_700_000_000_200, 1, "devA0001"), "devA", 0.9, hashV1, false),
	)
	proj, err := e.Snapshot(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	// 4 条 op 全部 applied（删除也是一条变更，占用一个游标），快照游标应对齐到最新。
	if proj.Cursor != 4 {
		t.Fatalf("snapshot cursor = %d, want 4", proj.Cursor)
	}
	if len(proj.Progress) != 2 {
		t.Fatalf("progress rows = %d, want 2", len(proj.Progress))
	}
	if len(proj.Annotations) != 0 {
		t.Fatalf("annotations = %d, want 0 (tombstoned)", len(proj.Annotations))
	}
}
