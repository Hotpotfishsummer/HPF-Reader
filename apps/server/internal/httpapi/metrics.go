package httpapi

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Metrics 是一个极简的 Prometheus 文本格式指标注册表。
//
// 为什么不用 prometheus/client_golang：一期只需要 5 个指标，
// 手写实现零依赖、输出格式可控，评审时一眼能看出暴露了什么。
type Metrics struct {
	mu              sync.Mutex
	started         time.Time
	requests        map[reqKey]*reqStat
	syncPushes      int64
	syncOpsApplied  int64
	syncOpsIgnored  int64
	idempotentHits  int64
	mergeWins       map[string]int64
	aiTranslations  int64
	aiErrors        int64
	uploads         int64
	uploadDedupHits int64
	sourceSearches  int64
	sourceErrors    int64
}

type reqKey struct {
	Method string
	Route  string
	Status int
}

type reqStat struct {
	Count      int64
	DurationNS int64
}

// NewMetrics 构造指标注册表。
func NewMetrics() *Metrics {
	return &Metrics{
		started:   time.Now(),
		requests:  map[reqKey]*reqStat{},
		mergeWins: map[string]int64{},
	}
}

// ObserveHTTP 记录一次 HTTP 请求。
func (m *Metrics) ObserveHTTP(method, route string, status int, d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := reqKey{Method: method, Route: route, Status: status}
	st, ok := m.requests[k]
	if !ok {
		st = &reqStat{}
		m.requests[k] = st
	}
	st.Count++
	st.DurationNS += d.Nanoseconds()
}

// ObserveSyncPush 记录一次 push 的裁决统计。
func (m *Metrics) ObserveSyncPush(applied, ignored, idemHits int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.syncPushes++
	m.syncOpsApplied += int64(applied)
	m.syncOpsIgnored += int64(ignored)
	m.idempotentHits += int64(idemHits)
}

// ObserveMerge 记录合并裁决原因分布（排障时最有用的一项）。
func (m *Metrics) ObserveMerge(reason string) {
	if reason == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mergeWins[reason]++
}

// IncAI 记录 AI 调用结果。
func (m *Metrics) IncAI(ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ok {
		m.aiTranslations++
	} else {
		m.aiErrors++
	}
}

// IncUpload 记录上传（dedup 为真表示秒传命中）。
func (m *Metrics) IncUpload(dedup bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.uploads++
	if dedup {
		m.uploadDedupHits++
	}
}

// IncSourceSearch 记录书源搜索。
func (m *Metrics) IncSourceSearch(failed bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sourceSearches++
	if failed {
		m.sourceErrors++
	}
}

// Render 输出 Prometheus 文本格式。
//
// 手写而不是引入 client_golang：一期只暴露少量指标，手写零依赖且输出完全可控。
// 标签值统一用 %q 转义，避免指标名/标签值被注入破坏格式。
func (m *Metrics) Render() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var b strings.Builder
	metric := func(name, help, typ string) {
		fmt.Fprintf(&b, "# HELP %s %s\n", name, help)
		fmt.Fprintf(&b, "# TYPE %s %s\n", name, typ)
	}

	metric("hpf_uptime_seconds", "进程运行时长（秒）", "gauge")
	fmt.Fprintf(&b, "hpf_uptime_seconds %.3f\n", time.Since(m.started).Seconds())

	keys := make([]reqKey, 0, len(m.requests))
	for k := range m.requests {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Route != keys[j].Route {
			return keys[i].Route < keys[j].Route
		}
		if keys[i].Method != keys[j].Method {
			return keys[i].Method < keys[j].Method
		}
		return keys[i].Status < keys[j].Status
	})

	metric("hpf_http_requests_total", "HTTP 请求总数", "counter")
	for _, k := range keys {
		fmt.Fprintf(&b, "hpf_http_requests_total{method=%q,route=%q,status=%q} %d\n",
			k.Method, k.Route, strconvItoa(k.Status), m.requests[k].Count)
	}

	metric("hpf_http_request_duration_seconds_sum", "累计请求耗时（秒）", "counter")
	for _, k := range keys {
		fmt.Fprintf(&b, "hpf_http_request_duration_seconds_sum{method=%q,route=%q,status=%q} %.6f\n",
			k.Method, k.Route, strconvItoa(k.Status), float64(m.requests[k].DurationNS)/1e9)
	}

	metric("hpf_sync_pushes_total", "同步 push 次数", "counter")
	fmt.Fprintf(&b, "hpf_sync_pushes_total %d\n", m.syncPushes)

	metric("hpf_sync_ops_total", "同步 op 裁决结果分布", "counter")
	fmt.Fprintf(&b, "hpf_sync_ops_total{result=%q} %d\n", "applied", m.syncOpsApplied)
	fmt.Fprintf(&b, "hpf_sync_ops_total{result=%q} %d\n", "ignored", m.syncOpsIgnored)
	fmt.Fprintf(&b, "hpf_sync_ops_total{result=%q} %d\n", "duplicate", m.idempotentHits)

	metric("hpf_sync_merge_reason_total", "合并裁决原因分布", "counter")
	reasons := make([]string, 0, len(m.mergeWins))
	for r := range m.mergeWins {
		reasons = append(reasons, r)
	}
	sort.Strings(reasons)
	for _, reason := range reasons {
		fmt.Fprintf(&b, "hpf_sync_merge_reason_total{reason=%q} %d\n", reason, m.mergeWins[reason])
	}

	metric("hpf_ai_requests_total", "AI 调用次数", "counter")
	fmt.Fprintf(&b, "hpf_ai_requests_total{result=%q} %d\n", "ok", m.aiTranslations)
	fmt.Fprintf(&b, "hpf_ai_requests_total{result=%q} %d\n", "error", m.aiErrors)

	metric("hpf_book_uploads_total", "书籍文件上传次数（dedup=true 为秒传命中）", "counter")
	fmt.Fprintf(&b, "hpf_book_uploads_total{dedup=%q} %d\n", "false", m.uploads-m.uploadDedupHits)
	fmt.Fprintf(&b, "hpf_book_uploads_total{dedup=%q} %d\n", "true", m.uploadDedupHits)

	metric("hpf_source_searches_total", "书源搜索次数", "counter")
	fmt.Fprintf(&b, "hpf_source_searches_total{result=%q} %d\n", "ok", m.sourceSearches-m.sourceErrors)
	fmt.Fprintf(&b, "hpf_source_searches_total{result=%q} %d\n", "error", m.sourceErrors)

	return b.String()
}

// handleMetrics 输出 Prometheus 文本格式指标。
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(s.metrics.Render()))
}
