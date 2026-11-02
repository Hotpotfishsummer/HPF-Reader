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
		r.GC(now)
		return true, now.Add(r.window)
	}
	b.count++
	return b.count <= r.limit, b.reset
}

// GC 清理过期桶（在锁内调用，避免内存无界增长）。
func (r *RateLimiter) GC(now time.Time) {
	if len(r.buckets) < 1024 {
		return
	}
	for k, b := range r.buckets {
		if now.After(b.reset) {
			delete(r.buckets, k)
		}
	}
}

// Reset 清空所有计数（测试用）。
func (r *RateLimiter) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buckets = map[string]*bucket{}
}
