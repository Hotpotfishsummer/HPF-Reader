package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// GlossaryEntityID 拼出术语在同步通道里的实体 id。
//
// 格式：glossary:<bookId>:<normKey>
//
// 为什么复用 book_config 通道而不是新增同步实体类型：
//
//   - 新增实体类型要改 4–5 处（ValidateOp 的 UUID 校验、merge 分发、RLS 策略、客户端 apply）；
//   - book_config 的语义就是「字段级 LWW 的书籍级配置」，术语表条目正是这个语义；
//   - 复用后**无需改客户端**，术语表编辑自然随书配置同步到其它设备。
//
// 注意：entityId 是任意键名而不是 UUID，所以 book_config 分支必须走 loadBookConfig
// （读 change_log）而不是 loadProgress（那会把非 UUID 绑进 uuid 列，触发 22P02）。
// 这个陷阱在 F-05/F-06 里已经踩过，测试用 upsert + delete 成对覆盖。
func GlossaryEntityID(bookID, key string) string {
	return "glossary:" + bookID + ":" + key
}

// glossaryChangePayload 是术语同步事件的载荷。
//
// 带上 display/target/aliases/source 全字段：
// 其它设备拉到后要能直接渲染成一条术语，而不是再发一次 GET 回源。
type glossaryChangePayload struct {
	Display string   `json:"display"`
	Target  string   `json:"target"`
	Aliases []string `json:"aliases,omitempty"`
	Source  string   `json:"source"`
}

// SyncGlossaryTerm 把一条术语变更写进同步通道（change_log），供其它设备拉取。
//
// 与 PutGlossaryTerms 是**两套存储但一次用户动作**：
//
//   - glossary_terms 表为「翻译时快速取全书术语」而存在（热路径）；
//   - change_log 为「同步到其它设备」而存在（游标机制）。
//
// 两边都要写：只写表则别的设备永远看不到术语改动；
// 只写日志则翻译时每块都要翻日志，太慢。
func (s *Store) SyncGlossaryTerm(ctx context.Context, userID, bookID, key string, term GlossaryTerm) error {
	payload, err := json.Marshal(glossaryChangePayload{
		Display: term.Display, Target: term.Target, Aliases: term.Aliases, Source: string(term.Source),
	})
	if err != nil {
		return wrap(err)
	}
	bookIDCopy := bookID
	_, err = NewSyncStore(s).AppendServerChange(ctx, userID, syncengine.StoreOp{
		Entity:   syncengine.EntityBookConfig,
		EntityID: GlossaryEntityID(bookID, key),
		BookID:   &bookIDCopy,
		Kind:     syncengine.KindUpsert,
		HLC:      pseudoHLC(time.Now()),
		Payload:  payload,
	})
	return wrap(err)
}

// SyncGlossaryTermDelete 把一条术语删除写进同步通道。
//
// 墓碑（KindDelete）是必要的：没有墓碑，其它设备只能靠「服务端返回的列表里少了一条」
// 来推断删除，而增量拉取永远看不到「少了」，那条术语会在别的设备上永久留存。
func (s *Store) SyncGlossaryTermDelete(ctx context.Context, userID, bookID, key string) error {
	bookIDCopy := bookID
	_, err := NewSyncStore(s).AppendServerChange(ctx, userID, syncengine.StoreOp{
		Entity:   syncengine.EntityBookConfig,
		EntityID: GlossaryEntityID(bookID, key),
		BookID:   &bookIDCopy,
		Kind:     syncengine.KindDelete,
		HLC:      pseudoHLC(time.Now()),
		Payload:  json.RawMessage(`{}`),
	})
	return wrap(err)
}

// ParseGlossaryEntityID 从同步实体 id 里解出 (bookId, key)。
//
// 供客户端与调试使用。格式错误返回 ok=false 而不是报错：
// 同步通道里可能有别的 book_config 键，它们不是术语，不该让解析失败。
func ParseGlossaryEntityID(entityID string) (bookID, key string, ok bool) {
	const prefix = "glossary:"
	if len(entityID) <= len(prefix) || entityID[:len(prefix)] != prefix {
		return "", "", false
	}
	rest := entityID[len(prefix):]
	for i := 0; i < len(rest); i++ {
		if rest[i] == ':' {
			if i == 0 || i == len(rest)-1 {
				return "", "", false
			}
			return rest[:i], rest[i+1:], true
		}
	}
	return "", "", false
}

var _ = fmt.Sprintf
