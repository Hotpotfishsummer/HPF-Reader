package booktext

import "testing"

// TestScanTerminologyDetectsIgnoredGlossary 是 §A8 的核心断言：
// 模型拿到术语表却没用 → 必须被判为违规。
//
// 这个测试的价值在于：它把「祈祷模型听话」变成了一条可执行断言。
// 若扫描器失效，一致性保证就退化成空话，而且没人会发现。
func TestScanTerminologyDetectsIgnoredGlossary(t *testing.T) {
	glossary := []GlossaryTerm{
		{Source: "Elizabeth", Target: "伊丽莎白"},
		{Source: "Darcy", Target: "达西"},
	}
	sources := map[int]string{
		0: "Elizabeth walked into the room.",
		1: "Darcy said nothing at all.",
	}
	translated := map[int]string{
		// 第 0 块：术语照用 → 合规
		0: "伊丽莎白走进了房间。",
		// 第 1 块：把 Darcy 译成了别的写法 → 违规（出现 0 次）
		1: "那位先生一言不发。",
	}
	got := ScanTerminology(translated, sources, glossary)
	if !got.HasViolations() {
		t.Fatal("模型忽略了术语表，扫描器却没发现——一致性保证失效")
	}
	if got.ViolatingChunks != 1 {
		t.Fatalf("ViolatingChunks = %d, want 1", got.ViolatingChunks)
	}
	idx := got.ViolatingChunkIndexes()
	if len(idx) != 1 || idx[0] != 1 {
		t.Fatalf("违规块 = %v, want [1]", idx)
	}
	// 只应检查原文里真的出现过的术语：第 0 块原文没提 Darcy，不该检查它。
	if got.CheckedTerms != 2 {
		t.Fatalf("CheckedTerms = %d, want 2（每块只查原文出现过的术语）", got.CheckedTerms)
	}
}

// TestScanTerminologyIgnoresAbsentTerms 证明「原文没提这个术语就不检查」。
//
// 这条很重要：若不做此过滤，任何未被原文提及的术语都会在每块被判违规，
// 导致整本书被误判为重译候选，白花钱还降低体验。
func TestScanTerminologyIgnoresAbsentTerms(t *testing.T) {
	glossary := []GlossaryTerm{{Source: "Elizabeth", Target: "伊丽莎白"}}
	sources := map[int]string{0: "The weather was cold."} // 原文根本没提 Elizabeth
	translated := map[int]string{0: "天气很冷。"}              // 译文里当然也没有
	got := ScanTerminology(translated, sources, glossary)
	if got.HasViolations() {
		t.Fatalf("原文未提及的术语被误判为违规: %+v", got.Violations)
	}
	if got.CheckedTerms != 0 {
		t.Fatalf("CheckedTerms = %d, want 0", got.CheckedTerms)
	}
}

// TestScanTerminologyEmptyGlossary 证明没有术语表时不会误报。
func TestScanTerminologyEmptyGlossary(t *testing.T) {
	got := ScanTerminology(map[int]string{0: "随便什么"}, map[int]string{0: "whatever"}, nil)
	if got.HasViolations() || got.CheckedTerms != 0 {
		t.Fatalf("空术语表产生了结果: %+v", got)
	}
}

// TestScanTerminologyCountsSubstrings 证明译名作为子串出现也算合规。
//
// 中文译文常有「达西先生」「达西太太」这类扩展写法，
// 要求完全等值匹配会大量误报。
func TestScanTerminologyCountsSubstrings(t *testing.T) {
	glossary := []GlossaryTerm{{Source: "Darcy", Target: "达西"}}
	sources := map[int]string{0: "Darcy bowed."}
	translated := map[int]string{0: "达西先生鞠了一躬。"}
	got := ScanTerminology(translated, sources, glossary)
	if got.HasViolations() {
		t.Fatalf("「达西先生」应视为合规（含标准译名）: %+v", got.Violations)
	}
}
