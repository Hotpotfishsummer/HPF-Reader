package main

// Evidence-capturing middleware mounted through application.AssetOptions.Middleware.
//
// WHY THIS IS THE RIGHT HOOK (source evidence, wails v3.1.0):
//   internal/assetserver/assetserver.go:56-64
//       handler := http.Handler(http.HandlerFunc(func(w,r){ result.serveHTTP(w, r, userHandler) }))
//       if middleware := options.Middleware; middleware != nil { handler = middleware(handler) }
//   => the user middleware WRAPS the whole asset server, i.e. it runs BEFORE the
//      /wails/runtime handler (which is reached from inside serveHTTP).
//   internal/assetserver/options.go:212  "This middleware injects itself before
//      any of Wails internal middlewares."
//   pkg/application/application_options_test.go:276 TestMiddleware_ShortCircuit
//
// Jobs:
//   1. /spike/report  -> handled and short-circuited HERE (also proves ordering).
//   2. log EVERY request, the Wails-injected identity headers, and the raw body
//      of every /wails/runtime call.
//   3. optionally 403 /wails/runtime (SPIKE_BLOCK=1) to prove denial works.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	evMu           sync.Mutex
	evDirOnce      string
	spikeNonce     string
	denyWindowName string
	denyReason     = "nonce policy"
)

func evidenceDir() string {
	if evDirOnce != "" {
		return evDirOnce
	}
	d := os.Getenv("SPIKE_EVIDENCE_DIR")
	if d == "" {
		d = "evidence"
	}
	_ = os.MkdirAll(d, 0o755)
	evDirOnce = d
	return d
}

func spikeBlockMode() bool { return os.Getenv("SPIKE_BLOCK") == "1" }

func appendJSONL(name string, v any) {
	evMu.Lock()
	defer evMu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(evidenceDir(), name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

// isRuntimeCall excludes /wails/runtime.js, which is a normal JS asset.
func isRuntimeCall(p string) bool {
	return p == "/wails/runtime" || strings.HasPrefix(p, "/wails/runtime/")
}

func ipcMiddleware(next http.Handler) http.Handler {
	denyWindowName = os.Getenv("SPIKE_DENY_WINDOW_NAME")
	spikeNonce = os.Getenv("SPIKE_IPC_NONCE")
	if spikeNonce == "" {
		// A non-empty default is required: otherwise Get() returns "" and the
		// "!= spikeNonce" comparison would silently authorise every caller.
		spikeNonce = "SPIKE-NONCE-0001"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ---- job 1: our own route, handled entirely by the middleware ----
		if r.URL.Path == "/spike/report" {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
			var payload any
			if err := json.Unmarshal(body, &payload); err != nil {
				payload = string(body)
			}
			appendJSONL("probe-results.jsonl", map[string]any{
				"ts": time.Now().Format(time.RFC3339Nano), "handler": "middleware",
				"path": r.URL.Path, "decision": "handled-by-middleware", "report": payload,
			})
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{\"ok\":true,\"handledBy\":\"middleware\"}"))
			return
		}

		// ---- job 2: log every request + the Wails-injected identity ----
		all := map[string][]string{}
		for k, v := range r.Header {
			all[strings.ToLower(k)] = v
		}
		rt := isRuntimeCall(r.URL.Path)

		// Capture the runtime call body to reveal the exact wire format, then
		// put it back so the real handler still works.
		bodyStr := ""
		if rt && r.Body != nil {
			b, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
			_ = r.Body.Close()
			r.Body = io.NopCloser(bytes.NewReader(b))
			bodyStr = string(b)
		}

		decision := "pass"
		if rt && spikeBlockMode() && r.Header.Get("x-hpf-ipc") != spikeNonce {
			decision = "block"
		}
		// Arch-B policy: deny the reader window by its NATIVE window name.
		// Safe to key on because application.go:397-400 uses Header().Set, so
		// page JS cannot forge x-wails-window-name.
		if rt && denyWindowName != "" && r.Header.Get("x-wails-window-name") == denyWindowName {
			decision = "block"
			denyReason = "window-name policy"
		}
		appendJSONL("requests.jsonl", map[string]any{
			"ts":      time.Now().Format(time.RFC3339Nano),
			"handler": "middleware", "kind": "request",
			"method": r.Method, "path": r.URL.Path, "is_runtime_call": rt,
			"decision": decision, "block_mode": spikeBlockMode(),
			"hdr_window_id":   r.Header.Get("x-wails-window-id"),
			"hdr_window_name": r.Header.Get("x-wails-window-name"),
			"hdr_client_id":   r.Header.Get("x-wails-client-id"),
			"hdr_origin":      r.Header.Get("Origin"),
			"hdr_sec_fetch":   r.Header.Get("Sec-Fetch-Site"),
			"body":            bodyStr,
			"headers_all":     all,
		})

		// ---- job 3: denial ----
		if decision == "block" {
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("403 denied by spike middleware (no x-hpf-ipc nonce)"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
