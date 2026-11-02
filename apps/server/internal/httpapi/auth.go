package httpapi

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/auth"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/idgen"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// newRefreshToken 是 auth.NewRefreshToken 的包内别名（便于测试替换实现）。
var newRefreshToken = auth.NewRefreshToken

// ---- DTO（与 openapi.yaml 对齐）----

type userResponse struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName *string `json:"displayName"`
	CreatedAt   string  `json:"createdAt"`
}

type authTokensResponse struct {
	AccessToken  string       `json:"accessToken"`
	RefreshToken string       `json:"refreshToken"`
	ExpiresIn    int          `json:"expiresIn"`
	User         userResponse `json:"user"`
}

type deviceResponse struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	LastSeenAt string `json:"lastSeenAt,omitempty"`
}

type registerRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	DeviceName  string `json:"deviceName"`
	Platform    string `json:"platform"`
	AppVersion  string `json:"appVersion"`
	DeviceID    string `json:"deviceId"`
}

type loginRequest struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
	AppVersion string `json:"appVersion"`
	DeviceID   string `json:"deviceId"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
	DeviceID     string `json:"deviceId"`
}

type logoutRequest struct {
	RefreshToken string `json:"refreshToken"`
	AllDevices   bool   `json:"allDevices"`
}

// handleRegister 注册新用户并直接返回 token（省一次登录往返）。
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.RegisterOpen {
		writeError(w, http.StatusForbidden, codeForbidden, "registration is disabled", nil)
		return
	}
	var req registerRequest
	if err := decodeJSON(w, r, &req, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if _, err := mail.ParseAddress(email); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid email address", nil)
		return
	}
	if len(req.Password) < 8 || len(req.Password) > 200 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "password must be 8-200 characters", nil)
		return
	}
	if len(req.DisplayName) > 64 {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "displayName too long", nil)
		return
	}
	hash, err := auth.HashPassword(req.Password, s.argon)
	if err != nil {
		s.log.Error("hash password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not create user", nil)
		return
	}
	user, err := s.store.CreateUser(r.Context(), email, hash, req.DisplayName)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, codeConflict, "email already registered", nil)
			return
		}
		writeStoreError(w, err)
		return
	}
	s.audit(r, &user.ID, "auth.register", user.ID, nil)
	s.issueTokens(w, r, http.StatusCreated, user.ID, user.Email, req.DisplayName, user.Role, req.DeviceID, req.Platform, req.AppVersion)
}

// handleLogin 校验口令；含失败计数与账号锁定。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(w, r, &req, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	user, err := s.store.GetUserByEmail(r.Context(), email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// 不区分「邮箱不存在」与「口令错误」，避免账号枚举。
			// 仍然做一次哈希计算以抹平时间差。
			_, _ = auth.VerifyPassword(req.Password, dummyHash)
			writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "invalid email or password", nil)
			return
		}
		writeStoreError(w, err)
		return
	}
	now := s.now()
	if user.IsLocked(now) {
		writeError(w, http.StatusUnauthorized, codeAccountLocked, "account temporarily locked after repeated failures", map[string]any{
			"lockedUntil": user.LockedUntil.UTC().Format(time.RFC3339),
		})
		return
	}
	if user.Status != "active" {
		writeError(w, http.StatusForbidden, codeForbidden, "account is not active", nil)
		return
	}
	ok, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		s.log.Error("verify password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not verify credentials", nil)
		return
	}
	if !ok {
		if err := s.store.RegisterLoginFailure(r.Context(), user.ID, s.cfg.LoginMaxFailures, s.cfg.LoginLockWindow); err != nil {
			s.log.Warn("record login failure", "error", err)
		}
		s.audit(r, &user.ID, "auth.login_failed", user.ID, nil)
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "invalid email or password", nil)
		return
	}
	if err := s.store.ResetLoginFailures(r.Context(), user.ID); err != nil {
		s.log.Warn("reset login failures", "error", err)
	}
	s.audit(r, &user.ID, "auth.login", user.ID, nil)
	s.issueTokens(w, r, http.StatusOK, user.ID, user.Email, derefStr(user.DisplayName), user.Role, req.DeviceID, req.Platform, req.AppVersion)
}

// handleRefresh 轮换 refresh token；检测到重用时吊销整个家族。
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := decodeJSON(w, r, &req, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if strings.TrimSpace(req.RefreshToken) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "refreshToken is required", nil)
		return
	}
	hash := auth.HashRefreshToken(req.RefreshToken)
	tok, err := s.store.GetRefreshTokenByHash(r.Context(), hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, codeUnauthorized, "invalid refresh token", nil)
			return
		}
		writeStoreError(w, err)
		return
	}
	now := s.now()
	// 重用检测：已消费或已吊销的 token 再次出现 → 视为泄露，吊销整个家族。
	if tok.UsedAt != nil || tok.RevokedAt != nil {
		if n, rerr := s.store.RevokeRefreshTokenFamily(r.Context(), tok.FamilyID); rerr != nil {
			s.log.Error("revoke token family", "error", rerr)
		} else {
			s.log.Warn("refresh token reuse detected; family revoked",
				"user_id", tok.UserID, "family_id", tok.FamilyID, "revoked", n)
		}
		s.audit(r, &tok.UserID, "auth.refresh_reuse_detected", tok.FamilyID, nil)
		writeError(w, http.StatusUnauthorized, codeUnauthorized, "refresh token already used; session revoked", nil)
		return
	}
	if now.After(tok.ExpiresAt) {
		writeError(w, http.StatusUnauthorized, codeUnauthorized, "refresh token expired", nil)
		return
	}
	user, err := s.store.GetUserByID(r.Context(), tok.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if user.Status != "active" {
		writeError(w, http.StatusForbidden, codeForbidden, "account is not active", nil)
		return
	}
	access, expiresIn, err := s.tokens.IssueAccessToken(user.ID, derefStr(tok.DeviceID), user.Role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "could not issue token", nil)
		return
	}
	plain, newHash, err := newRefreshToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternal, "could not issue token", nil)
		return
	}
	newID := idgen.NewUUID()
	if err := s.store.CreateRefreshToken(r.Context(), newID, user.ID, tok.FamilyID, newHash,
		tok.DeviceID, now.Add(s.cfg.RefreshTokenTTL), r.UserAgent()); err != nil {
		writeStoreError(w, err)
		return
	}
	if err := s.store.MarkRefreshTokenRotated(r.Context(), tok.ID, newID); err != nil {
		s.log.Warn("mark refresh token rotated", "error", err)
	}
	s.audit(r, &user.ID, "auth.refresh", user.ID, nil)
	writeJSON(w, http.StatusOK, authTokensResponse{
		AccessToken:  access,
		RefreshToken: plain,
		ExpiresIn:    expiresIn,
		User: userResponse{
			ID:          user.ID,
			Email:       user.Email,
			DisplayName: user.DisplayName,
			CreatedAt:   user.CreatedAt.UTC().Format(time.RFC3339),
		},
	})
}

// handleLogout 吊销当前 refresh token（或全部设备）。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req logoutRequest
	// 允许空 body：此时只吊销 access token（客户端侧丢弃即可）。
	_ = decodeJSON(w, r, &req, 64<<10)

	if req.AllDevices {
		if n, err := s.store.RevokeAllUserRefreshTokens(r.Context(), claims.UserID); err != nil {
			writeStoreError(w, err)
			return
		} else {
			s.log.Info("revoked all refresh tokens", "user_id", claims.UserID, "count", n)
		}
	} else if strings.TrimSpace(req.RefreshToken) != "" {
		if err := s.store.RevokeRefreshToken(r.Context(), auth.HashRefreshToken(req.RefreshToken)); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	s.audit(r, &claims.UserID, "auth.logout", claims.UserID, nil)
	w.WriteHeader(http.StatusNoContent)
}

// handleMe 返回当前用户。
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	user, err := s.store.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, userResponse{
		ID:          user.ID,
		Email:       user.Email,
		DisplayName: user.DisplayName,
		CreatedAt:   user.CreatedAt.UTC().Format(time.RFC3339),
	})
}

// handleListDevices 返回设备列表。
func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	devices, err := s.store.ListDevices(r.Context(), claims.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, d := range devices {
		item := deviceResponse{ID: d.ID, Name: d.Name, Platform: d.Platform}
		if d.LastSeenAt != nil {
			item.LastSeenAt = d.LastSeenAt.UTC().Format(time.RFC3339)
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

// audit 写审计日志（失败仅记录，不影响主流程）。
func (s *Server) audit(r *http.Request, userID *string, action, target string, detail map[string]any) {
	var raw []byte
	if len(detail) > 0 {
		raw = mustJSON(detail)
	}
	if err := s.store.WriteAudit(r.Context(), userID, action, target,
		ClientIP(r, s.cfg.TrustedProxies), r.UserAgent(), raw); err != nil {
		s.log.Warn("write audit log", "error", err, "action", action)
	}
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// dummyHash 是一个固定的 argon2id 哈希，用于「用户不存在」时消耗与真实校验等量的 CPU，
// 抹平「邮箱存在与否」的响应时间差（防账号枚举）。
// 它在进程启动时用 DefaultArgon2Params 真实计算一次，因此参数永远与校验路径一致。
var dummyHash = func() string {
	h, err := auth.HashPassword("hpf-reader-dummy-password-for-timing-equalization", auth.DefaultArgon2Params)
	if err != nil {
		// 只可能因为熵源不可用而失败，此时整个进程都不该继续。
		panic("httpapi: cannot compute dummy password hash: " + err.Error())
	}
	return h
}()
