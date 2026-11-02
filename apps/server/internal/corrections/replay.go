// Package corrections 实现「append-only 修正日志 → 重放 → 实体分组」的核心逻辑。
//
// 设计依据：docs/research/80-entity-normalization.md §3.3.1–§3.3.3。
//
// 一句话原则：**存日志，不存结果**。
//
//	❌ 用户把 A 和 B 合并 → UPDATE 实体表
//	   → 下次自动流水线重跑 → 用户的工作被覆盖
//	✅ 用户把 A 和 B 合并 → INSERT 一条 correction 事件
//	   → 自动流水线重跑 → 重放所有 correction → 用户的工作保留
//
// 根本理由：**自动流水线的输出是可重算的，用户的输入是不可重算的。
// 只有后者值得持久化。** 这也是「纯 LLM 一次性抽取」不可增量的根因——它没有日志层。
package corrections

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Op 是修正事件的类型。与迁移 00006 的 CHECK 约束一致。
type Op string

const (
	// OpMerge：a 与 b 是同一人。重放时并查集强制 union，**优先级高于所有自动边**。
	OpMerge Op = "merge"
	// OpSplit：这些写法不属于该实体。重放时拉到新实体，并**记录负样本对**。
	OpSplit Op = "split"
	// OpRename：改 canonical 显示名。覆盖自动生成的 canonical。
	OpRename Op = "rename"
	// OpAliasAdd：这个写法也是他。加入别名表；后续自动聚类把它当强边。
	OpAliasAdd Op = "alias_add"
	// OpLock：锁定，自动流水线不得改。该实体整条跳过自动更新。
	OpLock Op = "lock"
)

// validOps 用于校验，防止把拼错的事件写进日志后永久卡住重放。
var validOps = map[Op]bool{
	OpMerge: true, OpSplit: true, OpRename: true, OpAliasAdd: true, OpLock: true,
}

// Valid 判断事件类型是否合法。
func (o Op) Valid() bool { return validOps[o] }

// Event 是一条修正事件。
//
// Seq 由客户端生成且单调递增，**不是时间戳**：
// 时钟回拨会让重放顺序错乱，而 seq 不会。
type Event struct {
	Seq     int64 // 重放顺序，全局单调递增
	Op      Op
	Payload json.RawMessage
}

// MergePayload 是 OpMerge 的载荷。
type MergePayload struct {
	// KeyA / KeyB 是归一化后的写法 key。
	KeyA string `json:"keyA"`
	KeyB string `json:"keyB"`
}

// SplitPayload 是 OpSplit 的载荷。
type SplitPayload struct {
	// Key 是原实体中要拆出的写法。
	Key string `json:"key"`
	// From 是被拆出的那个实体（另一个写法的 key）。
	From string `json:"from"`
}

// RenamePayload 是 OpRename 的载荷。
type RenamePayload struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// AliasAddPayload 是 OpAliasAdd 的载荷。
type AliasAddPayload struct {
	Key   string `json:"key"`
	Alias string `json:"alias"`
}

// LockPayload 是 OpLock 的载荷。
type LockPayload struct {
	Key string `json:"key"`
}

// BlockedPair 是一对「禁止合并」的写法。
//
// 它是 OpSplit 的**副产物**，也是防「重跑回退」的关键：
// 用户把 A 和 B 拆开后，重跑时自动流水线若又想把它们合并，必须先查这张表。
// 没有这一条，用户拆完重跑又合回去，体验是灾难性的。
type BlockedPair struct {
	A string
	B string
}

// Entity 是重放后的一个实体分组。
type Entity struct {
	// Canonical 是显示名。
	Canonical string
	// Members 是组内全部写法 key，**已排序**以保证确定性。
	Members []string
	// Locked 表示该实体被用户锁定，自动流水线不得改动。
	Locked bool
	// FromUser 表示这组的形成有用户修正事件参与。
	// UI 需要区分「自动推测」与「用户确认」，后者优先级最高。
	FromUser bool
}

// ReplayResult 是一次重放的完整结果。
type ReplayResult struct {
	Entities     []Entity
	BlockedPairs []BlockedPair
	// Applied 是实际生效的事件数；Skipped 是无效/重复的事件数。
	Applied int
	Skipped int
}

// Replay 把一批自动聚类结果与修正日志合成最终实体分组。
//
// **重放顺序是固定且不可调换的**（见 §3.3.3）：
//
//  1. 自动聚类（auto）作为基线
//  2. 应用 blocked_pairs（禁止合并）
//  3. 应用 merge（强制合并）
//  4. 应用 split（强制拆分，**晚于 merge**）
//  5. 应用 rename / alias_add
//  6. 应用 lock（冻结）
//
// 顺序不能乱的道理：split 必须在 merge 之后，否则「先合后拆」的用户意图会丢失；
// lock 必须最后，否则会被前面的步骤改掉。
func Replay(autoGroups [][]string, events []Event) (ReplayResult, error) {
	var res ReplayResult

	// 事件必须按 seq 排序；调用方传乱序也能得到正确结果。
	sorted := make([]Event, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Seq < sorted[j].Seq })

	// ---- 1. 自动聚类作为基线 ----
	uf := newUnionFind()
	for _, g := range autoGroups {
		var prev string
		for _, k := range g {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			uf.add(k)
			if prev != "" {
				uf.union(prev, k)
			}
			prev = k
		}
	}

	// ---- 2–6. 依次应用事件 ----
	// 分成两个阶段：先 merge/split（改变分组结构），再 rename/alias/lock（改变属性）。
	// 这样即使客户端把 rename 的 seq 排在 merge 之前，属性也不会作用到错误的分组上。
	type pendingRename struct{ key, name string }
	var (
		renames []pendingRename
		aliases = map[string][]string{}
		locked  = map[string]bool{}
		blocked []BlockedPair
	)

	for _, ev := range sorted {
		if !ev.Op.Valid() {
			res.Skipped++
			continue
		}
		switch ev.Op {
		case OpMerge:
			var pl MergePayload
			if err := json.Unmarshal(ev.Payload, &pl); err != nil {
				return res, fmt.Errorf("merge seq=%d: %w", ev.Seq, err)
			}
			a, b := strings.TrimSpace(pl.KeyA), strings.TrimSpace(pl.KeyB)
			if a == "" || b == "" || a == b {
				res.Skipped++
				continue
			}
			// 负样本优先：用户明确拆开过的对，不得再被任何 merge 合回去。
			// 这不是多余的保护——用户可能先拆后误操作合并，此时应尊重「拆」的意图。
			if isBlocked(blocked, a, b) {
				res.Skipped++
				continue
			}
			uf.add(a)
			uf.add(b)
			uf.union(a, b)
			uf.markUser(a)
			res.Applied++

		case OpSplit:
			var pl SplitPayload
			if err := json.Unmarshal(ev.Payload, &pl); err != nil {
				return res, fmt.Errorf("split seq=%d: %w", ev.Seq, err)
			}
			k, from := strings.TrimSpace(pl.Key), strings.TrimSpace(pl.From)
			if k == "" || from == "" || k == from {
				res.Skipped++
				continue
			}
			uf.add(k)
			uf.add(from)
			uf.split(k, from)
			uf.markUser(k)
			uf.markUser(from)
			// 记录负样本对（双向都记，查询时不必关心顺序）。
			blocked = append(blocked, BlockedPair{A: k, B: from}, BlockedPair{A: from, B: k})
			res.Applied++

		case OpRename:
			var pl RenamePayload
			if err := json.Unmarshal(ev.Payload, &pl); err != nil {
				return res, fmt.Errorf("rename seq=%d: %w", ev.Seq, err)
			}
			k, name := strings.TrimSpace(pl.Key), strings.TrimSpace(pl.Name)
			if k == "" || name == "" {
				res.Skipped++
				continue
			}
			renames = append(renames, pendingRename{key: k, name: name})
			res.Applied++

		case OpAliasAdd:
			var pl AliasAddPayload
			if err := json.Unmarshal(ev.Payload, &pl); err != nil {
				return res, fmt.Errorf("alias_add seq=%d: %w", ev.Seq, err)
			}
			k, al := strings.TrimSpace(pl.Key), strings.TrimSpace(pl.Alias)
			if k == "" || al == "" {
				res.Skipped++
				continue
			}
			uf.add(k)
			uf.add(al)
			uf.union(k, al)
			uf.markUser(k)
			aliases[k] = append(aliases[k], al)
			res.Applied++

		case OpLock:
			var pl LockPayload
			if err := json.Unmarshal(ev.Payload, &pl); err != nil {
				return res, fmt.Errorf("lock seq=%d: %w", ev.Seq, err)
			}
			k := strings.TrimSpace(pl.Key)
			if k == "" {
				res.Skipped++
				continue
			}
			uf.add(k)
			locked[k] = true
			res.Applied++
		}
	}

	// ---- 汇总 ----
	g := uf.groups()
	entities := make([]Entity, 0, len(g))
	for root, members := range g {
		sort.Strings(members)
		ent := Entity{
			Canonical: members[0], // 默认用字典序最小的成员，稳定且可复现
			Members:   members,
			FromUser:  uf.isUser(root),
		}
		// rename 覆盖自动 canonical。若同一 key 被多次 rename，**后写的生效**（seq 大的赢）。
		for _, rn := range renames {
			if containsStr(members, rn.key) {
				ent.Canonical = rn.name
			}
		}
		// 任一成员被 lock，整组冻结。
		for _, m := range members {
			if locked[m] {
				ent.Locked = true
			}
		}
		entities = append(entities, ent)
	}
	// 输出必须确定性排序：否则两次重放得到不同顺序，「重放幂等」就无法断言。
	sort.Slice(entities, func(i, j int) bool {
		if entities[i].Canonical != entities[j].Canonical {
			return entities[i].Canonical < entities[j].Canonical
		}
		return strings.Join(entities[i].Members, ",") < strings.Join(entities[j].Members, ",")
	})
	res.Entities = entities
	res.BlockedPairs = dedupPairs(blocked)
	return res, nil
}

// isBlocked 判断一对是否在负样本表里。
func isBlocked(pairs []BlockedPair, a, b string) bool {
	for _, p := range pairs {
		if (p.A == a && p.B == b) || (p.A == b && p.B == a) {
			return true
		}
	}
	return false
}

// dedupPairs 去重并排序，保证输出确定性。
func dedupPairs(in []BlockedPair) []BlockedPair {
	seen := map[BlockedPair]bool{}
	out := make([]BlockedPair, 0, len(in))
	for _, p := range in {
		// 规范化顺序（A < B），这样 (a,b) 与 (b,a) 被视为同一条。
		if p.A > p.B {
			p.A, p.B = p.B, p.A
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].A != out[j].A {
			return out[i].A < out[j].A
		}
		return out[i].B < out[j].B
	})
	return out
}

func containsStr(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// unionFind 是并查集，额外记录「用户参与」标记。
//
// 额外记录标记的原因：UI 需要区分「自动推测的合并」与「用户确认的合并」。
// 后者不可被自动流水线推翻，前者可以。
type unionFind struct {
	parent map[string]string
	user   map[string]bool
}

func newUnionFind() *unionFind {
	return &unionFind{parent: map[string]string{}, user: map[string]bool{}}
}

func (u *unionFind) add(k string) {
	if _, ok := u.parent[k]; !ok {
		u.parent[k] = k
	}
}

func (u *unionFind) find(k string) string {
	u.add(k)
	for u.parent[k] != k {
		u.parent[k] = u.parent[u.parent[k]]
		k = u.parent[k]
	}
	return k
}

func (u *unionFind) union(a, b string) {
	ra, rb := u.find(a), u.find(b)
	if ra == rb {
		return
	}
	// 合并时保持确定性：字典序小的做根，避免依赖调用顺序。
	if ra > rb {
		ra, rb = rb, ra
		u.parent[rb] = ra
	} else {
		u.parent[rb] = ra
	}
	if u.user[ra] || u.user[rb] {
		u.user[ra] = true
	}
}

// split 把 k 从 from 所在组里摘出来，单独成组。
//
// 这是 split 语义的核心：它必须**强于** merge——
// 「先合后拆」时用户要的是拆，不能被 merge 的历史覆盖。
func (u *unionFind) split(k, from string) {
	u.add(k)
	u.add(from)
	rk, rfrom := u.find(k), u.find(from)
	if rk != rfrom {
		return // 本来就不在一组，无需拆
	}
	// 把 k 变成自己的根，脱离 from 的组。
	u.parent[k] = k
	// 若 from 原本挂在 k 上，也要把它重新挂回原根，否则会跟着 k 一起被拆走。
	for node := range u.parent {
		if node != k && u.find(node) == k {
			u.parent[node] = rfrom
		}
	}
}

func (u *unionFind) markUser(k string) {
	u.user[u.find(k)] = true
}

func (u *unionFind) isUser(root string) bool { return u.user[root] }

// groups 返回 root → 成员列表。
func (u *unionFind) groups() map[string][]string {
	out := map[string][]string{}
	for k := range u.parent {
		r := u.find(k)
		out[r] = append(out[r], k)
	}
	return out
}
