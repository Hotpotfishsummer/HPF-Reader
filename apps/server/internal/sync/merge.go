package sync

import (
	"encoding/json"
	"strings"
)

// 合并规则常量（docs/TECH-PLAN.md §4.3）。
const (
	// ProgressEpsilon 是跨副本 totalProgression 比较的容差：
	// 差值不超过该阈值时视为「噪声」，不允许回退，避免多设备在 0.42/0.4201 之间抖动。
	ProgressEpsilon = 0.002
	// TombstoneWindow 是墓碑的保留窗口（30 天）。超过该窗口的陈旧写入不再能复活已删除实体。
	TombstoneWindow = 30 * 24 * 60 * 60 * 1e9 // 纳秒
)

// MergeStatus 描述一条 push op 的裁决结果。
type MergeStatus string

const (
	// StatusApplied：该变更被采纳，并写入 change_log 供其它设备拉取。
	StatusApplied MergeStatus = "applied"
	// StatusIgnored：该变更未获胜（陈旧或触发单调保护），服务端权威状态不变。
	// 协议里对客户端统一回复 applied（幂等、可安全重放），ignored 仅用于本地审计与测试断言。
	StatusIgnored MergeStatus = "ignored"
)

// Reason 说明裁决原因，便于排障与测试断言（不直接暴露给客户端）。
type Reason string

const (
	ReasonNewer          Reason = "newer_hlc"         // 同类副本，HLC 更新
	ReasonExplicitRewind Reason = "explicit_rewind"   // 用户主动回退
	ReasonForwardOnly    Reason = "monotonic_forward" // 跨副本单调前进
	ReasonStaleRewrite   Reason = "stale_no_rewind"   // 跨副本回退且未显式声明
	ReasonOlderHLC       Reason = "older_hlc"         // 同类副本，HLC 更旧
	ReasonTombstone      Reason = "tombstone_wins"    // remove-wins 墓碑
	ReasonNewEntity      Reason = "new_entity"        // 之前没有该实体
)

// ContentHash 为空的占位：同一本书的文件未上传时，副本判定按「同一副本」处理。
const emptyHash = ""

// SameReplica 判断两个 contentHash 是否指向同一份文件字节。
// 空字符串视为未知：unknown 与 unknown 视为同一副本，unknown 与具体 hash 视为不同副本。
func SameReplica(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// ProgressState 是阅读进度在服务端权威模型中的形态。
type ProgressState struct {
	// ContentHash 是该进度对应的书籍文件哈希（副本标识）。
	ContentHash string
	// Locator 是 Readium Locator JSON。
	Locator json.RawMessage
	// TotalProgression 归一化全书进度 0..1（跨副本唯一可比值）。
	TotalProgression float64
	// FurthestLocator / FurthestProgression 历史最远位置。
	FurthestLocator     json.RawMessage
	FurthestProgression float64
	// ExplicitRewind 标记当前值来自用户主动回退。
	ExplicitRewind bool
	// HLC 是当前值的合并时钟。
	HLC string
	// DeviceID 当前值的来源设备。
	DeviceID string
}

// ProgressIncoming 是一条待合并的进度写入。
type ProgressIncoming struct {
	// OpHLC 是客户端为本次操作生成的 HLC。
	OpHLC string
	// DeviceID 来源设备（HLC tie-break 与审计用）。
	DeviceID string
	// Payload 是客户端提交的进度载荷。
	Payload ProgressPayload
}

// ProgressPayload 是进度 payload 的解析结果。
type ProgressPayload struct {
	Locator             json.RawMessage
	TotalProgression    float64
	FurthestLocator     json.RawMessage
	FurthestProgression float64
	ExplicitRewind      bool
	ContentHash         string
}

// ParseProgressPayload 从 JSONB payload 中解析进度字段。
// 同时兼容 camelCase（OpenAPI 契约）与 snake_case（技术方案草案）两种字段名。
func ParseProgressPayload(raw json.RawMessage) (ProgressPayload, error) {
	var p ProgressPayload
	if len(raw) == 0 {
		return p, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return p, err
	}
	p.Locator = pickRaw(m, "locator")
	p.FurthestLocator = pickRaw(m, "furthestLocator", "furthest_locator")
	p.TotalProgression = pickFloat(m, "totalProgression", "total_progression")
	p.FurthestProgression = pickFloat(m, "furthestProgression", "furthest_progression")
	p.ExplicitRewind = pickBool(m, "explicitRewind", "explicit_rewind")
	p.ContentHash = pickString(m, "contentHash", "content_hash")
	return p, nil
}

// MergeProgress 是进度合并的权威实现（S1：客户端只提交，服务端裁决）。
//
// 三条规则（README/TECH-PLAN §4.3）：
//  1. 同一 contentHash（同一文件）：以 HLC 较新的 locator 为准，允许用户主动回退
//     （显式回退带 explicitRewind=true；否则短时间内容易被另一设备的更远位置覆盖）。
//  2. 不同 contentHash（同书不同副本）：CFI 不可比，只能比较 totalProgression，
//     且只允许单调前移（epsilon = 0.002）。
//  3. 历史最远位置只增不减；删除走墓碑（此处由 Merger 层处理）。
func MergeProgress(cur *ProgressState, in ProgressIncoming) (ProgressState, MergeStatus, Reason) {
	p := in.Payload
	if p.FurthestProgression < p.TotalProgression {
		// 防御：客户端可能只上报 totalProgression，furthest 不应小于当前位置。
		p.FurthestProgression = p.TotalProgression
	}
	if cur == nil || cur.HLC == "" {
		// 首次写入：直接落地。
		st := ProgressState{
			ContentHash:         p.ContentHash,
			Locator:             p.Locator,
			TotalProgression:    p.TotalProgression,
			FurthestLocator:     firstNonNil(p.FurthestLocator, p.Locator),
			FurthestProgression: p.FurthestProgression,
			ExplicitRewind:      p.ExplicitRewind,
			HLC:                 in.OpHLC,
			DeviceID:            in.DeviceID,
		}
		return st, StatusApplied, ReasonNewEntity
	}

	out := *cur
	out.DeviceID = cur.DeviceID
	sameReplica := cur.ContentHash == emptyHash || p.ContentHash == emptyHash || SameReplica(cur.ContentHash, p.ContentHash)

	// 无论走哪条分支，最远位置都只增不减（除非显式回退把最远值本身落下）。
	if sameReplica {
		if cmp := compareHLC(in.OpHLC, cur.HLC); cmp > 0 || (cmp == 0 && in.DeviceID > cur.DeviceID) {
			out.ContentHash = p.ContentHash
			out.Locator = p.Locator
			out.TotalProgression = p.TotalProgression
			out.ExplicitRewind = p.ExplicitRewind
			out.HLC = in.OpHLC
			out.DeviceID = in.DeviceID
			out = bumpFurthest(out, p)
			return out, StatusApplied, ReasonNewer
		}
		return *cur, StatusIgnored, ReasonOlderHLC
	}

	// 不同副本：只信归一化进度。
	delta := p.TotalProgression - cur.FurthestProgression
	if delta > ProgressEpsilon {
		out.ContentHash = p.ContentHash
		out.Locator = p.Locator
		out.TotalProgression = p.TotalProgression
		out.ExplicitRewind = p.ExplicitRewind
		out.HLC = in.OpHLC
		out.DeviceID = in.DeviceID
		out = bumpFurthest(out, p)
		return out, StatusApplied, ReasonForwardOnly
	}
	if p.ExplicitRewind {
		// 用户明确回退：允许后退，且把最远基线保留（可用于「回到最远」按钮）。
		out.ContentHash = p.ContentHash
		out.Locator = p.Locator
		out.TotalProgression = p.TotalProgression
		out.ExplicitRewind = true
		out.HLC = in.OpHLC
		out.DeviceID = in.DeviceID
		return out, StatusApplied, ReasonExplicitRewind
	}
	return *cur, StatusIgnored, ReasonStaleRewrite
}

// bumpFurthest 在采纳新位置后维护「历史最远」。
func bumpFurthest(out ProgressState, p ProgressPayload) ProgressState {
	if p.FurthestProgression >= out.FurthestProgression {
		out.FurthestProgression = p.FurthestProgression
		if len(p.FurthestLocator) > 0 {
			out.FurthestLocator = p.FurthestLocator
		}
	}
	if out.TotalProgression > out.FurthestProgression {
		out.FurthestProgression = out.TotalProgression
		out.FurthestLocator = out.Locator
	}
	return out
}

// LWW 是通用的字段级 Last-Write-Wins 合并（shelf / 设置 / 书籍元数据）。
//
// 语义：逐字段比较 HLC，较大者获胜；HLC 相同则比 deviceId 字典序，
// 保证任何设备独立计算都得到同一结果（可复现）。
func LWW(base map[string]json.RawMessage, baseHLC string, baseDevice string,
	incoming map[string]json.RawMessage, inHLC string, inDevice string) (map[string]json.RawMessage, bool) {
	if base == nil {
		base = map[string]json.RawMessage{}
	}
	cmp := compareHLC(inHLC, baseHLC)
	win := cmp > 0 || (cmp == 0 && inDevice > baseDevice)
	if !win {
		return base, false
	}
	out := make(map[string]json.RawMessage, len(base)+len(incoming))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range incoming {
		out[k] = v
	}
	return out, true
}

// ShouldApplyAnnotation 实现标注的 remove-wins 语义。
//
//   - 已存在墓碑且墓碑 HLC >= 本次写入 HLC：拒绝（慢设备不能复活已删除标注）；
//   - 已存在墓碑但墓碑已过期（超过 TombstoneWindow）且本次写入更新：允许（相当于全新实体）；
//   - 无墓碑：字段级 LWW。
func ShouldApplyAnnotation(tombstoneHLC string, tombstoneNanos int64, inHLC string, nowNanos int64) (bool, Reason) {
	if tombstoneHLC == "" {
		return true, ReasonNewEntity
	}
	if compareHLC(inHLC, tombstoneHLC) <= 0 {
		return false, ReasonTombstone
	}
	if tombstoneNanos > 0 && nowNanos-tombstoneNanos > TombstoneWindow {
		return true, ReasonNewEntity
	}
	return false, ReasonTombstone
}

// compareHLC 比较两个 HLC 字符串；非法输入退化为字符串比较，绝不 panic。
func compareHLC(a, b string) int {
	if a == b {
		return 0
	}
	pa, ea := Parse(a)
	pb, eb := Parse(b)
	if ea != nil || eb != nil {
		return strings.Compare(a, b)
	}
	return pa.Compare(pb)
}

// CompareHLC 是 compareHLC 的导出版本，供上层（store/engine）复用同一套比较语义。
func CompareHLC(a, b string) int { return compareHLC(a, b) }

func pickRaw(m map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return nil
}

func pickFloat(m map[string]json.RawMessage, keys ...string) float64 {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			var f float64
			if err := json.Unmarshal(v, &f); err == nil {
				return f
			}
		}
	}
	return 0
}

func pickBool(m map[string]json.RawMessage, keys ...string) bool {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			var b bool
			if err := json.Unmarshal(v, &b); err == nil {
				return b
			}
		}
	}
	return false
}

func pickString(m map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			var s string
			if err := json.Unmarshal(v, &s); err == nil {
				return s
			}
		}
	}
	return ""
}

func firstNonNil(a, b json.RawMessage) json.RawMessage {
	if len(a) > 0 {
		return a
	}
	return b
}
