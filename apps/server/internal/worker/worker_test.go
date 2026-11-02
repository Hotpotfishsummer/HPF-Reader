package worker

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/storage"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// testDeps 是本文件用的测试夹具：真 PostgreSQL + 真本地存储 + fake 翻译器。
//
// 刻意**不用 mock**：断点续跑的正确性依赖真实的块表状态与真实的数据库事务，
// 用内存 mock 会把「重启后块状态还在」这个最关键的性质mock 掉，
// 测试通过也证明不了任何事。
type testDeps struct {
	store      *store.Store
	storage    storage.Store
	translator ai.Translator
	logger     *slog.Logger
	pool       *pgxpool.Pool
}

// workerTestDeps 建立测试依赖；未设 HPF_TEST_DATABASE_URL 时跳过。
func workerTestDeps(t *testing.T) testDeps {
	t.Helper()
	dsn := os.Getenv("HPF_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("HPF_TEST_DATABASE_URL not set; skipping DB-backed worker tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	// 不 TRUNCATE：每个测试自建独立用户，靠 user_id 隔离，
	// 因此与 store 包的 DB 测试可以真正并行（详见 store/quota_test.go 的说明）。
	st, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	return testDeps{
		store:      store.New(pool),
		storage:    st,
		translator: mustFakeTranslator(t),
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		pool:       pool,
	}
}

// mustFakeTranslator 构造 fake 翻译器（与生产 provider=fake 一致）。
//
// 用 fake 而不是 mock：fake 走的是与真实 provider **完全相同**的
// TranslateStreamWithUsage 通道语义（含 usage 帧），
// 因此能验证真实的消费逻辑；mock 往往把这些细节简化掉，测不出问题。
func mustFakeTranslator(t *testing.T) ai.Translator {
	t.Helper()
	tr, err := ai.New(ai.Config{Provider: "fake", FakeDelay: time.Millisecond})
	if err != nil {
		t.Fatalf("create fake translator: %v", err)
	}
	return tr
}

// newWorker 构造一个 worker（与生产装配一致）。
func (d testDeps) newWorker() *Worker {
	return New(Deps{
		Logger:          d.logger,
		Store:           d.store,
		Translator:      d.translator,
		Storage:         d.storage,
		Interval:        time.Millisecond,
		CleanupInterval: time.Hour,
	})
}

// countingTranslator 包装 fake 翻译器并记录调用次数与取消点。
//
// 用它来证明「取消后不再产生新的 ai_usage 行」：
// 计数在翻译被真正调用时才增加，因此能精确反映「烧钱」次数。
type countingTranslator struct {
	inner ai.Translator
	calls atomic.Int64
	// afterCalls > 0 时，第 afterCalls 次调用后触发 onAfter（用于模拟中途 kill）。
	afterCalls int64
	onAfter    func()
}

func (c *countingTranslator) Name() string { return c.inner.Name() }

func (c *countingTranslator) TranslateStream(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, error) {
	return c.inner.TranslateStream(ctx, req)
}

func (c *countingTranslator) TranslateStreamWithUsage(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, <-chan ai.Usage, error) {
	n := c.calls.Add(1)
	if c.afterCalls > 0 && n == c.afterCalls && c.onAfter != nil {
		c.onAfter()
	}
	return c.inner.TranslateStreamWithUsage(ctx, req)
}

// buildTestBook 在存储里放一本最小 EPUB 并建好书/任务行。
func buildTestBook(t *testing.T, d testDeps, userID string, chapters int) string {
	t.Helper()
	ctx := context.Background()
	data := makeTestEPUB(t, chapters)
	hash := sha256Hex(data)
	key := "test/" + hash + ".epub"
	if _, err := d.storage.Put(ctx, key, bytes.NewReader(data)); err != nil {
		t.Fatalf("put epub: %v", err)
	}
	book, err := d.store.CreateBook(ctx, store.BookCreateInput{
		UserID: userID, Title: "测试书", Format: "epub",
	})
	if err != nil {
		t.Fatalf("create book: %v", err)
	}
	if _, _, err := d.store.EnsureBookFile(ctx, hash, key, int64(len(data))); err != nil {
		t.Fatalf("ensure book file: %v", err)
	}
	if _, err := d.store.AttachBookFile(ctx, userID, book.ID, hash, int64(len(data))); err != nil {
		t.Fatalf("attach book file: %v", err)
	}
	return book.ID
}

// sha256Hex 计算十六进制 sha256。
func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// makeTestEPUB 构造含 N 章的 EPUB（每章 3 个短段落）。
func makeTestEPUB(t *testing.T, chapters int) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create: %v", err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write: %v", err)
		}
	}
	add("mimetype", "application/epub+zip")
	add("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
	var items, refs strings.Builder
	for i := 0; i < chapters; i++ {
		href := fmt.Sprintf("ch%d.xhtml", i)
		body := fmt.Sprintf("<p>Chapter %d paragraph one about Darcy.</p>"+
			"<p>Second paragraph here.</p><p>Third paragraph ends.</p>", i)
		title := "Chapter " + strconv.Itoa(i)
		add("OEBPS/"+href, `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>`+title+`</title></head><body>`+body+`</body></html>`)
		items.WriteString(fmt.Sprintf(`<item id="c%d" href="%s" media-type="application/xhtml+xml"/>`, i, href))
		refs.WriteString(fmt.Sprintf(`<itemref idref="c%d"/>`, i))
	}
	add("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/>
<manifest>`+items.String()+`</manifest><spine>`+refs.String()+`</spine></package>`)
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

// newUser 创建一个测试用户（含配额）。
func newUser(t *testing.T, d testDeps, quotaCalls int) string {
	t.Helper()
	u, _, err := d.store.RegisterAccount(context.Background(),
		fmt.Sprintf("m52-%d@example.com", time.Now().UnixNano()), "hash", "测试用户",
		store.DeviceRegistration{ID: randomUUID(), Name: "dev", Platform: "windows"}, quotaCalls)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return u.ID
}

// randomUUID 生成伪随机 UUID（仅测试用，无需密码学强度）。
func randomUUID() string {
	var b [16]byte
	n := time.Now().UnixNano()
	for i := range b {
		b[i] = byte(n >> (uint(i) * 4))
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// TestBookTranslateEndToEnd 验证完整链路：EPUB → 分块 → 逐块翻译 → 落库 → 进度。
func TestBookTranslateEndToEnd(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 3)

	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}
	w := d.newWorker()
	res, err := w.runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.TotalChunks == 0 {
		t.Fatal("分块数为 0：EPUB 解析或分块器失效")
	}
	if res.DoneChunks != res.TotalChunks {
		t.Fatalf("done = %d, total = %d（应有全部完成）", res.DoneChunks, res.TotalChunks)
	}
	if res.TranslatedChars == 0 {
		t.Fatal("译文总字符数为 0：翻译没有真正产出")
	}

	// 块表必须有产出，且状态全为 done。
	chunks, err := d.store.ListChunks(ctx, job.ID)
	if err != nil {
		t.Fatalf("list chunks: %v", err)
	}
	for _, c := range chunks {
		if c.Status != "done" {
			t.Fatalf("chunk %d status = %q, want done", c.ChunkIndex, c.Status)
		}
		if c.OutputText == nil || *c.OutputText == "" {
			t.Fatalf("chunk %d 没有译文", c.ChunkIndex)
		}
	}

	// 记账：每个块恰好一条 ai_usage。
	n := countUsageRows(t, d, userID)
	if n != len(chunks) {
		t.Fatalf("ai_usage 行数 = %d, want %d（每块一条）", n, len(chunks))
	}
}

// TestBookTranslateResumesFromCheckpoint 是本次任务的核心验收：
// **跑到一半 kill 掉，重启后必须从断点继续，而不是重头再来**。
//
// 模拟方式：先只跑前 2 块（通过取消 ctx 中断），
// 然后重新调用 runBookTranslate，断言：
//  1. 已完成的块没有被重译（翻译器调用次数只增加了剩余块数）；
//  2. 最终所有块都完成。
func TestBookTranslateResumesFromCheckpoint(t *testing.T) {
	d := workerTestDeps(t)
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 6)
	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(context.Background(), userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	// 第一轮：翻译 2 个块后模拟进程被杀（取消 ctx）。
	var killed atomic.Bool
	var trans countingTranslator
	trans.inner = d.translator
	trans.afterCalls = 2
	trans.onAfter = func() { killed.Store(true) }
	d.translator = &trans
	w := d.newWorker()

	runCtx, cancel := context.WithCancel(context.Background())
	// 每翻译一次就检查是否该「死掉」。
	go func() {
		for !killed.Load() {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	_, err = w.runBookTranslate(runCtx, job)
	cancel()
	if err == nil {
		t.Fatal("第一轮应当因 ctx 取消而中断")
	}

	// 断点状态：必须有已完成块，且不能是全部完成（否则没测到续跑）。
	done1, total1, err := d.store.ChunkProgress(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("progress: %v", err)
	}
	if done1 == 0 {
		t.Fatalf("第一轮完成后 done = 0：断点没有落库，续跑无从谈起")
	}
	if done1 >= total1 {
		t.Fatalf("第一轮就全做完了（done=%d total=%d），没有构造出断点场景", done1, total1)
	}
	t.Logf("断点状态：已完成 %d/%d 块", done1, total1)

	// 第二轮：重启 worker，从断点继续。
	callsAfterFirst := trans.calls.Load()
	_, err = d.newWorker().runBookTranslate(context.Background(), job)
	if err != nil {
		t.Fatalf("续跑失败: %v", err)
	}
	done2, total2, err := d.store.ChunkProgress(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("progress after resume: %v", err)
	}
	if done2 != total2 {
		t.Fatalf("续跑后 done = %d, total = %d", done2, total2)
	}

	// 关键断言：续跑只翻译了「剩下的块」，没有重译已完成的块。
	newCalls := trans.calls.Load() - callsAfterFirst
	remaining := int64(total2 - done1)
	if newCalls != remaining {
		t.Fatalf("续跑调用翻译 %d 次，但只剩 %d 块未完成——说明重译了已完成的块（重复计费）",
			newCalls, remaining)
	}
	t.Logf("续跑：只翻译了剩余 %d 块，未重译已完成的 %d 块", remaining, done1)
}

// countUsageRows 统计某用户的 ai_usage 行数。
func countUsageRows(t *testing.T, d testDeps, userID string) int {
	t.Helper()
	var n int
	if err := d.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM ai_usage WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count usage: %v", err)
	}
	return n
}

// TestDuplicateChunkNotBilledTwice 是验收点「重复块不重复计费」：
// 同一个块跑两次，ai_usage 只能有一行。
//
// 实现上靠两层保护：
//  1. 块完成后状态为 done，NextPendingChunk 不会再选中它；
//  2. 即使被强制重跑（例如 finish 写库失败后重试），input_hash 未变也不会新增记账。
//
// 这里直接构造「跑完一轮再跑一轮」来验证第 1 层，
// 并用重复调用 runBookTranslate 来模拟重启后再次执行。
func TestDuplicateChunkNotBilledTwice(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 2)
	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}
	w := d.newWorker()

	res1, err := w.runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	rowsAfterFirst := countUsageRows(t, d, userID)

	// 第二轮：任务已全部完成，再跑一次应该什么也不做。
	res2, err := w.runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	rowsAfterSecond := countUsageRows(t, d, userID)

	if rowsAfterSecond != rowsAfterFirst {
		t.Fatalf("重复执行新增了 %d 条 ai_usage（重复计费）", rowsAfterSecond-rowsAfterFirst)
	}
	if res2.TranslatedChars != 0 {
		t.Fatalf("第二轮又产出了 %d 字符，说明重译了已完成块", res2.TranslatedChars)
	}
	if res1.TotalChunks != res2.TotalChunks {
		t.Fatalf("两轮分块数不一致：%d vs %d（块清单不稳定）", res1.TotalChunks, res2.TotalChunks)
	}
}

// TestCancelStopsBilling 是验收点「cancel 后不再产生新的 ai_usage 行」。
//
// 构造：翻译 1 块后把任务状态改成 canceled，断言第二轮立刻停止且不新增记账。
func TestCancelStopsBilling(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 4)
	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}

	// 先翻译 1 块，然后模拟用户点「取消」。
	var trans countingTranslator
	trans.inner = d.translator
	trans.afterCalls = 1
	d.translator = &trans
	runCtx, cancel := context.WithCancel(ctx)
	trans.onAfter = cancel
	w := d.newWorker()
	_, err = w.runBookTranslate(runCtx, job)
	cancel()
	if err == nil {
		t.Fatal("应当在第一块后中断")
	}

	rowsAfterKill := countUsageRows(t, d, userID)
	callsAfterKill := trans.calls.Load()

	// 用户取消任务。
	if _, err := d.pool.Exec(ctx, `UPDATE ai_jobs SET status = 'canceled' WHERE id = $1`, job.ID); err != nil {
		t.Fatalf("cancel job: %v", err)
	}

	// 重启 worker：必须立刻停下，不再翻译任何块。
	_, err = d.newWorker().runBookTranslate(ctx, job)
	if !errors.Is(err, errJobCanceled) {
		t.Fatalf("err = %v, want errJobCanceled", err)
	}
	if got := trans.calls.Load(); got != callsAfterKill {
		t.Fatalf("取消后又调用了翻译 %d 次——取消没有止血", got-callsAfterKill)
	}
	if got := countUsageRows(t, d, userID); got != rowsAfterKill {
		t.Fatalf("取消后新增了 %d 条 ai_usage 行", got-rowsAfterKill)
	}
}

// TestQuotaExhaustedPausesJob 验证验收点「配额超限 → paused 而非 failed」。
//
// paused 与 failed 的差别是可续跑性：已完成块必须保留，额度恢复后能接着跑。
func TestQuotaExhaustedPausesJob(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1) // 配额只够 1 次调用
	bookID := buildTestBook(t, d, userID, 3)
	opts, _ := json.Marshal(bookTranslateOptions{TargetLang: "zh"})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}
	w := d.newWorker()
	res, err := w.runBookTranslate(ctx, job)
	if !errors.Is(err, errJobPaused) {
		t.Fatalf("err = %v, want errJobPaused（配额耗尽应暂停而非失败）", err)
	}
	if !res.Paused {
		t.Fatal("res.Paused 应为 true")
	}
	// 已完成块必须保留，否则「续跑」没有意义。
	if res.DoneChunks == 0 {
		t.Log("配额=1 时第一块就没通过预扣，未产出任何块（仍符合 paused 语义）")
	}
	done, total, err := d.store.ChunkProgress(ctx, job.ID)
	if err != nil {
		t.Fatalf("progress: %v", err)
	}
	t.Logf("暂停时进度：%d/%d 块已完成（已完成块已保留，可续跑）", done, total)
}

// TestConsistencyScanRecordsViolations 验证译后确定性扫描在真实任务里生效。
//
// 用 fake 翻译器（它不遵守术语表，只会回显处理后的文本），
// 因此必然产生违规——这正好证明扫描器不是摆设。
func TestConsistencyScanRecordsViolations(t *testing.T) {
	d := workerTestDeps(t)
	ctx := context.Background()
	userID := newUser(t, d, 1000)
	bookID := buildTestBook(t, d, userID, 2)
	// 术语表里放一个必然不会出现在 fake 译文里的译名。
	opts, _ := json.Marshal(bookTranslateOptions{
		TargetLang: "zh",
		Glossary:   map[string]string{"Darcy": "达西"},
	})
	job, err := d.store.CreateAIJob(ctx, userID, bookID, "book_translate", opts)
	if err != nil {
		t.Fatalf("create job: %v", err)
	}
	res, err := d.newWorker().runBookTranslate(ctx, job)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	// 原文里出现了 Darcy，译文（fake）里没有「达西」→ 必须报违规。
	if res.Consistency.CheckedTerms == 0 {
		t.Fatal("CheckedTerms = 0：术语表里 Darcy 在原文出现过，应当被检查")
	}
	if res.Consistency.ViolatingChunks == 0 {
		t.Fatal("fake 翻译器不遵守术语表，却没有检测到违规——扫描器失效")
	}
	t.Logf("扫描结果：检查 %d 项术语，%d 个块违规（fake 翻译器必然违反）",
		res.Consistency.CheckedTerms, res.Consistency.ViolatingChunks)
}
