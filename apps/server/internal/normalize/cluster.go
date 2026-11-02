package normalize

import (
	"sort"
	"strconv"
	"strings"

	"github.com/xrash/smetrics"
)

// Evidence 是一条「为什么把两个写法归到一组」的理由。
//
// 刻意记录理由而不是只给结果：用户看到两个人被合并时，必须能查到
// 「是因为拼音相同」还是「是因为相似度 0.9」——否则无法判断该不该拆开。
type Evidence struct {
	Kind   EvidenceKind
	Detail string
}

// EvidenceKind 是证据种类，按强度从强到弱排列。
type EvidenceKind string

const (
	// EvidenceExact：归一化 key 完全相同。确定性结论，必然同一实体。
	EvidenceExact EvidenceKind = "exact"
	// EvidencePinyin：拼音 key 完全相同。强信号，同音异形（伊丽莎白/伊莉莎白）。
	EvidencePinyin EvidenceKind = "pinyin"
	// EvidenceSubstring：全名的 token 集合包含短名（fitzwilliam darcy ⊇ darcy）。
	EvidenceSubstring EvidenceKind = "substring"
	// EvidenceSimilarity：编辑距离相似度，**弱信号**，只标「疑似」不自动合并。
	EvidenceSimilarity EvidenceKind = "similarity"
)

// Strength 返回证据强度：>= 2 才是「确定」，< 2 只能标「疑似」。
//
// 这条分界线是整个聚类安全性的核心：误合并（两个人变一个）比漏合并
// （一个人变两个）严重得多——前者会让用户认为功能是错的。
func (k EvidenceKind) Strength() int {
	switch k {
	case EvidenceExact:
		return 3
	case EvidencePinyin, EvidenceSubstring:
		return 2
	default:
		return 1
	}
}

// Form 是一个候选写法及其出现次数。
type Form struct {
	Surface string
	Count   int
}

// Group 是一个聚类结果。
type Group struct {
	// Canonical 是组内展示名（选出现次数最多的写法，见 pickCanonical）。
	Canonical string
	// Members 是组内全部写法，按 Count 降序。
	Members []Form
	// Certain 表示这组的合并有确定性证据支撑。
	// 为 false 时只能作为「疑似」呈现给用户，**不得**直接用于替换译文。
	Certain bool
	// Evidence 是促成这次合并的理由集合，用于 UI 解释与人工复核。
	Evidence []Evidence
}

// similarityThreshold 是弱信号兜底阈值。
//
// **刻意不是 0.85**：实测 伊丽莎白/伊莉莎白 的 Jaro 只有 0.8333，
// 而这一对是必须合并的同一人。0.85 会把真阳性漏掉。
// 用 0.80 作弱信号下限，且**弱信号永不自动合并**（只标疑似），
// 所以放低阈值的代价只是「疑似列表长一点」，不会造成误合并。
const similarityThreshold = 0.80

// Cluster 把一批候选写法聚类成分组。
//
// **算法顺序是刻意设计的**，每一步的强度不同：
//
//  1. NormKey 精确相同 → 确定合并
//  2. PinyinKey 精确相同（**且非空**）→ 确定合并
//  3. 子串包含（全名 ⊇ 短名）→ 确定合并
//  4. 相似度 ≥ 阈值 → **只标疑似**，不合并
//
// 第 2 步的非空判断是安全关键：拼音库对非中文返回空串，
// 若不判空，任意两个英文人名都会「拼音相同」而被强制合并。
func Cluster(forms []Form) []Group {
	if len(forms) == 0 {
		return nil
	}
	// 去重（同一写法多次出现合并计数），保持确定性顺序。
	seen := map[string]int{}
	uniq := make([]Form, 0, len(forms))
	for _, f := range forms {
		s := strings.TrimSpace(f.Surface)
		if s == "" {
			continue
		}
		if idx, ok := seen[s]; ok {
			uniq[idx].Count += f.Count
			continue
		}
		seen[s] = len(uniq)
		c := f.Count
		if c <= 0 {
			c = 1
		}
		uniq = append(uniq, Form{Surface: s, Count: c})
	}
	if len(uniq) == 0 {
		return nil
	}

	keys := make([]Key, len(uniq))
	for i, f := range uniq {
		keys[i] = Normalize(f.Surface)
	}

	parent := make([]int, len(uniq))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(x int) int {
		for parent[x] != x {
			parent[x] = parent[parent[x]]
			x = parent[x]
		}
		return x
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[rb] = ra
		}
	}

	evidence := map[int][]Evidence{}
	certain := map[int]bool{}
	addEv := func(i int, ev Evidence) {
		r := find(i)
		evidence[r] = append(evidence[r], ev)
		if ev.Kind.Strength() >= 2 {
			certain[r] = true
		}
	}

	// 1) NormKey 精确
	byNorm := map[string][]int{}
	for i, k := range keys {
		if k.NormKey == "" {
			continue
		}
		byNorm[k.NormKey] = append(byNorm[k.NormKey], i)
	}
	normGroups := make([]string, 0, len(byNorm))
	for nk := range byNorm {
		normGroups = append(normGroups, nk)
	}
	sort.Strings(normGroups) // 确定性：不依赖 map 迭代顺序
	for _, nk := range normGroups {
		idxs := byNorm[nk]
		if len(idxs) < 2 {
			continue
		}
		for _, j := range idxs[1:] {
			union(idxs[0], j)
		}
		for _, j := range idxs {
			addEv(j, Evidence{Kind: EvidenceExact, Detail: "normalized key equal: " + nk})
		}
	}

	// 2) PinyinKey 精确（非空）
	byPy := map[string][]int{}
	for i, k := range keys {
		if k.PinyinKey == "" {
			continue // 安全关键：空 key 不参与，否则英文名会互相合并
		}
		byPy[k.PinyinKey] = append(byPy[k.PinyinKey], i)
	}
	pyGroups := make([]string, 0, len(byPy))
	for pk := range byPy {
		pyGroups = append(pyGroups, pk)
	}
	sort.Strings(pyGroups)
	for _, pk := range pyGroups {
		idxs := byPy[pk]
		if len(idxs) < 2 {
			continue
		}
		// 同一拼音但归一 key 完全不同的才算「同音异形」证据；
		// key 本来就相同的已经在上一步按 exact 记过了。
		distinctNorm := map[string]bool{}
		for _, i := range idxs {
			distinctNorm[keys[i].NormKey] = true
		}
		if len(distinctNorm) < 2 {
			continue
		}
		for _, j := range idxs[1:] {
			union(idxs[0], j)
		}
		for _, j := range idxs {
			addEv(j, Evidence{Kind: EvidencePinyin, Detail: "pinyin key equal: " + pk})
		}
	}

	// 3) 子串包含：全名的 token 集合包含短名。
	// 只在**不同根**之间做，且要求短名有长度 >= 2 的 token，避免单字母把一切吃掉。
	for i := 0; i < len(uniq); i++ {
		for j := 0; j < len(uniq); j++ {
			if i == j || find(i) == find(j) {
				continue
			}
			a, b := keys[i].NormKey, keys[j].NormKey
			if a == "" || b == "" {
				continue
			}
			if !tokenSubset(a, b) {
				continue
			}
			union(i, j)
			detail := a + " contains " + b
			addEv(i, Evidence{Kind: EvidenceSubstring, Detail: detail})
			addEv(j, Evidence{Kind: EvidenceSubstring, Detail: detail})
		}
	}

	// 4) 相似度：只记录证据，**不合并**。
	simEvidence := map[int][]Evidence{}
	for i := 0; i < len(uniq); i++ {
		for j := i + 1; j < len(uniq); j++ {
			a, b := keys[i].NormKey, keys[j].NormKey
			if a == "" || b == "" {
				continue
			}
			score := smetrics.JaroWinkler(a, b, 0.7, 4)
			if score < similarityThreshold {
				continue
			}
			detail := "similarity " + strconv.FormatFloat(score, 'f', 4, 64) + ": " + a + " ~ " + b
			ev := Evidence{Kind: EvidenceSimilarity, Detail: detail}
			simEvidence[i] = append(simEvidence[i], ev)
			simEvidence[j] = append(simEvidence[j], ev)
		}
	}

	groups := map[int][]int{}
	for i := range uniq {
		r := find(i)
		groups[r] = append(groups[r], i)
	}
	roots := make([]int, 0, len(groups))
	for r := range groups {
		roots = append(roots, r)
	}
	sort.Ints(roots)

	out := make([]Group, 0, len(roots))
	for _, r := range roots {
		idxs := groups[r]
		members := make([]Form, 0, len(idxs))
		for _, i := range idxs {
			members = append(members, uniq[i])
		}
		sort.Slice(members, func(a, b int) bool {
			if members[a].Count != members[b].Count {
				return members[a].Count > members[b].Count
			}
			return members[a].Surface < members[b].Surface
		})
		g := Group{
			Canonical: pickCanonical(members),
			Members:   members,
			Certain:   certain[r],
			Evidence:  evidence[r],
		}
		// 单成员组也带上相似度证据，供 UI 提示「这个可能和某个已存在的组是同一人」。
		for _, i := range idxs {
			g.Evidence = append(g.Evidence, simEvidence[i]...)
		}
		out = append(out, g)
	}
	return out
}

// pickCanonical 选组内展示名：出现次数最多者；次数相同取更长的（全名优先于姓氏）。
//
// 「更长优先」是刻意的：读者想看「菲茨威廉·达西」而不是「达西」，
// 但展示时仍可用短名，这只是 canonical 的选取规则。
func pickCanonical(members []Form) string {
	if len(members) == 0 {
		return ""
	}
	best := members[0]
	for _, m := range members[1:] {
		if m.Count > best.Count {
			best = m
			continue
		}
		if m.Count == best.Count && len(m.Surface) > len(best.Surface) {
			best = m
		}
	}
	return best.Surface
}

// tokenSubset 判断 a 的 token 集合是否真包含 b（b 的每个 token 都在 a 里）。
//
// 要求 b 至少有一个长度 >= 2 的 token，避免单字母姓氏（"o"）把一切吃掉。
func tokenSubset(a, b string) bool {
	if a == b {
		return false
	}
	aTok := strings.Fields(a)
	bTok := strings.Fields(b)
	if len(bTok) == 0 || len(bTok) >= len(aTok) {
		return false
	}
	hasLong := false
	for _, t := range bTok {
		if len([]rune(t)) >= 2 {
			hasLong = true
			break
		}
	}
	if !hasLong {
		return false
	}
	set := map[string]bool{}
	for _, t := range aTok {
		set[t] = true
	}
	for _, t := range bTok {
		if !set[t] {
			return false
		}
	}
	return true
}
