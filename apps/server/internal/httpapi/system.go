package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
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

// issueTokens 是 register/login 共用的令牌签发路径。
//
// 设备行已由调用方准备好（register 在事务里创建，login 单独绑定），
// 这里只负责签发 access/refresh 并返回统一响应体。
func (s *Server) issueTokens(w http.ResponseWriter, r *http.Request, status int, u store.User, dev store.Device) {
	access, expiresIn, err := s.tokens.IssueAccessToken(u.ID, dev.ID, u.Role)
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
	if err := s.store.CreateRefreshToken(r.Context(), idgen.NewUUID(), u.ID, familyID, hash,
		&dev.ID, s.now().Add(s.cfg.RefreshTokenTTL), r.UserAgent()); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, status, authTokensResponse{
		AccessToken:  access,
		RefreshToken: plain,
		ExpiresIn:    expiresIn,
		User: userResponse{
			ID:          u.ID,
			Email:       u.Email,
			DisplayName: u.DisplayName,
			CreatedAt:   u.CreatedAt.UTC().Format(time.RFC3339),
		},
	})
}

// bindDevice 校验并绑定设备（login 路径）。
//
// deviceId 由客户端提供：为空时服务端生成一个（兼容老客户端）；
// 提供了但不是 UUID 时直接 400 —— 否则非 UUID 字符串会被绑进 uuid 列，
// 触发 SQLSTATE 22P02 并冒成 500。
//
// deviceName 必须原样落库，否则 GET /v1/devices 的设备名永远是空的。
func (s *Server) bindDevice(ctx context.Context, userID string, req deviceBinding) (store.Device, error) {
	deviceID := req.ID
	if deviceID == "" {
		deviceID = idgen.NewUUID()
	} else if !idgen.IsUUID(deviceID) {
		return store.Device{}, errDeviceIDNotUUID
	}
	return s.store.UpsertDevice(ctx, deviceID, userID, req.Name, req.Platform, req.AppVersion)
}

// deviceBinding 是 register/login 共用的设备字段。
type deviceBinding struct {
	ID         string
	Name       string
	Platform   string
	AppVersion string
}

// errDeviceIDNotUUID 是本地参数校验错误（触库之前就被发现），由调用方翻译成 400。
var errDeviceIDNotUUID = errors.New("deviceId must be a UUID")

func nullableName(name string) *string {
	if name == "" {
		return nil
	}
	return &name
}
