package store

import (
	"encoding/json"
	"testing"
	"time"
)

// TestReclaimStaleJobsRequeuesAbandonedRunningJob 是「重启后任务永远卡在 running」的回归测试。
//
// 缺陷：ClaimAIJob 只捞 status='queued'（aijobs.go 的 WHERE status = 'queued'）。
// 所以 worker 在任务执行中崩溃 / 被 kill / 部署重启后，那条任务会永远停在 running：
// 既不会被重试，也不会被任何 worker 再捞到。任何一次重启都会命中，不是边缘情况。
//
// 断言：
//  1. 租约超时的 running 任务会被退回 queued；
//  2. 未超时的 running 任务**不会**被误回收（否则正在跑的长任务会被重复执行、重复烧钱）；
//  3. 超过 attempts 上限的任务不再退回（避免毒任务无限重跑）。
func TestReclaimStaleJobsRequeuesAbandonedRunningJob(t *testing.T) {
	s, ctx := testStore(t)

	suffix := testEmailSuffix()
	user, _, err := s.RegisterAccount(ctx, "reclaim-"+suffix+"@example.com", "hash", "R", DeviceRegistration{
		ID: testDeviceID(), Name: "d", Platform: "windows",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	mkJob := func() AIJob {
		j, err := s.CreateAIJob(ctx, user.ID, "", "book_translate", json.RawMessage("{}"))
		if err != nil {
			t.Fatalf("create job: %v", err)
		}
		return j
	}

	// makeRunning 把**指定 id** 的任务直接推成 running，并设置 locked_at 偏移。
	//
	// 刻意不走 ClaimAIJob：它是全局的（WHERE status='queued' 不带 user 过滤），
	// 并行跑其它测试时会把别的用例造的任务抢走，导致「单独跑绿、全量跑红」。
	// 这里按 id 直接改状态，完全确定性。
	makeRunning := func(id string, age time.Duration, attempts int) {
		if _, err := s.Pool().Exec(ctx, `
			UPDATE ai_jobs SET status = 'running', locked_at = now() - $2::interval,
			    locked_by = 'test-worker', attempts = $3
			WHERE id = $1`, id, intervalSeconds(age), attempts); err != nil {
			t.Fatalf("make running: %v", err)
		}
	}

	// 场景 1：卡死很久（1 小时 > 15 分钟租约）→ 应被回收。
	stale := mkJob()
	makeRunning(stale.ID, time.Hour, 1)

	// 场景 2：刚开始跑（10 秒 < 15 分钟）→ 不应被回收。
	live := mkJob()
	makeRunning(live.ID, 10*time.Second, 1)

	n, err := s.ReclaimStaleJobs(ctx, 15*time.Minute, 3)
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	// 库里可能有其它用例留下的 running 任务，不硬断言 n==1；
	// 逐个查这两个任务的状态才是真正要守的性质。
	if n < 1 {
		t.Fatalf("reclaimed %d jobs, want >= 1 (the stale one must be requeued)", n)
	}

	got, err := s.GetAIJob(ctx, user.ID, stale.ID)
	if err != nil {
		t.Fatalf("get stale job: %v", err)
	}
	if got.Status != "queued" {
		t.Fatalf("stale job status = %q, want queued (abandoned running job must be requeued)", got.Status)
	}
	if got.Attempts != 1 {
		t.Fatalf("stale job attempts = %d, want 1 (reclaim must not bump attempts)", got.Attempts)
	}

	got, err = s.GetAIJob(ctx, user.ID, live.ID)
	if err != nil {
		t.Fatalf("get live job: %v", err)
	}
	if got.Status != "running" {
		t.Fatalf("live job status = %q, want running (a job still running must NOT be reclaimed)", got.Status)
	}

	// 场景 3：attempts 已达上限 → 不再退回（避免毒任务无限重跑烧钱）。
	exhausted := mkJob()
	makeRunning(exhausted.ID, time.Hour, 99)
	if _, err := s.ReclaimStaleJobs(ctx, 15*time.Minute, 3); err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	got, err = s.GetAIJob(ctx, user.ID, exhausted.ID)
	if err != nil {
		t.Fatalf("get exhausted job: %v", err)
	}
	if got.Status != "running" {
		t.Fatalf("exhausted job status = %q, want running (attempts >= max must not be requeued)", got.Status)
	}
}

// TestClaimAIJobOnlyPicksQueued 记录 ReclaimStaleJobs 存在的**原因**。
//
// 断言「ClaimAIJob 不会捞 running」这一前提仍然成立。若以后有人把它改成也捞 running，
// ReclaimStaleJobs 就失去意义、甚至会让同一任务被两个 worker 同时执行——那时这个测试会红。
func TestClaimAIJobOnlyPicksQueued(t *testing.T) {
	s, ctx := testStore(t)

	suffix := testEmailSuffix()
	user, _, err := s.RegisterAccount(ctx, "precond-"+suffix+"@example.com", "hash", "P", DeviceRegistration{
		ID: testDeviceID(), Name: "d", Platform: "windows",
	}, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	created, err := s.CreateAIJob(ctx, user.ID, "", "book_translate", json.RawMessage("{}"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// 直接按 id 把它推成 running（不走 ClaimAIJob，避免抢到别的用例的任务）。
	if _, err := s.Pool().Exec(ctx, `
		UPDATE ai_jobs SET status = 'running', locked_at = now(), locked_by = 'w1', attempts = 1
		WHERE id = $1`, created.ID); err != nil {
		t.Fatalf("make running: %v", err)
	}
	first := created
	// 再抢若干次。关键性质：**任何一次都不能抢到 first 那个已 running 的任务**。
	//
	// 不能简单断言「第二次一定 ErrNotFound」——库里可能有其它用例留下的 queued 任务，
	// 会被正常抢走（那是正确行为）。要守的是「running 的不被重复抢」，不是「没别的任务」。
	for i := 0; i < 5; i++ {
		got, err := s.ClaimAIJob(ctx, "w2")
		if err == ErrNotFound {
			break // 没任务可抢了，正常
		}
		if err != nil {
			t.Fatalf("claim #%d: %v", i+2, err)
		}
		if got.ID == first.ID {
			t.Fatalf("ClaimAIJob returned the already-running job %s: "+
				"a running task must never be claimable by a second worker "+
				"(otherwise it would execute twice and bill twice)", got.ID)
		}
	}
}
