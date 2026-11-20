package worker

// 全站月度调用预算（HPF_AI_GLOBAL_MONTHLY_CALLS）在 worker 侧的测试。
//
// 为什么 worker 必须单独测：HTTP 层只在「入队」时拦一次，而一个整书翻译
// 任务会在队列里存活很久、逐块烧钱。若只在入队时判定，任务入队后
// 全站额度被别的账号吃光，worker 依然会把它跑完——闸门等于没生效。
//
// 这些用例需要真库（要读写 users.ai_calls_used 与 ai_period_start），
// 未设置 HPF_TEST_DATABASE_URL 时由 workerTestDeps 统一 skip。
//
// ⚠️ 这些用例的断言必须**相对基线**，不能写死绝对上限。
//
// 两个坑，本文件第一版都踩了：
//
//  1. 「找别人来吃额度」时用 `ORDER BY created_at DESC LIMIT 1`，
//     结果正好命中被测用户自己，用例变成在测「用户配额耗尽」而非全站闸门。
//     → 必须显式传入要污染的那个 userID。
//  2. 用绝对上限（例如 1）来构造「已超额」。`go test ./...` 会并行跑不同包，
//     别的包随时可能把全站用量清零，此时 limit=1 又变成「还有余量」，随机红。
//     → 上限取「当前全站已用数」，语义「已用 >= 上限」恒成立。

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// newWorkerWithBudget 构造一个带全站预算的 worker。
func (d testDeps) newWorkerWithBudget(globalMonthlyCalls int) *Worker {
	w := d.newWorker()
	w.deps.GlobalMonthlyCalls = globalMonthlyCalls
	return w
}

// resetGlobalBudget 把**本用例将要创建的用户**之外的干扰降到最低。
//
// 注意：这里刻意**不**做「UPDATE users SET ai_calls_used = 0」（全表清零）。
// `go test ./...` 会并行跑不同包，store/httpapi 包的用例同时在读写同一批
// 用户；全表清零会把它们的断言打乱，表现为「单独跑绿、全量跑红」。
//
// 正确做法是让每条用例自己算基线：先读当前全站已用数，
// 再据此设置上限（见 budgetLimitFromBaseline）。
func globalUsed(t *testing.T, d testDeps) int64 {
	t.Helper()
	g, err := d.store.GlobalAICalls(context.Background(), 0)
	if err != nil {
		t.Fatalf("GlobalAICalls: %v", err)
	}
	return g.CallsUsed
}

// budgetLimitFromBaseline 返回一个「相对当前全站用量而言已经超额」的上限。
//
// 不用绝对值（例如 1）：别的包可能随时把全站用量清零，那时 limit=1
// 就变成「还有余量」，用例会随机失败。取「当前用量」作为上限，
// 语义是「已用 >= 上限」，无论基线是多少都成立。
func budgetLimitFromBaseline(t *testing.T, d testDeps) int {
	t.Helper()
	used := globalUsed(t, d)
	if used < 1 {
		// 基线为 0 时无法用「已用 >= 上限」构造超额，
		// 自己造一个用户把用量顶上去。
		hog := newUser(t, d, 1000)
		exhaustGlobalBudget(t, d, hog, 1000)
		used = 1000
	}
	return int(used)
}

// exhaustGlobalBudget 把**指定用户**的本周期计数顶到很高，用来模拟
// 「全站额度已被别的账号吃光」。
//
// 必须显式指定用户，不能用「最近创建的那个」：那个往往正是被测用户，
// 于是用例就变成在测「用户自己的配额耗尽」，与全站闸门无关。
func exhaustGlobalBudget(t *testing.T, d testDeps, userID string, calls int) {
	t.Helper()
	if _, err := d.pool.Exec(context.Background(), `
		UPDATE users SET ai_calls_used = $2, ai_period_start = ai_period_for(now())
		WHERE id = $1`, userID, calls); err != nil {
		t.Fatalf("exhaust global budget: %v", err)
	}
}

// TestWorkerPausesWhenGlobalBudgetExhausted 验证全站超额时任务被暂停（可续跑）。
//
// 断言的核心是「paused 而不是 failed」：已完成块必须保留，
// 额度恢复后能接着跑。用 failed 会让用户以为任务坏了，还白扔掉已付费的进度。
func TestWorkerPausesWhenGlobalBudgetExhausted(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	// 被测用户：自己的额度充足（1000 次），证明拦截来自**全站**而非用户配额。
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 3)
	// 「别的账号」：把全站用量顶到远超上限。
	hog := newUser(t, d, 1000)
	exhaustGlobalBudget(t, d, hog, 999999)

	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	// 全站上限设成「当前已用数」→ 已用 >= 上限，第一块就该被拦。
	// 不用绝对值 1：别的包可能把用量清零，那时 1 就变成「还有余量」。
	limit := budgetLimitFromBaseline(t, d)
	w := d.newWorkerWithBudget(limit)
	res, err := w.runBookTranslate(ctx, job)
	if !errors.Is(err, errJobPaused) {
		t.Fatalf("err = %v, want errJobPaused（全站预算耗尽应暂停而非失败）", err)
	}
	if !res.Paused {
		t.Fatal("res.Paused 应为 true")
	}

	// 关键：一块都不该被翻译（钱不能花出去）。
	done, total, err := d.store.ChunkProgress(ctx, job.ID)
	if err != nil {
		t.Fatalf("progress: %v", err)
	}
	if done != 0 {
		t.Fatalf("全站超额时仍然完成了 %d/%d 块——闸门没有生效", done, total)
	}
}

// TestWorkerRunsWhenGlobalBudgetHasRoom 是上一条的对照组。
//
// 没有这个对照组，「暂停」的断言可能只是因为任务本来就跑不起来。
func TestWorkerRunsWhenGlobalBudgetHasRoom(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 2)

	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	// 上限远高于当前已用：用相对基线，不受别的包并行写入影响。
	limit := int(globalUsed(t, d)) + 1_000_000
	w := d.newWorkerWithBudget(limit)
	res, err := w.runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("全站预算充足时不应失败: %v", err)
	}
	if res.Paused {
		t.Fatal("预算充足时不该暂停")
	}
	if res.DoneChunks == 0 {
		t.Fatal("预算充足时应当完成至少一个块")
	}
}

// TestWorkerGlobalBudgetZeroMeansUnlimited 守住默认值的语义。
//
// 默认值就是 0。如果 0 被当成「上限 0」，所有部署升级后 AI 会立刻全线暂停
// ——一次配置升级变成全站故障。
func TestWorkerGlobalBudgetZeroMeansUnlimited(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 1)
	// 即使全站用量已经很高，limit=0 也必须放行。
	hog := newUser(t, d, 1000)
	exhaustGlobalBudget(t, d, hog, 999999)

	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	w := d.newWorkerWithBudget(0)
	res, err := w.runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("limit=0 表示不限，不应失败: %v", err)
	}
	if res.Paused {
		t.Fatal("limit=0 表示不限，不该暂停")
	}
}

// TestDrainLeavesJobsQueuedWhenBudgetExhausted 验证 drain 在超额时**不取任务**。
//
// 这一点比「取了再暂停」重要得多：ClaimAIJob 会把任务置为 running，
// 一旦取了就欠了用户一个「会跑完」的承诺。反复 running→paused→queued
// 会让前端进度条抖动，也会消耗 attempts（耗尽后任务会永久 failed）。
func TestDrainLeavesJobsQueuedWhenBudgetExhausted(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 1)
	hog := newUser(t, d, 1000)
	exhaustGlobalBudget(t, d, hog, 999999)

	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	limit := budgetLimitFromBaseline(t, d)
	w := d.newWorkerWithBudget(limit)
	w.drain(ctx)

	// 任务必须仍然是 queued，且 attempts 没有被消耗。
	got, err := d.store.GetAIJob(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("get job: %v", err)
	}
	if got.Status != "queued" {
		t.Fatalf("status = %q, want queued（超额时不该把任务领走）", got.Status)
	}
	if got.Attempts != 0 {
		t.Fatalf("attempts = %d, want 0（领走任务会消耗重试次数，最终把任务变成永久 failed）", got.Attempts)
	}
}

// TestGlobalBudgetErrorCarriesScope 保证 worker 侧拿到的错误带 scope=global。
//
// worker 用 errors.As 判断「是配额问题（暂停）」还是「是数据库问题（放弃本轮）」。
// 如果 scope 丢了，它无法区分「全站超额」与「用户超额」，
// 日志与排障都会指向错误的方向。
func TestGlobalBudgetErrorCarriesScope(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	hog := newUser(t, d, 1000)
	exhaustGlobalBudget(t, d, hog, 500)

	err := d.store.CheckGlobalAICallBudget(ctx, 10)
	var qe *store.ErrQuotaExceeded
	if !errors.As(err, &qe) {
		t.Fatalf("want ErrQuotaExceeded, got %v", err)
	}
	if qe.Scope != "global" {
		t.Fatalf("Scope = %q, want global", qe.Scope)
	}
	if qe.ResetAt.Before(time.Now()) {
		t.Fatalf("ResetAt 必须在未来，got %v", qe.ResetAt)
	}
}
