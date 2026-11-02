package store

import (
	"encoding/json"
	"testing"

	syncengine "github.com/hpf-reader/hpf-reader/apps/server/internal/sync"
)

// TestGlossarySyncPropagatesToOtherDevice 锁定**跨设备同步**。
//
// 场景：设备 A 修改术语表 → 设备 B 通过增量拉取（Pull）拿到这条变更。
//
// 这是 M5-3「服务端化」的判据：术语表若只在本地，换设备就丢；
// 若只在服务端而不进 change_log，其它设备永远看不到改动。
//
// 走的是 book_config 通道（entityId = glossary:<bookId>:<key>），
// 所以这条测试同时验证了「非 UUID 键在真实 Pull 链路里可用」。
func TestGlossarySyncPropagatesToOtherDevice(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	// 设备 A：写术语表 + 写同步日志（模拟 PUT /v1/books/{id}/glossary）。
	term := GlossaryTerm{
		Key: "darcy", Display: "Mr. Darcy", Target: "达西先生",
		Aliases: []string{"Darcy"}, Source: TermUserConfirmed,
	}
	if _, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{term}); err != nil {
		t.Fatalf("put terms: %v", err)
	}
	if err := s.SyncGlossaryTerm(ctx, user, bookID, term.Key, term); err != nil {
		t.Fatalf("sync term: %v", err)
	}

	// 设备 B：从游标 0 增量拉取。
	syncStore := NewSyncStore(s)
	changes, err := syncStore.Pull(ctx, user, 0, 100)
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(changes) == 0 {
		t.Fatalf("设备 B 拉不到任何变更（同步链路断了）")
	}

	var found *syncengine.Change
	for i := range changes {
		if changes[i].Entity == syncengine.EntityBookConfig {
			found = &changes[i]
		}
	}
	if found == nil {
		t.Fatalf("设备 B 未收到 book_config 变更: %+v", changes)
	}
	wantID := GlossaryEntityID(bookID, "darcy")
	if found.EntityID != wantID {
		t.Errorf("实体 id = %q, want %q", found.EntityID, wantID)
	}

	// 载荷必须能被设备 B 直接渲染成一条术语，不必再回源请求。
	var pl glossaryChangePayload
	if err := json.Unmarshal(found.Payload, &pl); err != nil {
		t.Fatalf("解析同步载荷: %v", err)
	}
	if pl.Target != "达西先生" {
		t.Errorf("同步载荷 target = %q, want 达西先生", pl.Target)
	}
	if pl.Source != string(TermUserConfirmed) {
		t.Errorf("同步载荷 source = %q, want user_confirmed", pl.Source)
	}
}

// TestGlossarySyncDeletePropagatesTombstone 锁定**删除同步**。
//
// 只测 upsert 会漏掉删除路径：没有墓碑，其它设备只能靠「列表里少了一条」
// 推断删除，而增量拉取永远看不到「少了」——那条术语会在别的设备上永久留存。
//
// 顺带覆盖 F-06 那一类缺陷：delete 分支若把 entityId 当 UUID 用，这里会 22P02。
func TestGlossarySyncDeletePropagatesTombstone(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	term := GlossaryTerm{Key: "darcy", Display: "Darcy", Target: "达西", Source: TermLLMExtracted}
	if _, err := s.PutGlossaryTerms(ctx, user, bookID, "zh", []GlossaryTerm{term}); err != nil {
		t.Fatalf("put: %v", err)
	}
	if err := s.SyncGlossaryTerm(ctx, user, bookID, term.Key, term); err != nil {
		t.Fatalf("sync upsert: %v", err)
	}
	if _, err := s.DeleteGlossaryTerms(ctx, user, bookID, "zh", []string{term.Key}); err != nil {
		t.Fatalf("delete term: %v", err)
	}
	if err := s.SyncGlossaryTermDelete(ctx, user, bookID, term.Key); err != nil {
		t.Fatalf("sync delete: %v", err)
	}

	changes, err := NewSyncStore(s).Pull(ctx, user, 0, 100)
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	// 最后一条应是 delete 墓碑。
	var last *syncengine.Change
	for i := range changes {
		if changes[i].Entity == syncengine.EntityBookConfig {
			last = &changes[i]
		}
	}
	if last == nil {
		t.Fatalf("未收到 book_config 变更")
	}
	if last.Kind != "delete" {
		t.Errorf("最后一条应为 delete 墓碑，实际 %q", last.Kind)
	}

	// LoadPending 对墓碑应返回 found=false（删除后不复活）。
	_, found, err := NewSyncStore(s).LoadPending(ctx, user, syncengine.EntityBookConfig,
		GlossaryEntityID(bookID, term.Key))
	if err != nil {
		t.Fatalf("load pending: %v", err)
	}
	if found {
		t.Errorf("墓碑后 LoadPending 应返回 found=false，实际 true")
	}
}

// TestParseGlossaryEntityID 锁定解析函数，供客户端与调试使用。
func TestParseGlossaryEntityID(t *testing.T) {
	cases := []struct {
		in   string
		book string
		key  string
		ok   bool
	}{
		{"glossary:b1:darcy", "b1", "darcy", true},
		{"glossary:b1:mr darcy", "b1", "mr darcy", true},
		{"glossary:b1:", "", "", false},
		{"glossary::darcy", "", "", false},
		{"glossary:b1", "", "", false},
		{"font:serif", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		book, key, ok := ParseGlossaryEntityID(c.in)
		if ok != c.ok || book != c.book || key != c.key {
			t.Errorf("ParseGlossaryEntityID(%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.in, book, key, ok, c.book, c.key, c.ok)
		}
	}
}
