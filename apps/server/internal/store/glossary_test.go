package store

import (
	"context"
	"testing"
)

// TestGlossaryUserConfirmedSurvivesRerun 是**本轮最重要的术语表测试**。
//
// 场景：用户手工把 darcy 译成「达西先生」并确认；
// 随后自动流水线重跑，用 LLM 抽取出「达西」这个译名想覆盖它。
//
// **用户的值必须保留**。理由不是精度，而是信任：
// 用户改了半天的译名若被重跑冲掉，用户会认为这功能不可靠——
// 这比「译名不够准」严重得多。
func TestGlossaryUserConfirmedSurvivesRerun(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	// 用户确认。
	g, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Mr. Darcy", Target: "达西先生", Source: TermUserConfirmed},
	})
	if err != nil {
		t.Fatalf("put user term: %v", err)
	}
	if len(g.Terms) != 1 || g.Terms[0].Target != "达西先生" {
		t.Fatalf("用户术语未写入: %+v", g.Terms)
	}

	// 自动流水线重跑，试图用 LLM 结果覆盖。
	g2, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Mr. Darcy", Target: "达西", Source: TermLLMExtracted},
	})
	if err != nil {
		t.Fatalf("put llm term: %v", err)
	}
	if g2.Terms[0].Target != "达西先生" {
		t.Fatalf("用户确认的译名被自动流水线覆盖了！实际 %q，应为 %q",
			g2.Terms[0].Target, "达西先生")
	}
	if g2.Terms[0].Source != TermUserConfirmed {
		t.Errorf("来源应保持 user_confirmed，实际 %q", g2.Terms[0].Source)
	}
}

// TestGlossaryUserCanOverrideOwnConfirmed 锁定：用户改主意是允许的。
//
// 优先级规则的目的是「自动流水线不得覆盖用户」，
// 不是「用户不得修改自己确认过的值」。后者会把人锁死。
func TestGlossaryUserCanOverrideOwnConfirmed(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	if _, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "达西", Source: TermUserConfirmed},
	}); err != nil {
		t.Fatalf("put 1: %v", err)
	}
	g, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "达西先生", Source: TermUserConfirmed},
	})
	if err != nil {
		t.Fatalf("put 2: %v", err)
	}
	if g.Terms[0].Target != "达西先生" {
		t.Fatalf("用户改自己的确认值应生效，实际 %q", g.Terms[0].Target)
	}
}

// TestGlossaryVersionBumpsOnChange 锁定 version 递增（译文缓存键）。
//
// 术语改了但 version 不变 → 受影响块的 input_hash 不变 → 复用旧译文；
// 而旧译文用的是旧术语，是**错的译文**。所以 version 必须随变更递增。
func TestGlossaryVersionBumpsOnChange(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	g0, err := s.GetGlossary(ctx, user, bookID, "zh")
	if err != nil {
		t.Fatalf("get empty: %v", err)
	}
	if g0.Version != 0 {
		t.Errorf("新术语表 version 应为 0，实际 %d", g0.Version)
	}

	g1, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "达西", Source: TermLLMExtracted},
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if g1.Version <= g0.Version {
		t.Errorf("写入后 version 应递增，%d -> %d", g0.Version, g1.Version)
	}

	g2, err := s.DeleteGlossaryTerms(ctx, user, bookID, "zh", []string{"darcy"})
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if g2.Version <= g1.Version {
		t.Errorf("删除后 version 应递增，%d -> %d", g1.Version, g2.Version)
	}
	if len(g2.Terms) != 0 {
		t.Errorf("删除后应无术语，实际 %d 条", len(g2.Terms))
	}
}

// TestGlossaryIsolatedBetweenUsers 锁定**多用户隔离**。
//
// 术语表里混入别人的数据 = 泄漏别人的阅读内容。这不是理论风险。
func TestGlossaryIsolatedBetweenUsers(t *testing.T) {
	s, ctx := testStore(t)
	userA, bookA := correctionFixture(t, s, ctx)
	userB, bookB := correctionFixture(t, s, ctx)

	if _, err := s.PutGlossaryTerms(ctx, userA, bookA, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "达西", Source: TermUserConfirmed},
	}); err != nil {
		t.Fatalf("put A: %v", err)
	}

	// B 读自己的书：必须为空。
	gB, err := s.GetGlossary(ctx, userB, bookB, "zh")
	if err != nil {
		t.Fatalf("get B: %v", err)
	}
	if len(gB.Terms) != 0 {
		t.Fatalf("用户 B 读到了 %d 条别人的术语（隔离失效）", len(gB.Terms))
	}

	// B 也不能通过 userA 的 bookId 读到（跨用户越权）。
	gCross, err := s.GetGlossary(ctx, userB, bookA, "zh")
	if err != nil {
		t.Fatalf("get cross: %v", err)
	}
	if len(gCross.Terms) != 0 {
		t.Fatalf("用户 B 用 A 的 bookId 读到了 %d 条术语（越权）", len(gCross.Terms))
	}
}

// TestGlossarySeparateByTargetLang 锁定按目标语言隔离。
//
// 同一本书译成英文和译成日文，术语表必须分开：
// 中文译名和英文译名是两套，混在一起会互相覆盖。
func TestGlossarySeparateByTargetLang(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	if _, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "达西", Source: TermUserConfirmed},
	}); err != nil {
		t.Fatalf("put zh: %v", err)
	}
	if _, err := s.PutGlossaryTerms(ctx, user, bookID, "ja", []GlossaryTerm{
		{Key: "darcy", Display: "Darcy", Target: "ダーシー", Source: TermUserConfirmed},
	}); err != nil {
		t.Fatalf("put ja: %v", err)
	}

	zh, err := s.GetGlossary(ctx, user, bookID, "zh")
	if err != nil {
		t.Fatalf("get zh: %v", err)
	}
	if zh.Terms[0].Target != "达西" {
		t.Errorf("中文术语表被日文污染，实际 %q", zh.Terms[0].Target)
	}
	ja, err := s.GetGlossary(ctx, user, bookID, "ja")
	if err != nil {
		t.Fatalf("get ja: %v", err)
	}
	if ja.Terms[0].Target != "ダーシー" {
		t.Errorf("日文术语表内容错误，实际 %q", ja.Terms[0].Target)
	}
}

// TestGlossaryTermMapForPrompt 锁定 TermMap 用原始写法作键。
//
// 送进 prompt 的术语表要可读：「Mr. Darcy → 达西先生」比「darcy → 达西」清楚。
func TestGlossaryTermMapForPrompt(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	g, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "darcy", Display: "Mr. Darcy", Target: "达西先生", Source: TermUserConfirmed},
		{Key: "elizabeth", Display: "Elizabeth", Target: "伊丽莎白", Source: TermLLMExtracted},
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	m := g.TermMap()
	if m["Mr. Darcy"] != "达西先生" {
		t.Errorf("TermMap 未用 display 作键: %+v", m)
	}
	if m["Elizabeth"] != "伊丽莎白" {
		t.Errorf("TermMap 缺 Elizabeth: %+v", m)
	}
}

// TestPutGlossaryRejectsInvalidSource 锁定防御：非法来源不许入库。
//
// 若允许任意来源字符串入库，优先级比较会静默失效（未知来源走 default 分支），
// 用户确认的术语可能被未知来源覆盖。
func TestPutGlossaryRejectsInvalidSource(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	_, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{
		{Key: "x", Display: "X", Target: "叉", Source: TermSource("bogus")},
	})
	if err == nil {
		t.Fatal("非法来源应被拒绝，实际成功了")
	}
}

var _ = context.Background
