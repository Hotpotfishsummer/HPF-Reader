package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// errorBody 对应 openapi.yaml 的 Error schema。
type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// 错误码常量（与 openapi.yaml 的示例保持一致）。
const (
	codeInvalidRequest     = "invalid_request"
	codeInvalidCredentials = "invalid_credentials"
	codeUnauthorized       = "unauthorized"
	codeForbidden          = "forbidden"
	codeNotFound           = "not_found"
	codeConflict           = "conflict"
	codeRateLimited        = "rate_limited"
	// codeQuotaExceeded 与 codeRateLimited 刻意分开：
	// 限流是「短时请求太密，等一下再来」，配额是「本周期额度用完，要等下个月或提额」。
	// 混成一个码会让客户端做出完全错误的重试决策（配额超限重试一万次也不会成功）。
	codeQuotaExceeded   = "quota_exceeded"
	codeAccountLocked   = "account_locked"
	codePayloadTooLarge = "payload_too_large"
	codeInternal        = "internal_error"
	codeUnavailable     = "service_unavailable"
)

// writeJSON 输出 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		// 响应已经开始写出，只能记录。
		slog.Default().Warn("write json response failed", "error", err)
	}
}

// writeError 输出统一错误体。
func writeError(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	writeJSON(w, status, errorBody{Code: code, Message: message, Details: details})
}

// writeStoreError 把 store 层错误翻译成 HTTP 状态码。
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeNotFound, "resource not found", nil)
	case errors.Is(err, store.ErrDeviceTaken):
		// 409：deviceId 属于别的账号。与「邮箱已注册」区分开，
		// 客户端才能给出「该设备已绑定其它账号」这种可操作的提示。
		writeError(w, http.StatusConflict, codeConflict,
			"deviceId is already registered to another account", nil)
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, codeConflict, "resource already exists", nil)
	case errors.Is(err, store.ErrInvalidInput):
		// 数据库层面的入参问题（典型 SQLSTATE 22P02）：这是客户端错误，
		// 必须 400 而不是 500 —— 5xx 会被客户端当作可重试错误无限重试。
		slog.Default().Warn("invalid input rejected", "error", err)
		writeError(w, http.StatusBadRequest, codeInvalidRequest,
			"request contains a value the server cannot interpret", nil)
	case errors.As(err, new(*store.ErrQuotaExceeded)):
		writeQuotaExceeded(w, err)
	default:
		slog.Default().Error("store error", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "internal error", nil)
	}
}

// decodeJSON 解析请求体：限制大小、拒绝未知字段（契约严格化）、只允许单个 JSON 值。
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) error {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func queryInt(r *http.Request, key string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	if n < min {
		n = min
	}
	if max > 0 && n > max {
		n = max
	}
	return n, nil
}

func queryInt64(r *http.Request, key string, def int64) (int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return def, nil
	}
	return strconv.ParseInt(raw, 10, 64)
}

// writeQuotaExceeded 输出 429 与可操作的 details。
//
// details 必须能让客户端区分「哪个维度超了」：
//
//	dimension=calls  → 本周期调用次数用完，等重置或提额；
//	dimension=tokens → token 额度用完，通常是跑了整书翻译这种大任务。
//
// 只回一句「quota exceeded」的话，用户完全不知道下一步该做什么。
//
// scope 区分「你自己的额度」与「全站额度」（global）：
// 前者可以等重置或提额自救，后者换账号也没用——必须让客户端能区分，
// 否则用户会以为是自己账号的问题，反复重试或去注册小号。
func writeQuotaExceeded(w http.ResponseWriter, err error) {
	var qe *store.ErrQuotaExceeded
	if !errors.As(err, &qe) {
		writeError(w, http.StatusTooManyRequests, codeQuotaExceeded, "quota exceeded", nil)
		return
	}
	scope := qe.Scope
	if scope == "" {
		scope = "user"
	}
	msg := "monthly AI quota exceeded: call count limit reached"
	if qe.Dimension == "tokens" {
		msg = "monthly AI quota exceeded: token budget exhausted"
	}
	if scope == "global" {
		msg = "site-wide monthly AI call budget exhausted; retry after the reset time"
	}
	writeError(w, http.StatusTooManyRequests, codeQuotaExceeded, msg, map[string]any{
		"dimension": qe.Dimension,
		"scope":     scope,
		"limit":     qe.Limit,
		"used":      qe.Used,
		// resetAt 用 RFC3339（UTC）：客户端可以直接显示或算倒计时。
		"resetAt": qe.ResetAt.UTC().Format(time.RFC3339),
	})
}
