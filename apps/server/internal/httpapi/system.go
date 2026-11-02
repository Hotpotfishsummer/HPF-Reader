package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
)

// handleHealthz 是存活探针：不查任何外部依赖，只要进程能响应就返回 200。
// （探活失败会导致容器被重启，因此绝不能因为数据库慢就报失败。）
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"time":   s.now().UTC().Format(time.RFC3339),
	})
}

// handleReadyz 是就绪探针：真实 ping 数据库，失败返回 503。
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if s.store == nil || s.store.Pool() == nil {
		writeError(w, http.StatusServiceUnavailable, codeUnavailable, "database not configured", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Pool().Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, codeUnavailable, "database not ready", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ready",
		"db":      "ok",
		"storage": s.storage.Kind(),
	})
}

// 认证辅助：register/login/refresh 共用的返回体。
func (s *Server) issueTokens(w http.ResponseWriter, r *http.Request, status int, userID, email, displayName, role, deviceID, platform, appVersion string) {
	device, err := s.ensureDevice(r.Context(), userID, deviceID, platform, appVersion)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	access, expiresIn, err := s.tokens.IssueAccessToken(userID, device.ID, role)
	if err != nil {
		s.log.Error("issue access token", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not issue token", nil)
		return
	}
	plain, hash, err := newRefreshToken()
	if err != nil {
		s.log.Error("generate refresh token", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not issue token", nil)
		return
	}
	familyID := idgen.NewUUID()
	if err := s.store.CreateRefreshToken(r.Context(), idgen.NewUUID(), userID, familyID, hash,
		&device.ID, s.now().Add(s.cfg.RefreshTokenTTL), r.UserAgent()); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, status, authTokensResponse{
		AccessToken:  access,
		RefreshToken: plain,
		ExpiresIn:    expiresIn,
		User: userResponse{
			ID:          userID,
			Email:       email,
			DisplayName: nullableName(displayName),
			CreatedAt:   s.now().UTC().Format(time.RFC3339),
		},
	})
}

// ensureDevice 确保设备存在。deviceId 由客户端提供；为空时服务端生成一个。
func (s *Server) ensureDevice(ctx context.Context, userID, deviceID, platform, appVersion string) (deviceInfo, error) {
	if deviceID == "" || !idgen.IsUUID(deviceID) {
		deviceID = idgen.NewUUID()
	}
	d, err := s.store.UpsertDevice(ctx, deviceID, userID, "", platform, appVersion)
	if err != nil {
		return deviceInfo{}, err
	}
	return deviceInfo{ID: d.ID}, nil
}

type deviceInfo struct{ ID string }

func nullableName(name string) *string {
	if name == "" {
		return nil
	}
	return &name
}
