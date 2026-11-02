package httpapi

import (
	"net/http"
	"strings"
)

// handleSourceSearch 在合法书源中搜索（一期内置 Project Gutenberg）。
//
// 支持 source 参数指定单个源；不带则搜索全部并聚合结果。
// 部分源失败不影响整体（把错误放在响应的 details 里，前端可提示降级）。
func (s *Server) handleSourceSearch(w http.ResponseWriter, r *http.Request) {
	if s.sources == nil {
		writeError(w, http.StatusServiceUnavailable, codeUnavailable, "sources are not configured", nil)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "q is required", nil)
		return
	}
	if len(q) > 256 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "q is too long", nil)
		return
	}
	source := strings.TrimSpace(r.URL.Query().Get("source"))

	items, err := s.sources.Search(r.Context(), source, q)
	if err != nil {
		s.metrics.IncSourceSearch(true)
		if strings.Contains(err.Error(), "unknown source") {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error(), map[string]any{
				"available": s.sources.Names(),
			})
			return
		}
		writeError(w, http.StatusBadGateway, codeUnavailable, err.Error(), nil)
		return
	}
	s.metrics.IncSourceSearch(false)
	writeJSON(w, http.StatusOK, items)
}
