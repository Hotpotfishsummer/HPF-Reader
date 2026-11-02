package booktext

import "strings"

// 译后确定性扫描（docs/research/80-entity-normalization.md §A8）。
//
// 要解决的真问题：用户的核心诉求是「同一人物在全书译名一致」。
// 我们把术语表塞进 system prompt 并要求模型照用——但**模型是否真的照做，无法保证**。
// 不做校验的话，一致性就成了「祈祷模型听话」，而这类祈祷在长文里几乎必然失效。
//
// 本文件提供零成本的确定性校验：
//   对每个标准译名，统计它在该段译文里出现的次数；出现 0 次 = 该段忽略了术语表。
// 这把「祈祷」变成「可验证断言」，且**不花一分钱 LLM 费用**（纯字符串统计）。
//
// 注意这是**保守**的判定，有明确的已知局限（见 ScanTerminology 的注释）：
// 它只能发现「该用没用」，不能发现「用了但用错」（例如把 A 的译名安到 B 头上）。
// 后者需要语义理解，属 M5-4 的 LLM 裁决范围。宁可漏报也不误报——
// 误报会让用户重译本来正确的段落，白花钱还降低体验。

// GlossaryTerm 是术语表里的一条。
type GlossaryTerm struct {
	// Source 是原文中的写法（用于定位：该术语是否出现在这一块的原文里）。
	Source string
	// Target 是标准译名（译文中必须出现的字符串）。
	Target string
}

// TermViolation 记录一条「该段忽略了术语表」的违规。
type TermViolation struct {
	ChunkIndex int
	Source     string
	Target     string
	// Occurrences 是标准译名在译文中出现的次数（违规时为 0）。
	Occurrences int
}

// ScanResult 是一次译后扫描的结果。
type ScanResult struct {
	// CheckedTerms 是本次实际检查过的术语数（只检查原文里出现过的术语）。
	CheckedTerms int
	// Violations 是违规明细。
	Violations []TermViolation
	// ViolatingChunks 是存在违规的**段落数**（按 chunk 计，不是按术语计）。
	// 用段落数而不是术语数，是因为一个段落忽略 5 个术语和忽略 1 个术语
	// 对用户来说都是「这段没照术语表翻」，重译成本相同。
	ViolatingChunks int
}

// HasViolations 报告是否存在违规。
func (r ScanResult) HasViolations() bool { return len(r.Violations) > 0 }

// ScanTerminology 对已完成的块做术语一致性扫描。
//
// 判定规则（刻意保守）：
//  1. 只有当术语的**原文写法出现在该块原文里**时才检查它——
//     若原文没提这个人，译文里当然不该出现，检查它必然误报。
//  2. 标准译名在译文里出现次数 > 0 即通过。**不做「出现次数是否匹配原文次数」的比对**：
//     中文译文常合并/拆分指代（英语代词 he/she 译成名字，或反过来），
//     强行要求次数相等会大量误报。
//  3. 完全匹配子串（区分大小写对中文无意义，但英文译名有用）。
//
// chunks 是「块序号 → 译文」；sources 是「块序号 → 原文」。
// 传入两块映射而不是单个字符串，是为了让调用方一次扫描整个任务。
func ScanTerminology(chunks, sources map[int]string, glossary []GlossaryTerm) ScanResult {
	var out ScanResult
	if len(glossary) == 0 || len(chunks) == 0 {
		return out
	}
	violatingSet := map[int]bool{}
	// 按块序号排序遍历，保证输出稳定（map 迭代顺序随机，会让测试与日志抖动）。
	for idx := 0; idx < len(chunks)+len(sources); idx++ {
		translated, okT := chunks[idx]
		source, okS := sources[idx]
		if !okT || !okS {
			continue
		}
		for _, term := range glossary {
			if term.Source == "" || term.Target == "" {
				continue
			}
			if !strings.Contains(source, term.Source) {
				continue // 原文没提到该术语：不该检查
			}
			out.CheckedTerms++
			n := strings.Count(translated, term.Target)
			if n == 0 {
				out.Violations = append(out.Violations, TermViolation{
					ChunkIndex: idx, Source: term.Source, Target: term.Target, Occurrences: n,
				})
				violatingSet[idx] = true
			}
		}
	}
	out.ViolatingChunks = len(violatingSet)
	return out
}

// ViolatingChunkIndexes 返回存在违规的块序号（升序，供重译）。
func (r ScanResult) ViolatingChunkIndexes() []int {
	seen := map[int]bool{}
	out := make([]int, 0, r.ViolatingChunks)
	for _, v := range r.Violations {
		if !seen[v.ChunkIndex] {
			seen[v.ChunkIndex] = true
			out = append(out, v.ChunkIndex)
		}
	}
	sortInts(out)
	return out
}

// sortInts 是小规模整数排序（避免为几项引入 sort 包的开销与依赖）。
func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
