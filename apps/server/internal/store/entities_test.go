package store

import (
	"encoding/json"
	"testing"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/corrections"
)

// TestRebuildEntitiesPreservesUserMergeAcrossRerun 是**本轮最关键的端到端测试**。
//
// 它验证 M5-4 的核心承诺：**用户的工作在重跑后不丢**。
//
// 场景：
//  1. 自动聚类把 "darcy" 和 "mr darcy" 当成两个人；
//  2. 用户 merge 了它们（写进 book_correction）；
//  3. 自动流水线重跑（分组又回到两个人）；
//  4. 重放日志后，用户的 merge 必须仍然生效。
//
// 这条如果不通过，「存日志不存结果」的设计就是空话。
func TestRebuildEntitiesPreservesUserMergeAcrossRerun(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	// 用户 merge。
	if _, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpMerge,
		json.RawMessage(`{"keyA":"darcy","keyB":"mr darcy"}`)); err != nil {
		t.Fatalf("append merge: %v", err)
	}

	// 第一轮自动分组：两个独立组。
	auto := [][]string{{"darcy"}, {"mr darcy"}, {"elizabeth"}}
	r1, err := s.RebuildEntities(ctx, user, bookID, auto)
	if err != nil {
		t.Fatalf("rebuild 1: %v", err)
	}
	if !replayGroupHas(r1, "darcy", "mr darcy") {
		t.Fatalf("第一轮：用户 merge 未生效: %+v", r1.Entities)
	}
	ents, err := s.ListEntities(ctx, bookID)
	if err != nil {
		t.Fatalf("list entities: %v", err)
	}
	if !entityHasMembers(ents, "darcy", "mr darcy") {
		t.Fatalf("第一轮落库：darcy 与 mr darcy 应在一个实体里: %+v", ents)
	}

	// 第二轮：自动流水线重跑，**分组回到原始状态**。
	r2, err := s.RebuildEntities(ctx, user, bookID, auto)
	if err != nil {
		t.Fatalf("rebuild 2: %v", err)
	}
	if !replayGroupHas(r2, "darcy", "mr darcy") {
		t.Fatalf("**重跑后用户的 merge 被冲掉了**！%+v", r2.Entities)
	}
	ents2, err := s.ListEntities(ctx, bookID)
	if err != nil {
		t.Fatalf("list entities 2: %v", err)
	}
	if !entityHasMembers(ents2, "darcy", "mr darcy") {
		t.Fatalf("重跑落库后用户 merge 丢失: %+v", ents2)
	}
}

// TestRebuildEntitiesSplitSurvivesRerun 锁定**防重跑回退**。
//
// 用户拆开的两组，重跑时自动流水线又想合并——负样本对必须挡住。
// 没有这一条，用户拆完重跑又合回去，体验是灾难性的。
func TestRebuildEntitiesSplitSurvivesRerun(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	if _, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpSplit,
		json.RawMessage(`{"key":"zhang","from":"li"}`)); err != nil {
		t.Fatalf("append split: %v", err)
	}

	// 自动流水线坚持把它们当一组。
	auto := [][]string{{"zhang", "li"}, {"darcy"}}
	r, err := s.RebuildEntities(ctx, user, bookID, auto)
	if err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if replayGroupHas(r, "zhang", "li") {
		t.Fatalf("重跑把用户拆开的又合回去了: %+v", r.Entities)
	}

	// 负样本对必须落库，否则**下一次**重跑又会合回去。
	pairs, err := s.ListBlockedPairs(ctx, bookID)
	if err != nil {
		t.Fatalf("list blocked: %v", err)
	}
	if len(pairs) == 0 {
		t.Fatalf("split 未产生负样本对，下次重跑会回退")
	}
}

// TestRebuildEntitiesIsIdempotent 锁定重跑幂等。
//
// 同一批输入重跑两次，实体表内容必须完全一致。
// 否则每次重跑用户都会看到实体列表跳变。
func TestRebuildEntitiesIsIdempotent(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	if _, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpMerge,
		json.RawMessage(`{"keyA":"elizabeth","keyB":"lizzy"}`)); err != nil {
		t.Fatalf("append merge: %v", err)
	}
	if _, err := s.AppendCorrection(ctx, user, bookID, 2, corrections.OpRename,
		json.RawMessage(`{"key":"elizabeth","name":"伊丽莎白"}`)); err != nil {
		t.Fatalf("append rename: %v", err)
	}

	auto := [][]string{{"elizabeth"}, {"darcy"}}
	if _, err := s.RebuildEntities(ctx, user, bookID, auto); err != nil {
		t.Fatalf("rebuild 1: %v", err)
	}
	e1, err := s.ListEntities(ctx, bookID)
	if err != nil {
		t.Fatalf("list 1: %v", err)
	}
	if _, err := s.RebuildEntities(ctx, user, bookID, auto); err != nil {
		t.Fatalf("rebuild 2: %v", err)
	}
	e2, err := s.ListEntities(ctx, bookID)
	if err != nil {
		t.Fatalf("list 2: %v", err)
	}

	if len(e1) != len(e2) {
		t.Fatalf("两次重跑实体数不同: %d vs %d", len(e1), len(e2))
	}
	for i := range e1 {
		if e1[i].Canonical != e2[i].Canonical {
			t.Errorf("第 %d 个实体 canonical 不同: %q vs %q", i, e1[i].Canonical, e2[i].Canonical)
		}
		if len(e1[i].Members) != len(e2[i].Members) {
			t.Errorf("第 %d 个实体成员数不同", i)
		}
	}
	// rename 必须生效。
	found := false
	for _, e := range e1 {
		if e.Canonical == "伊丽莎白" {
			found = true
		}
	}
	if !found {
		t.Errorf("rename 未生效: %+v", e1)
	}
}

// TestEntitiesIsolatedBetweenUsers 锁定实体表的多用户隔离。
func TestEntitiesIsolatedBetweenUsers(t *testing.T) {
	s, ctx := testStore(t)
	userA, bookA := correctionFixture(t, s, ctx)
	_, bookB := correctionFixture(t, s, ctx)

	if _, err := s.RebuildEntities(ctx, userA, bookA, [][]string{{"darcy"}, {"elizabeth"}}); err != nil {
		t.Fatalf("rebuild A: %v", err)
	}
	eB, err := s.ListEntities(ctx, bookB)
	if err != nil {
		t.Fatalf("list B: %v", err)
	}
	if len(eB) != 0 {
		t.Fatalf("用户 B 读到了 %d 个别的书的实体（隔离失效）", len(eB))
	}
}

// ---- helpers ----

func replayGroupHas(r corrections.ReplayResult, a, b string) bool {
	for _, e := range r.Entities {
		if strInSlice(e.Members, a) && strInSlice(e.Members, b) {
			return true
		}
	}
	return false
}

func entityHasMembers(ents []Entity, a, b string) bool {
	for _, e := range ents {
		var keys []string
		for _, m := range e.Members {
			keys = append(keys, m.NormKey)
		}
		if strInSlice(keys, a) && strInSlice(keys, b) {
			return true
		}
	}
	return false
}

func strInSlice(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
