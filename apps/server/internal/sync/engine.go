package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
)

// 实体类型（与 api/openapi.yaml 的 SyncOp.entity 枚举一致）。
const (
	EntityProgress   = "progress"
	EntityAnnotation = "annotation"
	EntityBook       = "book"
	EntityBookConfig = "book_config"
)

// 操作类型。
const (
	KindUpsert = "upsert"
	KindDelete = "delete"
)

// MaxOpsPerPush 与 openapi.yaml 的 maxItems: 500 对齐。
const MaxOpsPerPush = 500

// ErrNotFound 表示实体不存在。
var ErrNotFound = errors.New("sync: not found")

// Op 是一条待推送的同步操作。
type Op struct {
	OpID     string          `json:"opId"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entityId"`
	BookID   *string         `json:"bookId,omitempty"`
	Kind     string          `json:"kind"`
	HLC      string          `json:"hlc"`
	DeviceID string          `json:"deviceId,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// OpOutcome 是单条 op 的裁决结果。
type OpOutcome struct {
	OpID     string
	Status   MergeStatus
	Reason   Reason
	Replayed bool // opId 命中幂等窗口，直接复用上次结果
}

func (o OpOutcome) Err() error {
	if o.Reason == "" {
		return nil
	}
	return errors.New(string(o.Reason))
}

// PushResult 是一次 push 的汇总。
type PushResult struct {
	Outcomes []OpOutcome
	Cursor   int64
}

// AppliedCount 返回真正写入变更日志的 op 数。
func (r PushResult) AppliedCount() int {
	n := 0
	for _, o := range r.Outcomes {
		if o.Status == StatusApplied && !o.Replayed {
			n++
		}
	}
	return n
}

// Change 是一条 change_log 记录（服务端权威结果）。
type Change struct {
	Cursor   int64           `json:"cursor"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entityId"`
	BookID   *string         `json:"bookId,omitempty"`
	Kind     string          `json:"kind"`
	HLC      string          `json:"hlc"`
	DeviceID string          `json:"deviceId,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// PullResult 是一次 pull 的结果。
type PullResult struct {
	Changes    []Change
	NextCursor int64
	HasMore    bool
}

// PendingState 是服务端已确认的实体状态（合并输入）。
type PendingState struct {
	Entity   string
	EntityID string
	BookID   *string
	// Deleted 为 true 表示当前处于墓碑状态。
	Deleted bool
	// DeletedHLC 是墓碑写入时的 HLC。
	DeletedHLC string
	// DeletedNanos 是墓碑写入的本地时间（用于墓碑窗口判定）。
	DeletedNanos int64
	// Payload 是当前实体载荷（deleted 时保留墓碑前内容，仅审计）。
	Payload json.RawMessage
	// HLC 是当前载荷的合并时钟。
	HLC string
	// DeviceID 是当前载荷的来源设备。
	DeviceID string
	// Progress 仅在 Entity == "progress" 时有效。
	Progress *ProgressState
	// UpdatedAt 是最近一次变更的本地时间。
	UpdatedAt time.Time
}

// StoreOp 是裁决后需要持久化的变更上下文。
type StoreOp struct {
	Entity   string
	EntityID string
	BookID   *string
	Kind     string
	HLC      string
	DeviceID string
	Payload  json.RawMessage
	// ContentHash 仅 progress 使用，写入状态行便于下次合并判断副本。
	ContentHash string
}

// Projection 是新设备首同步 / 游标失效时使用的全量快照。
type Projection struct {
	Cursor      int64
	Books       []json.RawMessage
	Progress    []json.RawMessage
	Annotations []json.RawMessage
	Settings    []json.RawMessage
}

// SyncStore 是同步引擎依赖的持久化接口。
//
// 关键约束：Push 必须在**同一个事务**中完成幂等记录、状态写入与 change_log 分配，
// 保证「全成或全败」，并让游标严格单调。
type SyncStore interface {
	// LookupOp 查询 opId 是否已应用（幂等窗口内），返回上次的裁决结果。
	LookupOp(ctx context.Context, userID, opID string) (OpOutcome, bool, error)
	// LoadPending 读取实体当前状态；第二返回值表示是否存在。
	LoadPending(ctx context.Context, userID, entity, entityID string) (PendingState, bool, error)
	// Push 在一个事务内应用一批已裁决的变更（分配游标 + 写 change_log）。
	Push(ctx context.Context, userID, deviceID string, ops []StoreOp, idem []IdempotencyRecord) (int64, error)
	// Pull 返回 cursor 之后至多 limit 条变更。
	Pull(ctx context.Context, userID string, cursor int64, limit int) ([]Change, error)
	// MaxCursor 返回该用户当前最大的 change_log 游标（无变更时为 0）。
	MaxCursor(ctx context.Context, userID string) (int64, error)
	// Snapshot 返回全量投影（新设备首同步）。
	Snapshot(ctx context.Context, userID string) (Projection, error)
}

// IdempotencyRecord 是一条待写入的幂等记录。
type IdempotencyRecord struct {
	OpID     string
	DeviceID string
	Result   json.RawMessage
}

// Engine 是服务端权威的同步引擎。
// clock 是服务端自己的 HLC（用于服务端发起的变更，如 REST 创建的标注）；
// 客户端 push 的 op 一律使用客户端给出的 HLC 参与字段级 LWW。
type Engine struct {
	store SyncStore
	clock *Clock
	now   func() time.Time
}

// NewEngine 构造引擎；now 为空时使用 time.Now。
func NewEngine(store SyncStore, devicePrefix string, now func() time.Time) (*Engine, error) {
	if now == nil {
		now = time.Now
	}
	clock, err := NewClock(devicePrefix, now())
	if err != nil {
		return nil, err
	}
	return &Engine{store: store, clock: clock, now: now}, nil
}

// ServerHLC 返回一个服务端生成的 HLC（严格递增）。
func (e *Engine) ServerHLC() string {
	h, err := e.clock.Send(e.now())
	if err != nil {
		// 计数器/时间溢出属于不可恢复状态；退化到墙上时间戳，保证不 panic。
		return fmt.Sprintf("%0*x-%08x-%s", hlcTimeDigits, uint64(e.now().UnixMilli()), 0, e.clock.Device())
	}
	return h.String()
}

// ClockDevice 暴露设备前缀（写入审计用）。
func (e *Engine) ClockDevice() string { return e.clock.Device() }

// InvalidOpError 是字段级的 op 校验错误。
//
// 带 Field 是为了让 HTTP 层能明确告诉客户端「是哪一列错了、错在哪」——
// 只回一句 "sync push failed" 会让客户端无从修复。
type InvalidOpError struct {
	Field string
	Msg   string
}

func (e *InvalidOpError) Error() string { return e.Field + " " + e.Msg }

func invalidOp(field, msg string) error { return &InvalidOpError{Field: field, Msg: msg} }

// ValidateOp 校验单条 op 的字段合法性。
//
// 必须在**进入数据库之前**挡住所有会让 SQL 类型转换失败的输入：
// 把非 UUID 字符串绑进 uuid 列会得到 SQLSTATE 22P02，之前它会冒成 500，
// 而客户端把 5xx 当可重试错误 —— 一条永远不可能成功的 op 会被无限重试。
//
// 注意 entityId 的形态随实体而定：book_config 只写 change_log（不进 uuid 列，
// 键名可以是任意配置键），其余实体的 entityId 都是 uuid 主键。
func ValidateOp(op Op) error {
	if op.OpID == "" {
		return invalidOp("opId", "is required")
	}
	if !idgen.IsUUID(op.OpID) {
		return invalidOp("opId", "must be a UUID")
	}
	switch op.Entity {
	case EntityProgress, EntityAnnotation, EntityBook, EntityBookConfig:
	default:
		return invalidOp("entity", fmt.Sprintf("unknown entity %q", op.Entity))
	}
	if op.EntityID == "" {
		return invalidOp("entityId", "is required")
	}
	if op.Entity != EntityBookConfig && !idgen.IsUUID(op.EntityID) {
		return invalidOp("entityId", "must be a UUID")
	}
	if op.BookID != nil && *op.BookID != "" && !idgen.IsUUID(*op.BookID) {
		return invalidOp("bookId", "must be a UUID")
	}
	switch op.Kind {
	case KindUpsert, KindDelete:
	default:
		return invalidOp("kind", fmt.Sprintf("unknown kind %q", op.Kind))
	}
	if !IsValidHLC(op.HLC) {
		return invalidOp("hlc", fmt.Sprintf("malformed hlc %q", op.HLC))
	}
	// 注意：这里不校验 op.DeviceID 的形态。引擎从不把它直接绑进 uuid 列
	// （实体的 device_id 一律取本批的 deviceID），设备 ID 的校验由 HTTP 入口负责。
	// 这样既守住了「不产生 22P02」，也不会把客户端历史上用过的短设备前缀一刀切掉。
	return nil
}

// Push 应用一批变更。
//
// 流程：
//  1. 逐条校验（非法 op 标 rejected，不阻塞其它 op）；
//  2. 幂等查询（7 天窗口内命中直接复用上次结果）；
//  3. 与 PendingState 做服务端权威合并，得到 applied/ignored；
//  4. 把 applied 的变更放进同一事务：分配游标 + 写 change_log + 写幂等记录。
func (e *Engine) Push(ctx context.Context, userID, deviceID string, ops []Op) (PushResult, error) {
	res := PushResult{Outcomes: make([]OpOutcome, 0, len(ops))}
	if len(ops) > MaxOpsPerPush {
		return res, fmt.Errorf("too many ops: %d > %d", len(ops), MaxOpsPerPush)
	}
	storeOps := make([]StoreOp, 0, len(ops))
	idem := make([]IdempotencyRecord, 0, len(ops))
	now := e.now()

	for _, op := range ops {
		if deviceID == "" {
			deviceID = op.DeviceID
		}
		if err := ValidateOp(op); err != nil {
			res.Outcomes = append(res.Outcomes, OpOutcome{OpID: op.OpID, Status: StatusIgnored, Reason: Reason("rejected: " + err.Error())})
			continue
		}
		if prev, ok, err := e.store.LookupOp(ctx, userID, op.OpID); err != nil {
			return res, fmt.Errorf("lookup op %s: %w", op.OpID, err)
		} else if ok {
			prev.Replayed = true
			if prev.Status == "" {
				prev.Status = StatusApplied
			}
			res.Outcomes = append(res.Outcomes, prev)
			continue
		}

		cur, found, err := e.store.LoadPending(ctx, userID, op.Entity, op.EntityID)
		if err != nil {
			return res, fmt.Errorf("load pending %s/%s: %w", op.Entity, op.EntityID, err)
		}
		var curPtr *PendingState
		if found {
			curPtr = &cur
		}

		apply, reason := shouldApply(op, curPtr, now)
		out := OpOutcome{OpID: op.OpID, Reason: reason}
		if apply {
			out.Status = StatusApplied
		} else {
			out.Status = StatusIgnored
		}
		res.Outcomes = append(res.Outcomes, out)

		// 幂等记录对「被忽略」的 op 也要落库：否则该 op 会被无限重试。
		// change_log 只记录真正改变权威状态的 op。
		rec := IdempotencyRecord{OpID: op.OpID, DeviceID: deviceID, Result: outcomeJSON(out)}
		idem = append(idem, rec)
		if apply {
			contentHash := ""
			if op.Entity == EntityProgress {
				if p, perr := ParseProgressPayload(op.Payload); perr == nil {
					contentHash = p.ContentHash
				}
			}
			storeOps = append(storeOps, StoreOp{
				Entity:      op.Entity,
				EntityID:    op.EntityID,
				BookID:      op.BookID,
				Kind:        op.Kind,
				HLC:         op.HLC,
				DeviceID:    deviceID,
				Payload:     op.Payload,
				ContentHash: contentHash,
			})
		}
	}

	if len(idem) > 0 {
		maxSeq, err := e.store.Push(ctx, userID, deviceID, storeOps, idem)
		if err != nil {
			return res, err
		}
		res.Cursor = maxSeq
	}
	if res.Cursor == 0 {
		maxSeq, err := e.store.MaxCursor(ctx, userID)
		if err != nil {
			return res, err
		}
		res.Cursor = maxSeq
	}
	return res, nil
}

// shouldApply 是合并裁决的总入口，按实体分派到具体规则。
func shouldApply(op Op, cur *PendingState, now time.Time) (bool, Reason) {
	switch op.Entity {
	case EntityProgress:
		return shouldApplyProgress(op, cur)
	case EntityAnnotation:
		return shouldApplyAnnotation(op, cur, now)
	default:
		// book / book_config：字段级 LWW + 删除墓碑（remove-wins）。
		if op.Kind == KindDelete {
			if cur == nil {
				return false, ReasonTombstone
			}
			if CompareHLC(op.HLC, cur.HLC) > 0 || !cur.Deleted {
				return true, ReasonTombstone
			}
			return false, ReasonOlderHLC
		}
		if cur == nil || cur.Deleted {
			if cur != nil && cur.Deleted {
				if ok, _ := ShouldApplyAnnotation(cur.DeletedHLC, cur.DeletedNanos, op.HLC, now.UnixNano()); !ok {
					return false, ReasonTombstone
				}
			}
			return true, ReasonNewEntity
		}
		if CompareHLC(op.HLC, cur.HLC) > 0 {
			return true, ReasonNewer
		}
		if CompareHLC(op.HLC, cur.HLC) == 0 && op.DeviceID > cur.DeviceID {
			return true, ReasonNewer
		}
		return false, ReasonOlderHLC
	}
}

func shouldApplyProgress(op Op, cur *PendingState) (bool, Reason) {
	if op.Kind == KindDelete {
		if cur == nil {
			return false, ReasonTombstone
		}
		return true, ReasonTombstone
	}
	payload, err := ParseProgressPayload(op.Payload)
	if err != nil {
		return false, Reason("invalid payload: " + err.Error())
	}
	var curState *ProgressState
	if cur != nil {
		cp := cur.Progress
		if cp == nil {
			// 兼容：状态行存在但没有 progress 结构时用 HLC 兜底。
			cp = &ProgressState{HLC: cur.HLC, DeviceID: cur.DeviceID}
		}
		if cur.Deleted {
			// 墓碑存在时，只有更新的 HLC 才能重新建立进度（重新导入场景会分配新 book_id）。
			if CompareHLC(op.HLC, cur.DeletedHLC) <= 0 {
				return false, ReasonTombstone
			}
			curState = nil
		} else {
			curState = cp
		}
	}
	_, status, reason := MergeProgress(curState, ProgressIncoming{
		OpHLC:    op.HLC,
		DeviceID: op.DeviceID,
		Payload:  payload,
	})
	return status == StatusApplied, reason
}

func shouldApplyAnnotation(op Op, cur *PendingState, now time.Time) (bool, Reason) {
	if op.Kind == KindDelete {
		if cur == nil {
			// 删除一个服务端不知道的实体：记录墓碑（客户端可能离线期间被清理）。
			return true, ReasonTombstone
		}
		if cur.Deleted {
			return false, ReasonTombstone
		}
		return true, ReasonTombstone
	}
	if cur != nil && cur.Deleted {
		ok, reason := ShouldApplyAnnotation(cur.DeletedHLC, cur.DeletedNanos, op.HLC, now.UnixNano())
		if !ok {
			return false, reason
		}
		return true, ReasonNewEntity
	}
	if cur == nil {
		return true, ReasonNewEntity
	}
	if CompareHLC(op.HLC, cur.HLC) > 0 {
		return true, ReasonNewer
	}
	if CompareHLC(op.HLC, cur.HLC) == 0 && op.DeviceID > cur.DeviceID {
		return true, ReasonNewer
	}
	return false, ReasonOlderHLC
}

func outcomeJSON(o OpOutcome) json.RawMessage {
	b, err := json.Marshal(map[string]string{"status": string(o.Status), "reason": string(o.Reason)})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}

// Pull 拉取游标之后的变更。
func (e *Engine) Pull(ctx context.Context, userID string, cursor int64, limit int) (PullResult, error) {
	if limit <= 0 {
		limit = 500
	}
	// 多取一条用于判定 hasMore，避免额外一次 count 查询。
	changes, err := e.store.Pull(ctx, userID, cursor, limit+1)
	if err != nil {
		return PullResult{}, err
	}
	res := PullResult{NextCursor: cursor}
	if len(changes) > limit {
		res.HasMore = true
		changes = changes[:limit]
	}
	res.Changes = changes
	if len(changes) > 0 {
		res.NextCursor = changes[len(changes)-1].Cursor
	}
	return res, nil
}

// Snapshot 返回全量投影，并把 cursor 对齐到最新（新设备首同步）。
func (e *Engine) Snapshot(ctx context.Context, userID string) (Projection, error) {
	proj, err := e.store.Snapshot(ctx, userID)
	if err != nil {
		return Projection{}, err
	}
	maxSeq, err := e.store.MaxCursor(ctx, userID)
	if err != nil {
		return Projection{}, err
	}
	proj.Cursor = maxSeq
	if proj.Books == nil {
		proj.Books = []json.RawMessage{}
	}
	if proj.Progress == nil {
		proj.Progress = []json.RawMessage{}
	}
	if proj.Annotations == nil {
		proj.Annotations = []json.RawMessage{}
	}
	if proj.Settings == nil {
		proj.Settings = []json.RawMessage{}
	}
	return proj, nil
}

// SyncUserClock 是一个无状态辅助：把服务端时钟推进到已观测的客户端 HLC 之后。
// 单体部署下用不到（服务端 HLC 仅用于服务端自建实体），保留给多副本部署。
type SyncUserClock struct{ clock *Clock }

// Observe 见 Clock.Observe。
func (s *SyncUserClock) Observe(hlc string, now time.Time) (HLC, error) {
	remote, err := Parse(hlc)
	if err != nil {
		return HLC{}, err
	}
	return s.clock.Observe(remote, now)
}
