package store

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/corrections"
)

// TestAppendCorrectionIsAppendOnlyAndIdempotent 锁定修正日志的两个性质。
//
// ① append-only：日志是事件流，不是状态快照。改状态必须追加新事件。
// ② 幂等：客户端重试同一 (book_id, seq) 不产生重复事件。
//
// 第二条尤其重要——移动端离线队列会重发，若每次重发都插一条，
// 重放时同一意图被应用多次，用户会看到分组跳变。
func TestAppendCorrectionIsAppendOnlyAndIdempotent(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	payload := json.RawMessage(`{"keyA":"darcy","keyB":"mr darcy"}`)
	ev1, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpMerge, payload)
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if ev1.Seq != 1 || ev1.Op != corrections.OpMerge {
		t.Fatalf("事件内容不符: %+v", ev1)
	}

	// 同一 seq 重试：必须返回既有那条，且不新增行。
	ev2, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpMerge, payload)
	if err != nil {
		t.Fatalf("append retry: %v", err)
	}
	if ev2.ID != ev1.ID {
		t.Errorf("重试产生了新事件（应幂等返回原事件）: %s vs %s", ev1.ID, ev2.ID)
	}

	all, err := s.ListCorrections(ctx, bookID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("重试后应仍只有 1 条事件，实际 %d", len(all))
	}
}

// TestListCorrectionsOrdersBySeq 锁定按 seq 排序（不是 created_at）。
//
// 时钟回拨会让 created_at 乱序；seq 由客户端单调生成，不会。
func TestListCorrectionsOrdersBySeq(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	// 故意乱序插入。
	for _, seq := range []int64{5, 2, 9} {
		if _, err := s.AppendCorrection(ctx, user, bookID, seq, corrections.OpLock,
			json.RawMessage(`{"key":"darcy"}`)); err != nil {
			t.Fatalf("append seq=%d: %v", seq, err)
		}
	}
	all, err := s.ListCorrections(ctx, bookID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("应 3 条，实际 %d", len(all))
	}
	want := []int64{2, 5, 9}
	for i, ev := range all {
		if ev.Seq != want[i] {
			t.Errorf("第 %d 条 seq = %d, want %d（必须按 seq 排序）", i, ev.Seq, want[i])
		}
	}
}

// TestBlockedPairsSurviveRoundTrip 锁定负样本对的写入与读回。
//
// 负样本对是「防重跑回退」的唯一机制，读回来必须完整。
func TestBlockedPairsSurviveRoundTrip(t *testing.T) {
	s, ctx := testStore(t)
	_, bookID := correctionFixture(t, s, ctx)

	if err := s.UpsertBlockedPairs(ctx, bookID, []BlockedPair{
		{NormKeyA: "zhang", NormKeyB: "li"},
		{NormKeyA: "a", NormKeyB: "b"},
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// 重复写入必须无害（幂等）。
	if err := s.UpsertBlockedPairs(ctx, bookID, []BlockedPair{{NormKeyA: "li", NormKeyB: "zhang"}}); err != nil {
		t.Fatalf("upsert dup: %v", err)
	}

	pairs, err := s.ListBlockedPairs(ctx, bookID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(pairs) != 2 {
		t.Fatalf("应 2 条负样本对（重复方向合并后），实际 %d: %+v", len(pairs), pairs)
	}
}

// TestCorrectionsIsolatedBetweenUsers 锁定**多用户隔离**。
//
// 用户 A 的修正事件与负样本对，用户 B 绝不能读到。
// 这不是理论风险：术语表/实体修正里混入别人的数据，等于泄漏别人的阅读内容。
func TestCorrectionsIsolatedBetweenUsers(t *testing.T) {
	s, ctx := testStore(t)
	userA, bookA := correctionFixture(t, s, ctx)
	_, bookB := correctionFixture(t, s, ctx)

	if _, err := s.AppendCorrection(ctx, userA, bookA, 1, corrections.OpMerge,
		json.RawMessage(`{"keyA":"a","keyB":"b"}`)); err != nil {
		t.Fatalf("append A: %v", err)
	}
	if err := s.UpsertBlockedPairs(ctx, bookA, []BlockedPair{{NormKeyA: "x", NormKeyB: "y"}}); err != nil {
		t.Fatalf("blocked A: %v", err)
	}

	// B 读自己的书：必须为空。
	all, err := s.ListCorrections(ctx, bookB)
	if err != nil {
		t.Fatalf("list B: %v", err)
	}
	if len(all) != 0 {
		t.Fatalf("用户 B 读到了 %d 条别的书的修正事件（隔离失效）", len(all))
	}
	pairs, err := s.ListBlockedPairs(ctx, bookB)
	if err != nil {
		t.Fatalf("blocked B: %v", err)
	}
	if len(pairs) != 0 {
		t.Fatalf("用户 B 读到了 %d 条别的书的负样本对（隔离失效）", len(pairs))
	}
	// A 自己仍能读到。
	allA, err := s.ListCorrections(ctx, bookA)
	if err != nil {
		t.Fatalf("list A: %v", err)
	}
	if len(allA) != 1 {
		t.Errorf("用户 A 应读到自己的 1 条事件，实际 %d", len(allA))
	}
}

// TestReplayOverRealLogIsIdempotent 端到端：从数据库读日志，重放两次结果一致。
//
// 这是把「重放幂等」这条设计承诺落到真实存储上的验证。
func TestReplayOverRealLogIsIdempotent(t *testing.T) {
	s, ctx := testStore(t)
	user, bookID := correctionFixture(t, s, ctx)

	if _, err := s.AppendCorrection(ctx, user, bookID, 1, corrections.OpMerge,
		json.RawMessage(`{"keyA":"elizabeth","keyB":"lizzy"}`)); err != nil {
		t.Fatalf("append merge: %v", err)
	}
	if _, err := s.AppendCorrection(ctx, user, bookID, 2, corrections.OpRename,
		json.RawMessage(`{"key":"elizabeth","name":"伊丽莎白"}`)); err != nil {
		t.Fatalf("append rename: %v", err)
	}

	// 把数据库里的行转成 corrections.Event。
	load := func() []corrections.Event {
		evs, err := s.ListCorrections(ctx, bookID)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		out := make([]corrections.Event, 0, len(evs))
		for _, ev := range evs {
			out = append(out, corrections.Event{Seq: ev.Seq, Op: ev.Op, Payload: ev.Payload})
		}
		return out
	}

	auto := [][]string{{"elizabeth"}, {"darcy"}}
	r1, err := corrections.Replay(auto, load())
	if err != nil {
		t.Fatalf("replay 1: %v", err)
	}
	r2, err := corrections.Replay(auto, load())
	if err != nil {
		t.Fatalf("replay 2: %v", err)
	}
	if len(r1.Entities) != len(r2.Entities) {
		t.Fatalf("两次重放组数不同: %d vs %d", len(r1.Entities), len(r2.Entities))
	}
	for i := range r1.Entities {
		if r1.Entities[i].Canonical != r2.Entities[i].Canonical {
			t.Errorf("第 %d 组 canonical 不同: %q vs %q", i, r1.Entities[i].Canonical, r2.Entities[i].Canonical)
		}
	}
	// rename 必须生效：elizabeth 那组的 canonical 应是中文名。
	found := false
	for _, e := range r1.Entities {
		if e.Canonical == "伊丽莎白" {
			found = true
		}
	}
	if !found {
		t.Errorf("rename 未生效，分组: %+v", r1.Entities)
	}
}

// correctionFixture 造一个「用户 + 书」，返回两者的 id。
//
// 每用例自建独立用户（唯一邮箱/设备），不依赖 TRUNCATE ——
// 这样 store 包与其它包的 DB 测试可以并行跑而不互相清空。
func correctionFixture(t *testing.T, s *Store, ctx context.Context) (userID, bookID string) {
	t.Helper()
	suffix := testEmailSuffix()
	user, _, err := s.RegisterAccount(ctx, "corr-"+suffix+"@example.com", "hash", "C", DeviceRegistration{
		ID: testDeviceID(), Name: "d", Platform: "windows",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	book, err := s.CreateBook(ctx, BookCreateInput{UserID: user.ID, Title: "corr book", Format: "epub"})
	if err != nil {
		t.Fatalf("create book: %v", err)
	}
	return user.ID, book.ID
}
