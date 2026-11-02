package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

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
	codeAccountLocked      = "account_locked"
	codePayloadTooLarge    = "payload_too_large"
	codeInternal           = "internal_error"
	codeUnavailable        = "service_unavailable"
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
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, codeConflict, "resource already exists", nil)
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
