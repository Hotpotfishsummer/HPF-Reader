package auth

import (
	"testing"
	"time"
)

// 登录失败限流必须区分「检查」与「记账」：成功登录不能被自己的尝试计数挤掉。
func TestRateLimiterBlockedDoesNotCount(t *testing.T) {
	rl := NewRateLimiter(3, 15*time.Minute)
	now := time.Now()
	rl.now = func() time.Time { return now }

	for i := 0; i < 10; i++ {
		if blocked, _ := rl.Blocked("a|1.2.3.4"); blocked {
			t.Fatalf("Blocked must not increment: blocked on peek %d", i+1)
		}
	}
	if got := rl.Len(); got != 0 {
		t.Fatalf("peek must not create buckets, Len = %d", got)
	}
}

func TestRateLimiterRecordThenBlock(t *testing.T) {
	rl := NewRateLimiter(3, 15*time.Minute)
	now := time.Now()
	rl.now = func() time.Time { return now }

	for i := 0; i < 2; i++ {
		rl.Record("a|1.2.3.4")
		if blocked, _ := rl.Blocked("a|1.2.3.4"); blocked {
			t.Fatalf("should not be blocked after %d/%d failures", i+1, 3)
		}
	}
	// limit=3 表示「第 3 次失败后开始拒绝后续尝试」。
	rl.Record("a|1.2.3.4")
	if blocked, reset := rl.Blocked("a|1.2.3.4"); !blocked {
		t.Fatal("must be blocked after exceeding the failure limit")
	} else if !reset.After(now) {
		t.Fatal("reset time should be in the future")
	}

	// 同一账号换一个 IP 不受影响（这正是「不让单个 IP 锁死账号」的前提）。
	if blocked, _ := rl.Blocked("a|5.6.7.8"); blocked {
		t.Fatal("other IP must not be blocked")
	}
	// 同一 IP 换一个账号也不受影响。
	if blocked, _ := rl.Blocked("b|1.2.3.4"); blocked {
		t.Fatal("other account must not be blocked")
	}

	// 窗口过后自动恢复。
	now = now.Add(16 * time.Minute)
	if blocked, _ := rl.Blocked("a|1.2.3.4"); blocked {
		t.Fatal("window should have expired")
	}
}

// 登录成功后必须清零，否则正常用户会累积失败计数。
func TestRateLimiterClear(t *testing.T) {
	rl := NewRateLimiter(2, time.Minute)
	now := time.Now()
	rl.now = func() time.Time { return now }

	rl.Record("a|1.2.3.4")
	rl.Record("a|1.2.3.4")
	if blocked, _ := rl.Blocked("a|1.2.3.4"); !blocked {
		t.Fatal("must be blocked before Clear")
	}
	rl.Clear("a|1.2.3.4")
	if blocked, _ := rl.Blocked("a|1.2.3.4"); blocked {
		t.Fatal("Clear must reset the counter")
	}
	if got := rl.Len(); got != 0 {
		t.Fatalf("Clear must remove the bucket, Len = %d", got)
	}
}

// 唯一键暴涨时 GC 必须按时间节流：旧实现每次新建桶都全表扫描，O(n²)。
func TestRateLimiterGCIsThrottled(t *testing.T) {
	rl := NewRateLimiter(1, time.Minute)
	now := time.Now()
	rl.now = func() time.Time { return now }

	for i := 0; i < 10000; i++ {
		rl.Allow(string(rune('a'+i%26)) + "-" + time.Duration(i).String())
	}
	if got := rl.Len(); got < 4096 {
		t.Fatalf("expected many buckets, got %d", got)
	}
	// 窗口过后再建新桶时，过期桶应被清理（而不是无限增长）。
	now = now.Add(2 * time.Minute)
	rl.Allow("fresh-key")
	if got := rl.Len(); got > 100 {
		t.Fatalf("expired buckets should be collected, Len = %d", got)
	}
}
