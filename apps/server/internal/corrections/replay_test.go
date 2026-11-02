package corrections

import (
	"encoding/json"
	"testing"
)

func mustPayload(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return b
}

// TestReplayMergeKeepsUserWork 是**本轮最重要的测试**：用户 merge 后重跑，分组不被冲掉。
//
// 场景：自动流水线跑出 {darcy} 与 {mr darcy} 两组（把它俩当成两个人）；
// 用户知道这是同一人，merge 了它们；然后自动流水线**重跑**（输入变了，分组又回到两组）。
// 重放日志后，用户的工作必须还在。
//
// 这条如果不通过，「存日志不存结果」的设计就是空话——
// 而这正是 M5-4 的核心承诺。
func TestReplayMergeKeepsUserWork(t *testing.T) {
	// 第一轮自动分组：把 mr darcy 和 darcy 当成两个人。
	autoRound1 := [][]string{
		{"darcy"},
		{"mr darcy"},
		{"elizabeth"},
	}
	// 用户 merge。
	events := []Event{
		{Seq: 1, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "darcy", KeyB: "mr darcy"})},
	}

	r1, err := Replay(autoRound1, events)
	if err != nil {
		t.Fatalf("replay round1: %v", err)
	}
	if len(r1.Entities) != 2 {
		t.Fatalf("用户 merge 后应剩 2 组，实际 %d: %+v", len(r1.Entities), r1.Entities)
	}
	if !groupHas(r1.Entities, "darcy", "mr darcy") {
		t.Fatalf("darcy 与 mr darcy 未被合并: %+v", r1.Entities)
	}

	// 第二轮：自动流水线重跑，**分组回到了原始状态**（模拟换了模型/重跑）。
	autoRound2 := [][]string{
		{"darcy"},
		{"mr darcy"},
		{"elizabeth"},
		{"fitzwilliam darcy"}, // 新模型这次多抽出一个全名
	}
	r2, err := Replay(autoRound2, events)
	if err != nil {
		t.Fatalf("replay round2: %v", err)
	}
	// 用户的 merge 必须仍然生效。
	if !groupHas(r2.Entities, "darcy", "mr darcy") {
		t.Fatalf("重跑后用户的 merge 被冲掉了！分组: %+v", r2.Entities)
	}
	// fitzwilliam darcy 在本轮自动分组里是独立一组，**不应**被并进来；
	// 要合并它必须靠子串规则（normalize 包负责）或用户再 merge 一次。
	// 这里断言的是「重放不越权」：日志没写的事，重放不能自己决定。
	if groupHas(r2.Entities, "darcy", "fitzwilliam darcy") {
		t.Errorf("重放不应自行合并日志未涉及的分组: %+v", r2.Entities)
	}
}

// TestReplaySplitBlocksFutureMerge 是**防重跑回退**测试。
//
// 场景：自动流水线把 A 和 B 合并了，用户知道这是两个人，拆开；
// 然后自动流水线重跑，**又想把它俩合并**。
// 负样本对必须阻止这次合并，否则用户拆完重跑又合回去，体验是灾难性的。
func TestReplaySplitBlocksFutureMerge(t *testing.T) {
	// 用户拆开：zhang 不属于 li 那一组。
	splitEv := Event{Seq: 1, Op: OpSplit, Payload: mustPayload(t, SplitPayload{Key: "zhang", From: "li"})}

	// 重跑时自动流水线又把它们并到一组。
	autoRound2 := [][]string{{"zhang", "li"}}
	r, err := Replay(autoRound2, []Event{splitEv})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if groupHas(r.Entities, "zhang", "li") {
		t.Fatalf("重跑后把用户拆开的又合回去了！分组: %+v", r.Entities)
	}
	if len(r.BlockedPairs) == 0 {
		t.Fatalf("split 应产生负样本对，实际没有")
	}
}

// TestReplayIdempotent 锁定**重放幂等**：同一日志重放两次结果完全一致。
//
// 这是「可重放」这一设计成立的判据。若重放不幂等，
// 每次重跑都会得到不同分组，用户看到的实体列表会跳来跳去。
func TestReplayIdempotent(t *testing.T) {
	auto := [][]string{
		{"darcy", "mr darcy"},
		{"elizabeth"},
		{"zhang", "li"},
	}
	events := []Event{
		{Seq: 1, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "elizabeth", KeyB: "lizzy"})},
		{Seq: 2, Op: OpSplit, Payload: mustPayload(t, SplitPayload{Key: "zhang", From: "li"})},
		{Seq: 3, Op: OpRename, Payload: mustPayload(t, RenamePayload{Key: "darcy", Name: "Fitzwilliam Darcy"})},
	}

	first, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("first replay: %v", err)
	}
	second, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("second replay: %v", err)
	}

	if !equalResults(first, second) {
		t.Fatalf("重放不幂等:\n  第一次: %+v\n  第二次: %+v", first, second)
	}
}

// TestReplaySplitAfterMerge 锁定重放顺序：split 必须晚于 merge。
//
// 「先合后拆」时用户要的是拆。若顺序颠倒，merge 会覆盖 split，用户意图丢失。
func TestReplaySplitAfterMerge(t *testing.T) {
	auto := [][]string{{"a"}, {"b"}}
	events := []Event{
		{Seq: 1, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "a", KeyB: "b"})},
		{Seq: 2, Op: OpSplit, Payload: mustPayload(t, SplitPayload{Key: "b", From: "a"})},
	}
	r, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if groupHas(r.Entities, "a", "b") {
		t.Fatalf("split 应晚于 merge 生效（用户要的是拆），实际仍在一组: %+v", r.Entities)
	}
}

// TestReplayRenameOverridesCanonical 锁定 rename 语义。
func TestReplayRenameOverridesCanonical(t *testing.T) {
	auto := [][]string{{"darcy", "mr darcy"}}
	events := []Event{
		{Seq: 1, Op: OpRename, Payload: mustPayload(t, RenamePayload{Key: "darcy", Name: "达西先生"})},
	}
	r, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(r.Entities) != 1 {
		t.Fatalf("应 1 组，实际 %d", len(r.Entities))
	}
	if r.Entities[0].Canonical != "达西先生" {
		t.Errorf("rename 未覆盖 canonical，实际 %q", r.Entities[0].Canonical)
	}
}

// TestReplayLockFreezesEntity 锁定 lock 语义。
func TestReplayLockFreezesEntity(t *testing.T) {
	auto := [][]string{{"darcy", "mr darcy"}}
	events := []Event{
		{Seq: 1, Op: OpLock, Payload: mustPayload(t, LockPayload{Key: "darcy"})},
	}
	r, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(r.Entities) != 1 || !r.Entities[0].Locked {
		t.Fatalf("lock 未生效: %+v", r.Entities)
	}
}

// TestReplayAliasAddJoinsGroup 锁定 alias_add 语义。
func TestReplayAliasAddJoinsGroup(t *testing.T) {
	auto := [][]string{{"darcy"}}
	events := []Event{
		{Seq: 1, Op: OpAliasAdd, Payload: mustPayload(t, AliasAddPayload{Key: "darcy", Alias: "mr darcy"})},
	}
	r, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !groupHas(r.Entities, "darcy", "mr darcy") {
		t.Fatalf("alias_add 未把别名并入: %+v", r.Entities)
	}
}

// TestReplaySkippedOnBlockedMerge 锁定「负样本优先于 merge」这一安全规则。
//
// 用户可能先拆后误操作合并。此时应尊重「拆」的意图，
// 而不是让后一条 merge 把负样本推翻——否则负样本形同虚设。
func TestReplaySkippedOnBlockedMerge(t *testing.T) {
	auto := [][]string{{"zhang"}, {"li"}}
	events := []Event{
		{Seq: 1, Op: OpSplit, Payload: mustPayload(t, SplitPayload{Key: "zhang", From: "li"})},
		{Seq: 2, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "zhang", KeyB: "li"})},
	}
	r, err := Replay(auto, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if groupHas(r.Entities, "zhang", "li") {
		t.Fatalf("负样本对之后的 merge 应被跳过，实际合并了: %+v", r.Entities)
	}
	if r.Skipped == 0 {
		t.Errorf("被负样本挡下的 merge 应计入 Skipped，实际 0")
	}
}

// TestReplayInvalidEventsSkipped 锁定防御：坏事件不阻塞整个重放。
//
// 一条拼错的事件若让整个重放报错，用户的所有修正都会失效——
// 宁可跳过单条，也不能让日志里一个脏数据毁掉全部工作。
func TestReplayInvalidEventsSkipped(t *testing.T) {
	events := []Event{
		{Seq: 1, Op: Op("bogus"), Payload: json.RawMessage(`{}`)},
		{Seq: 2, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "", KeyB: "x"})},
		{Seq: 3, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "a", KeyB: "b"})},
	}
	r, err := Replay([][]string{{"a"}, {"b"}}, events)
	if err != nil {
		t.Fatalf("坏事件不应让重放整体失败: %v", err)
	}
	if r.Applied != 1 {
		t.Errorf("应只有 1 条生效，实际 %d", r.Applied)
	}
	if r.Skipped != 2 {
		t.Errorf("应跳过 2 条，实际 %d", r.Skipped)
	}
	if !groupHas(r.Entities, "a", "b") {
		t.Errorf("有效事件未生效: %+v", r.Entities)
	}
}

// TestReplayEventsAppliedInSeqOrder 锁定「按 seq 而非时间戳排序」。
//
// 时钟回拨会让时间戳排序错乱，seq 不会。这里传入乱序的事件，
// 重放必须按 seq 得到正确结果。
func TestReplayEventsAppliedInSeqOrder(t *testing.T) {
	// seq=2 的 split 在切片里排在 seq=1 的 merge 之前。
	events := []Event{
		{Seq: 2, Op: OpSplit, Payload: mustPayload(t, SplitPayload{Key: "b", From: "a"})},
		{Seq: 1, Op: OpMerge, Payload: mustPayload(t, MergePayload{KeyA: "a", KeyB: "b"})},
	}
	r, err := Replay([][]string{{"a"}, {"b"}}, events)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	// 按 seq 顺序：先 merge（合），后 split（拆），最终应分开。
	if groupHas(r.Entities, "a", "b") {
		t.Fatalf("未按 seq 排序，最终仍合并: %+v", r.Entities)
	}
}

// TestReplayEmptyInputs 锁定边界。
func TestReplayEmptyInputs(t *testing.T) {
	r, err := Replay(nil, nil)
	if err != nil {
		t.Fatalf("replay empty: %v", err)
	}
	if len(r.Entities) != 0 {
		t.Errorf("空输入应得空结果，实际 %d 组", len(r.Entities))
	}
}

// ---- helpers ----

// groupHas 判断 a 与 b 是否在同一个实体里。
func groupHas(ents []Entity, a, b string) bool {
	for _, e := range ents {
		if containsStr(e.Members, a) && containsStr(e.Members, b) {
			return true
		}
	}
	return false
}

// equalResults 深度比较两次重放结果（用于幂等断言）。
func equalResults(a, b ReplayResult) bool {
	if len(a.Entities) != len(b.Entities) || len(a.BlockedPairs) != len(b.BlockedPairs) {
		return false
	}
	if a.Applied != b.Applied || a.Skipped != b.Skipped {
		return false
	}
	for i := range a.Entities {
		ea, eb := a.Entities[i], b.Entities[i]
		if ea.Canonical != eb.Canonical || ea.Locked != eb.Locked || ea.FromUser != eb.FromUser {
			return false
		}
		if len(ea.Members) != len(eb.Members) {
			return false
		}
		for j := range ea.Members {
			if ea.Members[j] != eb.Members[j] {
				return false
			}
		}
	}
	for i := range a.BlockedPairs {
		if a.BlockedPairs[i] != b.BlockedPairs[i] {
			return false
		}
	}
	return true
}
