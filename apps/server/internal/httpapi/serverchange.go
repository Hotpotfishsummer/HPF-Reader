package httpapi

import (
	"context"
	"encoding/json"
	"fmt"

	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// 服务端自身发起的变更（REST 创建的标注 / 删除）也必须进入 change_log，
// 否则其它设备永远拉不到这些结果 —— 这正是「游标必须服务端分配」的意义。
const (
	entityAnnotation = "annotation"
	entityBook       = "book"
	kindUpsert       = "upsert"
	kindDelete       = "delete"
)

// syncChangeInput 描述一条要追加到 change_log 的服务端变更。
type syncChangeInput struct {
	Entity   string
	EntityID string
	BookID   *string
	Kind     string
	HLC      string
	Payload  json.RawMessage
}

// recordServerChange 把服务端自建实体写成一条 change_log 行。
//
// 复用 SyncStore（与客户端 push 完全同一条路径）：游标分配、事务语义、
// 幂等表处理都不存在第二套实现。
func (s *Server) recordServerChange(ctx context.Context, userID string, in syncChangeInput) error {
	if s.syncStore == nil {
		return fmt.Errorf("sync store not configured")
	}
	_, err := s.syncStore.AppendServerChange(ctx, userID, syncengine.StoreOp{
		Entity:   in.Entity,
		EntityID: in.EntityID,
		BookID:   in.BookID,
		Kind:     in.Kind,
		HLC:      in.HLC,
		Payload:  in.Payload,
	})
	return err
}
