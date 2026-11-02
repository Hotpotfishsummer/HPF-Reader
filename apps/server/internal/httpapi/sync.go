package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// ---- DTO（与 openapi.yaml 的 SyncOp / SyncPushResponse / SyncChange 对齐）----

type syncOpDTO struct {
	OpID     string          `json:"opId"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entityId"`
	BookID   *string         `json:"bookId,omitempty"`
	Kind     string          `json:"kind"`
	HLC      string          `json:"hlc"`
	DeviceID string          `json:"deviceId,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

type syncPushRequest struct {
	DeviceID string      `json:"deviceId"`
	Ops      []syncOpDTO `json:"ops"`
}

type syncPushResultDTO struct {
	OpID   string `json:"opId"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

type syncPushResponse struct {
	Results []syncPushResultDTO `json:"results"`
	Cursor  int64               `json:"cursor"`
}

type syncChangeDTO struct {
	Cursor   int64           `json:"cursor"`
	Entity   string          `json:"entity"`
	EntityID string          `json:"entityId"`
	BookID   *string         `json:"bookId,omitempty"`
	Kind     string          `json:"kind"`
	HLC      string          `json:"hlc"`
	DeviceID *string         `json:"deviceId,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

type syncPullResponse struct {
	Changes    []syncChangeDTO `json:"changes"`
	NextCursor int64           `json:"nextCursor"`
	HasMore    bool            `json:"hasMore"`
}

// handleSyncPush 接收客户端 outbox 中的操作，做服务端权威合并。
//
// 契约要点：
//   - 整批 op 在同一事务里应用（store.Push）；
//   - opId 幂等（7 天窗口），重复推送返回既有结果；
//   - 返回 cursor 是服务端已分配到的最新游标，客户端不得自行推进。
func (s *Server) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req syncPushRequest
	if err := decodeJSON(w, r, &req, 4<<20); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if len(req.Ops) == 0 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "ops must not be empty", nil)
		return
	}
	if len(req.Ops) > syncengine.MaxOpsPerPush {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "too many ops in one push", map[string]any{
			"max": syncengine.MaxOpsPerPush,
		})
		return
	}
	deviceID := req.DeviceID
	if deviceID == "" {
		deviceID = claims.DeviceID
	}
	if deviceID != "" && !idgen.IsUUID(deviceID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "deviceId must be a UUID", nil)
		return
	}
	if deviceID != "" {
		// 记录设备活跃时间；设备不存在不算致命错误（客户端可能刚重装）。
		if err := s.store.TouchDevice(r.Context(), claims.UserID, deviceID); err != nil {
			s.log.Debug("touch device", "error", err, "device_id", deviceID)
		}
	}

	ops := make([]syncengine.Op, 0, len(req.Ops))
	for _, o := range req.Ops {
		op := syncengine.Op{
			OpID:     o.OpID,
			Entity:   o.Entity,
			EntityID: o.EntityID,
			BookID:   o.BookID,
			Kind:     o.Kind,
			HLC:      o.HLC,
			DeviceID: firstNonEmptyStr(o.DeviceID, deviceID),
			Payload:  o.Payload,
		}
		ops = append(ops, op)
	}

	res, err := s.syncEngine.Push(r.Context(), claims.UserID, deviceID, ops)
	if err != nil {
		s.log.Error("sync push failed", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, codeInternal, "sync push failed", nil)
		return
	}

	applied, ignored, idemHits := 0, 0, 0
	out := syncPushResponse{Results: make([]syncPushResultDTO, 0, len(res.Outcomes))}
	for i, o := range res.Outcomes {
		status := "applied"
		reason := ""
		if o.Replayed {
			idemHits++
		}
		switch {
		case o.Replayed:
			// 幂等重放：契约里没有 duplicate 之外的语义，这里统一按 applied 回复，
			// 让客户端可以无脑把该 op 从 outbox 移除。
			status = "applied"
			reason = "duplicate"
		case o.Status == syncengine.StatusApplied:
			applied++
			s.metrics.ObserveMerge(string(o.Reason))
		default:
			if isRejection(o.Reason) {
				status = "rejected"
				reason = string(o.Reason)
			} else {
				// 陈旧写入：服务端权威状态未变，但对客户端而言这个 op「已经处理完毕」。
				status = "applied"
				reason = string(o.Reason)
				ignored++
			}
		}
		item := syncPushResultDTO{OpID: o.OpID, Status: status}
		if reason != "" {
			item.Reason = reason
		}
		if status == "rejected" && i < len(req.Ops) {
			item.OpID = res.Outcomes[i].OpID
		}
		out.Results = append(out.Results, item)
	}
	out.Cursor = res.Cursor
	s.metrics.ObserveSyncPush(applied, ignored, idemHits)
	writeJSON(w, http.StatusOK, out)
}

// isRejection 判断裁决原因是否属于「请求本身非法」（对应契约的 rejected）。
func isRejection(reason syncengine.Reason) bool {
	if reason == "" {
		return false
	}
	const prefix = "rejected:"
	r := string(reason)
	return len(r) >= len(prefix) && r[:len(prefix)] == prefix
}

// handleSyncPull 拉取游标之后的变更。
func (s *Server) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	cursor, err := queryInt64(r, "cursor", 0)
	if err != nil || cursor < 0 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "cursor must be a non-negative integer", nil)
		return
	}
	limit, err := queryInt(r, "limit", 500, 1, 1000)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "limit must be an integer", nil)
		return
	}
	res, err := s.syncEngine.Pull(r.Context(), claims.UserID, cursor, limit)
	if err != nil {
		s.log.Error("sync pull failed", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, codeInternal, "sync pull failed", nil)
		return
	}
	changes := make([]syncChangeDTO, 0, len(res.Changes))
	for _, c := range res.Changes {
		item := syncChangeDTO{
			Cursor:   c.Cursor,
			Entity:   c.Entity,
			EntityID: c.EntityID,
			BookID:   c.BookID,
			Kind:     c.Kind,
			HLC:      c.HLC,
			Payload:  c.Payload,
		}
		if c.DeviceID != "" {
			deviceID := c.DeviceID
			item.DeviceID = &deviceID
		}
		changes = append(changes, item)
	}
	writeJSON(w, http.StatusOK, syncPullResponse{
		Changes:    changes,
		NextCursor: res.NextCursor,
		HasMore:    res.HasMore,
	})
}

// handleSyncSnapshot 返回全量投影（新设备首同步 / 游标失效时使用）。
func (s *Server) handleSyncSnapshot(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	proj, err := s.syncEngine.Snapshot(r.Context(), claims.UserID)
	if err != nil {
		s.log.Error("sync snapshot failed", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, codeInternal, "sync snapshot failed", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cursor":      proj.Cursor,
		"books":       proj.Books,
		"progress":    proj.Progress,
		"annotations": proj.Annotations,
		"settings":    proj.Settings,
	})
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
