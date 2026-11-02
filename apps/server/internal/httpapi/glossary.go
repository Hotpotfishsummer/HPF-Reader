package httpapi

import (
	"net/http"
	"strings"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/normalize"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// ---- DTO ----

type glossaryTermDTO struct {
	// Key 是归一化 key，客户端也可读（用于按 key 删除）。
	Key     string   `json:"key"`
	Display string   `json:"display"`
	Target  string   `json:"target"`
	Aliases []string `json:"aliases,omitempty"`
	Source  string   `json:"source"`
}

type glossaryDTO struct {
	BookID     string            `json:"bookId"`
	TargetLang string            `json:"targetLang"`
	Version    int64             `json:"version"`
	Terms      []glossaryTermDTO `json:"terms"`
}

type glossaryPutRequest struct {
	TargetLang string            `json:"targetLang"`
	Terms      []glossaryTermDTO `json:"terms"`
	// RemoveKeys 是要删除的归一 key（批量删除与批量写入合并成一个请求，
	// 客户端改一次术语表只需一个往返，也避免「先删后写」两个请求之间出现空窗）。
	RemoveKeys []string `json:"removeKeys,omitempty"`
}

func toGlossaryDTO(g store.Glossary) glossaryDTO {
	out := glossaryDTO{
		BookID:     g.BookID,
		TargetLang: g.TargetLang,
		Version:    g.Version,
		Terms:      make([]glossaryTermDTO, 0, len(g.Terms)),
	}
	for _, t := range g.Terms {
		out.Terms = append(out.Terms, glossaryTermDTO{
			Key: t.Key, Display: t.Display, Target: t.Target,
			Aliases: t.Aliases, Source: string(t.Source),
		})
	}
	return out
}

// handleGetGlossary 返回一本书某个目标语言的术语表。
//
// targetLang 是必填查询参数：没有它就无法确定该返回哪份术语表。
// 不默认成 zh 是因为「猜用户想要哪种语言」会产生难以解释的行为。
func (s *Server) handleGetGlossary(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	// 入参校验必须在查库之前：坏输入不该触发数据库查询。
	// 顺序反了会让「缺 targetLang」这种纯客户端错误变成一次无谓的 DB 往返，
	// 且在 store 不可用时表现为 500 而不是 400。
	targetLang := strings.TrimSpace(r.URL.Query().Get("targetLang"))
	if targetLang == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "targetLang is required", nil)
		return
	}
	if _, err := s.store.GetBook(r.Context(), claims.UserID, bookID); err != nil {
		writeStoreError(w, err)
		return
	}
	g, err := s.store.GetGlossary(r.Context(), claims.UserID, bookID, targetLang)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toGlossaryDTO(g))
}

// handlePutGlossary 批量写入/删除术语。
//
// 语义是「合并」而不是「替换」：只处理请求里出现的 key，
// 请求没提的术语保持不动。这样客户端可以只提交改动的那几条，
// 不必为了改一个译名把整份术语表传上来（既省流量也避免并发覆盖别人的改动）。
func (s *Server) handlePutGlossary(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	bookID := r.PathValue("bookId")
	if !idgen.IsUUID(bookID) {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "bookId must be a UUID", nil)
		return
	}
	// 解码与校验全部在查库之前完成：坏输入不该触发数据库查询。
	var req glossaryPutRequest
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	targetLang := strings.TrimSpace(req.TargetLang)
	if targetLang == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "targetLang is required", nil)
		return
	}
	if len(req.Terms) > 2000 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "too many terms (max 2000)", nil)
		return
	}

	if _, err := s.store.GetBook(r.Context(), claims.UserID, bookID); err != nil {
		writeStoreError(w, err)
		return
	}

	terms := make([]store.GlossaryTerm, 0, len(req.Terms))
	for _, d := range req.Terms {
		target := strings.TrimSpace(d.Target)
		display := strings.TrimSpace(d.Display)
		if target == "" {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, "term target is required", map[string]any{
				"key": d.Key, "display": d.Display,
			})
			return
		}
		// key 可以缺省：由服务端用 normalize 算。
		// 这样客户端不必实现归一化逻辑（那是一套有版本的规则，重复实现必然不一致）。
		key := strings.TrimSpace(d.Key)
		if key == "" {
			if display == "" {
				writeError(w, http.StatusBadRequest, codeInvalidRequest, "term needs key or display", nil)
				return
			}
			key = normalize.Normalize(display).NormKey
			if key == "" {
				writeError(w, http.StatusBadRequest, codeInvalidRequest, "cannot derive key from display", map[string]any{
					"display": display,
				})
				return
			}
		}
		if display == "" {
			display = key
		}
		// source 缺省视为用户确认：走 PUT 接口的都是人工操作。
		// 自动流水线走内部调用，会显式传 llm_extracted。
		src := store.TermSource(strings.TrimSpace(d.Source))
		if src == "" {
			src = store.TermUserConfirmed
		}
		if !src.Valid() {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid term source", map[string]any{
				"source": string(src),
				"allowed": []string{
					string(store.TermUserConfirmed), string(store.TermLLMExtracted), string(store.TermDeterministic),
				},
			})
			return
		}
		terms = append(terms, store.GlossaryTerm{
			Key: key, Display: display, Target: target,
			Aliases: d.Aliases, Source: src,
		})
	}

	if len(terms) > 0 {
		if _, err := s.store.PutGlossaryTerms(r.Context(), claims.UserID, bookID, targetLang, terms); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if len(req.RemoveKeys) > 0 {
		if _, err := s.store.DeleteGlossaryTerms(r.Context(), claims.UserID, bookID, targetLang, req.RemoveKeys); err != nil {
			writeStoreError(w, err)
			return
		}
		// 删除也要进同步通道，否则其它设备永远拉不到「少了一条」。
		for _, key := range req.RemoveKeys {
			if err := s.store.SyncGlossaryTermDelete(r.Context(), claims.UserID, bookID, key); err != nil {
				writeStoreError(w, err)
				return
			}
		}
	}
	// 每条术语变更都写进同步通道（change_log），其它设备靠游标增量拉取。
	//
	// 顺序很重要：先写权威表再写同步日志。反过来若日志先成功、表写失败，
	// 其它设备会拉到一条本地查不到的术语。这里单条失败直接返回错误，
	// 让客户端重试整批（术语写入本身是幂等的）。
	for _, term := range terms {
		if err := s.store.SyncGlossaryTerm(r.Context(), claims.UserID, bookID, term.Key, term); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	g, err := s.store.GetGlossary(r.Context(), claims.UserID, bookID, targetLang)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toGlossaryDTO(g))
}
