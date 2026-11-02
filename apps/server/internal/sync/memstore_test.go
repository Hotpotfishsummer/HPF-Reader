package sync

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"
)

// memStore 是 SyncStore 的内存实现，仅用于单元测试：
// 它模拟 Postgres 侧的「同事务写入 + IDENTITY 单调游标 + 幂等表」语义，
// 让引擎的合并逻辑可以在没有数据库的 CI 环境里被完整验证。
type memStore struct {
	mu       sync.Mutex
	seq      int64
	state    map[string]PendingState // key: entity + "\x00" + entityID
	opLog    map[string]OpOutcome    // key: opID
	changes  []Change
	nowNanos int64
}

func newMemStore() *memStore {
	return &memStore{
		state:    map[string]PendingState{},
		opLog:    map[string]OpOutcome{},
		changes:  []Change{},
		nowNanos: time.Now().UnixNano(),
	}
}

func stateKey(entity, id string) string { return entity + "\x00" + id }

func (m *memStore) LookupOp(_ context.Context, _ string, opID string) (OpOutcome, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.opLog[opID]
	return o, ok, nil
}

func (m *memStore) LoadPending(_ context.Context, _ string, entity, id string) (PendingState, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.state[stateKey(entity, id)]
	return st, ok, nil
}

func (m *memStore) Push(_ context.Context, _ string, deviceID string, ops []StoreOp, idem []IdempotencyRecord) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	// 先写幂等表（服务端在一个事务里完成，这里等价地顺序完成）。
	for _, rec := range idem {
		var parsed struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(rec.Result, &parsed)
		if parsed.Status == "" {
			parsed.Status = string(StatusApplied)
		}
		m.opLog[rec.OpID] = OpOutcome{OpID: rec.OpID, Status: MergeStatus(parsed.Status), Reason: Reason(parsed.Reason)}
	}
	base := m.seq
	for i, op := range ops {
		seq := base + int64(i) + 1
		st := m.applyOp(op, deviceID)
		m.state[stateKey(op.Entity, op.EntityID)] = st
		m.changes = append(m.changes, Change{
			Cursor:   seq,
			Entity:   op.Entity,
			EntityID: op.EntityID,
			BookID:   op.BookID,
			Kind:     op.Kind,
			HLC:      st.HLC,
			DeviceID: deviceID,
			Payload:  st.Payload,
		})
	}
	m.seq = base + int64(len(ops))
	return m.seq, nil
}

// applyOp 把裁决为 applied 的 op 落成权威状态（用与 Postgres 相同的合并原语）。
func (m *memStore) applyOp(op StoreOp, deviceID string) PendingState {
	key := stateKey(op.Entity, op.EntityID)
	cur, ok := m.state[key]
	now := time.Unix(0, m.nowNanos)

	switch op.Entity {
	case EntityProgress:
		if op.Kind == KindDelete {
			cur.Deleted = true
			cur.DeletedHLC = op.HLC
			cur.DeletedNanos = m.nowNanos
			cur.HLC = op.HLC
			cur.UpdatedAt = now
			return cur
		}
		p, _ := ParseProgressPayload(op.Payload)
		var curState *ProgressState
		if ok && cur.Progress != nil {
			curState = cur.Progress
		}
		merged, _, _ := MergeProgress(curState, ProgressIncoming{OpHLC: op.HLC, DeviceID: deviceID, Payload: p})
		merged.ContentHash = p.ContentHash
		cur.Deleted = false
		cur.DeletedHLC = ""
		cur.Progress = &merged
		cur.HLC = merged.HLC
		cur.DeviceID = merged.DeviceID
		cur.UpdatedAt = now
		cur.Payload = progressToJSON(merged)
		cur.Entity = op.Entity
		cur.EntityID = op.EntityID
		cur.BookID = op.BookID
		return cur
	case EntityAnnotation:
		if op.Kind == KindDelete {
			cur.Deleted = true
			cur.DeletedHLC = op.HLC
			cur.DeletedNanos = m.nowNanos
			cur.HLC = op.HLC
			cur.DeviceID = deviceID
			cur.Payload = nil
			cur.UpdatedAt = now
			if cur.Entity == "" {
				cur.Entity, cur.EntityID, cur.BookID = op.Entity, op.EntityID, op.BookID
			}
			return cur
		}
		var base, incoming map[string]json.RawMessage
		if ok {
			_ = json.Unmarshal(cur.Payload, &base)
		}
		_ = json.Unmarshal(op.Payload, &incoming)
		merged, _ := LWW(base, cur.HLC, cur.DeviceID, incoming, op.HLC, deviceID)
		cur.Deleted = false
		cur.DeletedHLC = ""
		cur.Payload, _ = json.Marshal(merged)
		cur.HLC = op.HLC
		cur.DeviceID = deviceID
		cur.UpdatedAt = now
		cur.Entity, cur.EntityID, cur.BookID = op.Entity, op.EntityID, op.BookID
		return cur
	default:
		if op.Kind == KindDelete {
			cur.Deleted = true
			cur.DeletedHLC = op.HLC
			cur.DeletedNanos = m.nowNanos
			cur.HLC = op.HLC
			cur.DeviceID = deviceID
			cur.Payload = nil
			cur.UpdatedAt = now
			cur.Entity, cur.EntityID, cur.BookID = op.Entity, op.EntityID, op.BookID
			return cur
		}
		cur.Deleted = false
		cur.DeletedHLC = ""
		cur.Payload = op.Payload
		cur.HLC = op.HLC
		cur.DeviceID = deviceID
		cur.UpdatedAt = now
		cur.Entity, cur.EntityID, cur.BookID = op.Entity, op.EntityID, op.BookID
		return cur
	}
}

func progressToJSON(p ProgressState) json.RawMessage {
	m := map[string]any{
		"locator":          json.RawMessage(p.Locator),
		"totalProgression": p.TotalProgression,
		"explicitRewind":   p.ExplicitRewind,
		"hlc":              p.HLC,
		"deviceId":         p.DeviceID,
		"contentHash":      p.ContentHash,
	}
	if len(p.FurthestLocator) > 0 {
		m["furthestLocator"] = json.RawMessage(p.FurthestLocator)
	}
	m["furthestProgression"] = p.FurthestProgression
	b, _ := json.Marshal(m)
	return b
}

func (m *memStore) Pull(_ context.Context, _ string, cursor int64, limit int) ([]Change, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Change{}
	for _, c := range m.changes {
		if c.Cursor > cursor {
			out = append(out, c)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}

func (m *memStore) MaxCursor(_ context.Context, _ string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.seq, nil
}

func (m *memStore) Snapshot(_ context.Context, _ string) (Projection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	proj := Projection{Cursor: m.seq}
	keys := make([]string, 0, len(m.state))
	for k := range m.state {
		keys = append(keys, k)
	}
	sort.Strings(keys) // 确定性输出
	for _, k := range keys {
		st := m.state[k]
		if st.Deleted || len(st.Payload) == 0 {
			continue
		}
		switch st.Entity {
		case EntityBook:
			proj.Books = append(proj.Books, st.Payload)
		case EntityProgress:
			proj.Progress = append(proj.Progress, st.Payload)
		case EntityAnnotation:
			proj.Annotations = append(proj.Annotations, st.Payload)
		case EntityBookConfig:
			proj.Settings = append(proj.Settings, st.Payload)
		}
	}
	return proj, nil
}

// ---------- 测试辅助 ----------

// testEngine 构造一个使用固定墙钟的引擎（时间可控 → 断言可复现）。
func testEngine(t *testing.T, store SyncStore, device string, wallMs int64) *Engine {
	t.Helper()
	now := func() time.Time { return time.UnixMilli(wallMs) }
	e, err := NewEngine(store, device, now)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	return e
}

// makeHLC 用给定毫秒/计数/设备前缀构造 HLC 字符串。
func makeHLC(ms int64, seq uint32, dev string) string {
	h, err := NewHLC(dev, time.UnixMilli(ms))
	if err != nil {
		panic(err)
	}
	h.Seq = seq
	return h.String()
}

// opUUID 把测试里的可读名字（"op-1"）映射成合法 UUID。
//
// 引擎的 ValidateOp 要求 opId 是 UUID（否则会被 SQL 当成 uuid 列绑参而报 22P02），
// 因此夹具也必须给合法值；用确定性映射保证「同名 == 同一 opId」，幂等测试依赖这一点。
func opUUID(name string) string {
	sum := sha256.Sum256([]byte(name))
	sum[6] = (sum[6] & 0x0f) | 0x40 // version 4
	sum[8] = (sum[8] & 0x3f) | 0x80 // variant RFC 4122
	return fmt.Sprintf("%x-%x-%x-%x-%x", sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}

func progressOp(opID, bookID, hlc, device string, total float64, hash string, rewind bool) Op {
	payload, _ := json.Marshal(map[string]any{
		"locator": map[string]any{
			"href": "chapter-1.xhtml",
			"type": "application/xhtml+xml",
			"locations": map[string]any{
				"progression":      total,
				"totalProgression": total,
				"fragments":        []string{"epubcfi(/6/4!/4/2/2)"},
			},
		},
		"totalProgression": total,
		"explicitRewind":   rewind,
		"contentHash":      hash,
	})
	return Op{OpID: opUUID(opID), Entity: EntityProgress, EntityID: bookID, Kind: KindUpsert, HLC: hlc, DeviceID: device, Payload: payload}
}

func annotationOp(opID, annID string, hlc, device, color string) Op {
	payload, _ := json.Marshal(map[string]any{
		"type":    "highlight",
		"color":   color,
		"locator": map[string]any{"href": "chapter-1.xhtml", "type": "application/xhtml+xml"},
	})
	return Op{OpID: opUUID(opID), Entity: EntityAnnotation, EntityID: annID, Kind: KindUpsert, HLC: hlc, DeviceID: device, Payload: payload}
}

func deleteOp(opID, entity, id, hlc, device string) Op {
	return Op{OpID: opUUID(opID), Entity: entity, EntityID: id, Kind: KindDelete, HLC: hlc, DeviceID: device}
}

func mustPush(t *testing.T, e *Engine, user, device string, ops ...Op) PushResult {
	t.Helper()
	res, err := e.Push(context.Background(), user, device, ops)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	return res
}

// seq 用 ops 自带的 deviceId 推送（保证 HLC 设备前缀与 op.deviceId 一致）。
func seq(t *testing.T, e *Engine, ops ...Op) PushResult {
	t.Helper()
	device := ""
	if len(ops) > 0 {
		device = ops[0].DeviceID
	}
	return mustPush(t, e, "user-1", device, ops...)
}

// pushBy 允许显式指定 push 请求的 deviceId（模拟设备标识与 op 不一致的异常客户端）。
func pushBy(t *testing.T, e *Engine, device string, ops ...Op) PushResult {
	t.Helper()
	return mustPush(t, e, "user-1", device, ops...)
}

func stateOf(t *testing.T, s *memStore, entity, id string) PendingState {
	t.Helper()
	st, ok := s.state[stateKey(entity, id)]
	if !ok {
		t.Fatalf("state %s/%s not found", entity, id)
	}
	return st
}
