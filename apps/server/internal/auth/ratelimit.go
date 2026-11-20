package auth

import (
	"sync"
	"time"
)

// RateLimiter 是固定窗口计数器，用于登录接口等热点路径的粗粒度限流。
//
// 为什么不用 Redis：一期单实例部署，进程内计数足够；
// 多副本部署时应替换为 Redis 实现（接口保持不变）。
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	limit   int
	window  time.Duration
	lastGC  time.Time
	now     func() time.Time
}

type bucket struct {
	count int
	reset time.Time
}

// NewRateLimiter 构造限流器：window 内最多 limit 次。
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	if limit <= 0 {
		limit = 60
	}
	if window <= 0 {
		window = time.Minute
	}
	return &RateLimiter{buckets: map[string]*bucket{}, limit: limit, window: window, now: time.Now}
}

// Allow 记录一次请求并返回是否放行。返回 false 时同时给出重置时间。
func (r *RateLimiter) Allow(key string) (bool, time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	b, ok := r.buckets[key]
	if !ok || now.After(b.reset) {
		r.buckets[key] = &bucket{count: 1, reset: now.Add(r.window)}
		r.gcLocked(now)
		return true, now.Add(r.window)
	}
	b.count++
	return b.count <= r.limit, b.reset
}

// Blocked 只查询是否已超限，不计数。
//
// 登录失败限流必须区分「检查」与「记账」：如果每次登录（包括成功）都计数，
// 正常用户 15 分钟内登录 5 次就会被自己锁在门外。
func (r *RateLimiter) Blocked(key string) (bool, time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.buckets[key]
	if !ok {
		return false, time.Time{}
	}
	if r.now().After(b.reset) {
		return false, time.Time{}
	}
	return b.count >= r.limit, b.reset
}

// Record 记录一次失败（只在口令校验失败时调用）。
func (r *RateLimiter) Record(key string) time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	b, ok := r.buckets[key]
	if !ok || now.After(b.reset) {
		reset := now.Add(r.window)
		r.buckets[key] = &bucket{count: 1, reset: reset}
		r.gcLocked(now)
		return reset
	}
	b.count++
	return b.reset
}

// Clear 清空某个键（登录成功后调用，避免成功登录后还残留失败计数）。
func (r *RateLimiter) Clear(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.buckets, key)
}

// gcLocked 清理过期桶（在锁内调用）。
//
// 旧实现只在「新建桶且总数 ≥1024」时全表扫描：攻击者用大量随机 IP/账号
// 制造唯一键时，每次都 O(n) 扫描会让整体退化成 O(n²)，并且内存无界增长。
// 现在按窗口的 1/4 节流，并把扫描下限提高到 4096。
func (r *RateLimiter) gcLocked(now time.Time) {
	if len(r.buckets) < 4096 {
		return
	}
	if !r.lastGC.IsZero() && now.Sub(r.lastGC) < r.window/4 {
		return
	}
	r.lastGC = now
	for k, b := range r.buckets {
		if now.After(b.reset) {
			delete(r.buckets, k)
		}
	}
}

// Len 返回当前桶数量（测试/观测用）。
func (r *RateLimiter) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.buckets)
}

// Reset 清空所有计数（测试用）。
func (r *RateLimiter) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buckets = map[string]*bucket{}
	r.lastGC = time.Time{}
}
