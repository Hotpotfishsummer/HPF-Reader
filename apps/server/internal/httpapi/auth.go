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

// errServerBusy 表示口令哈希并发槽位不可用（请求已取消或排队超时）。
var errServerBusy = errors.New("server busy")

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
	ID       string  `json:"id"`
	Name     *string `json:"name"`
	Platform string  `json:"platform"`
	// 设备名没有记录时返回 null，而不是空字符串（空字符串会假装「有名字，只是空的」）。
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

// changePasswordRequest 是 POST /v1/auth/password 的请求体。
type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
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
	hash, err := func() (string, error) {
		release, ok := s.acquireHashSlot(r.Context())
		if !ok {
			return "", errServerBusy
		}
		defer release()
		return auth.HashPassword(req.Password, s.argon)
	}()
	if errors.Is(err, errServerBusy) {
		writeError(w, http.StatusServiceUnavailable, codeInternal, "server is busy, please retry", nil)
		return
	}
	if err != nil {
		s.log.Error("hash password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not create user", nil)
		return
	}
	dev, err := deviceFrom(req.DeviceID, req.DeviceName, req.Platform, req.AppVersion)
	if err != nil {
		writeDeviceError(w, err)
		return
	}
	if dev.ID == "" {
		// 注册必须落一条设备：客户端没给 deviceId 时服务端生成一个。
		dev.ID = idgen.NewUUID()
	}
	// 用户与设备在**同一事务**里创建：deviceId 冲突时整体回滚，
	// 不会像以前那样留下一个没有任何设备的孤儿用户行。
	user, device, err := s.store.RegisterAccount(r.Context(), email, hash, req.DisplayName, dev, s.cfg.AIMaxPerUser)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusConflict, codeConflict, "email already registered", nil)
			return
		}
		writeDeviceError(w, err)
		return
	}
	s.audit(r, &user.ID, "auth.register", user.ID, nil)
	s.issueTokens(w, r, http.StatusCreated, user, device)
}

// handleLogin 校验口令；含失败计数与账号锁定。
//
// 锁定的语义（这是防「锁死账号」DoS 的关键）：
//   - 只在**校验失败**时累计，绝不在校验前拒绝；
//   - 口令正确时永远放行并清零失败计数 —— 攻击者最多让「错误口令」变慢，
//     不能把正常用户挡在门外（旧实现会让任何人用 5 次错误口令锁死别人的账号）；
//   - 同一 (账号, 来源 IP) 的失败次数由进程内限流器控制，单个 IP 无法反复锁死账号；
//   - 账号级阈值（跨 IP）仍会写库，用于审计与分布式爆破观测。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(w, r, &req, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || req.Password == "" {
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "invalid email or password", nil)
		return
	}
	failKey := s.loginFailKey(r, email)

	// 先看这个 IP 对这个账号是否已经失败太多次：已经超限就不再烧 64MiB 哈希。
	if blocked, reset := s.loginFailLimiter.Blocked(failKey); blocked {
		writeError(w, http.StatusTooManyRequests, codeRateLimited,
			"too many failed attempts for this account; try again later", map[string]any{
				"retryAfter": reset.UTC().Format(time.RFC3339),
			})
		return
	}

	release, ok := s.acquireHashSlot(r.Context())
	if !ok {
		writeError(w, http.StatusServiceUnavailable, codeInternal, "server is busy, please retry", nil)
		return
	}
	defer release()

	user, err := s.store.GetUserByEmail(r.Context(), email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// 不区分「邮箱不存在」与「口令错误」，避免账号枚举。
			// 仍然做一次哈希计算以抹平时间差，并计入失败次数。
			_, _ = auth.VerifyPassword(req.Password, dummyHash)
			s.loginFailLimiter.Record(failKey)
			writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "invalid email or password", nil)
			return
		}
		writeStoreError(w, err)
		return
	}
	pwOK, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		s.log.Error("verify password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not verify credentials", nil)
		return
	}
	if !pwOK {
		s.loginFailLimiter.Record(failKey)
		if err := s.store.RegisterLoginFailure(r.Context(), user.ID, s.cfg.LoginAccountLockFailures, s.cfg.LoginLockWindow); err != nil {
			s.log.Warn("record login failure", "error", err)
		}
		s.audit(r, &user.ID, "auth.login_failed", user.ID, nil)
		// 第 N 次失败本身仍然回 invalid_credentials；从第 N+1 次起由前面的
		// Blocked 预检拦成 429。这样错误码语义与「剩余尝试次数」一致。
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "invalid email or password", nil)
		return
	}
	// 口令正确：放行并清零失败计数（账号被「锁定」也不拦正确口令）。
	s.loginFailLimiter.Clear(failKey)
	if err := s.store.ResetLoginFailures(r.Context(), user.ID); err != nil {
		s.log.Warn("reset login failures", "error", err)
	}
	if user.Status != "active" {
		writeError(w, http.StatusForbidden, codeForbidden, "account is not active", nil)
		return
	}
	s.audit(r, &user.ID, "auth.login", user.ID, nil)
	binding := deviceBinding{
		ID:         strings.TrimSpace(req.DeviceID),
		Name:       strings.TrimSpace(req.DeviceName),
		Platform:   strings.TrimSpace(req.Platform),
		AppVersion: strings.TrimSpace(req.AppVersion),
	}
	device, err := s.bindDevice(r.Context(), user.ID, binding)
	if err != nil {
		writeDeviceError(w, err)
		return
	}
	s.issueTokens(w, r, http.StatusOK, user, device)
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

// loginFailKey 生成登录/改密失败计数的键：(归一化 email, 来源 IP)。
//
// 抽成函数是为了让「登录」与「改密校验当前口令」共用**同一个**计数桶：
// 两处各写一份格式化逻辑，一旦有一处忘了 ToLower/TrimSpace，
// 攻击者就能在两个端点之间拿到两倍的尝试次数（改密端点成了爆破旁路）。
func (s *Server) loginFailKey(r *http.Request, email string) string {
	return strings.ToLower(strings.TrimSpace(email)) + "|" + ClientIP(r, s.cfg.TrustedProxies)
}

// validateChangePasswordRequest 校验改密请求体，返回 (code, message)。
// code 为空表示通过。
//
// 抽成纯函数（不碰 store / 不碰 Request）是为了让它能被直接测试：
// 这些规则是「客户端能自己修好」的问题，必须在触库之前判掉，
// 否则畸形请求会白白占用数据库连接，400 与 401 的语义也会被搅乱。
func validateChangePasswordRequest(req changePasswordRequest) (string, string) {
	if req.CurrentPassword == "" || req.NewPassword == "" {
		return codeInvalidRequest, "currentPassword and newPassword are required"
	}
	// 长度规则与注册完全一致（8~200）：两处不一致会让「注册能过的口令改不进去」。
	if len(req.NewPassword) < 8 || len(req.NewPassword) > 200 {
		return codeInvalidRequest, "newPassword must be 8-200 characters"
	}
	// 允许改成同一个口令会让用户产生「我已经改过了」的假安全感，
	// 而旧口令（很可能已经泄露）实际依旧有效。
	if req.NewPassword == req.CurrentPassword {
		return codeInvalidRequest, "newPassword must differ from currentPassword"
	}
	return "", ""
}

// handleChangePassword 修改口令，并在成功后吊销该用户全部 refresh token。
//
// 这是「口令泄露后自救」的唯一路径。三个必须做对的点：
//
//  1. **先校验当前口令**。只凭一个有效的 access token 就允许改密，
//     等于把「15 分钟内被偷到的 access token」升级成「永久接管账号」。
//     要求当前口令，把攻击者的窗口压回「他知道旧口令」这一前提。
//  2. **改密与吊销在同一事务**（store.ChangePassword）：见那里的注释，
//     两个半成品状态都不可接受。
//  3. **新旧口令必须不同**。允许改成一样的，用户会以为「我已经改过了」，
//     实际上旧口令依旧有效——这是最危险的假安全感。
//
// 失败语义：
//   - 未认证           → 401（由 requireAuth 中间件拦下）
//   - 当前口令错误     → 401 invalid_credentials
//   - 请求体不合法     → 400 invalid_request
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	var req changePasswordRequest
	if err := decodeJSON(w, r, &req, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "invalid JSON body: "+err.Error(), nil)
		return
	}
	if code, msg := validateChangePasswordRequest(req); code != "" {
		writeError(w, http.StatusBadRequest, code, msg, nil)
		return
	}

	user, err := s.store.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}

	// ---- 校验当前口令：泄露后自救的关键一步 ----
	//
	// 与登录路径共用同一个并发闸门（每次 argon2 约 64MiB）：
	// 不共用的话，攻击者可以拿一个有效 token 并发刷改密接口，
	// 用「校验当前口令」这一步把内存打满——闸门只在登录上就是形同虚设。
	pwOK, err := func() (bool, error) {
		release, ok := s.acquireHashSlot(r.Context())
		if !ok {
			return false, errServerBusy
		}
		defer release()
		return auth.VerifyPassword(req.CurrentPassword, user.PasswordHash)
	}()
	if errors.Is(err, errServerBusy) {
		writeError(w, http.StatusServiceUnavailable, codeInternal, "server is busy, please retry", nil)
		return
	}
	if err != nil {
		s.log.Error("verify password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not verify credentials", nil)
		return
	}
	if !pwOK {
		// 与登录失败同一套计数：否则「改密接口」就成了一个不受限的口令爆破入口
		// （持有任意有效 token 即可无限次猜当前口令）。
		failKey := s.loginFailKey(r, user.Email)
		s.loginFailLimiter.Record(failKey)
		s.audit(r, &user.ID, "auth.password_change_failed", user.ID, nil)
		writeError(w, http.StatusUnauthorized, codeInvalidCredentials, "current password is incorrect", nil)
		return
	}

	// ---- 哈希新口令（同样要过闸门）----
	hash, err := func() (string, error) {
		release, ok := s.acquireHashSlot(r.Context())
		if !ok {
			return "", errServerBusy
		}
		defer release()
		return auth.HashPassword(req.NewPassword, s.argon)
	}()
	if errors.Is(err, errServerBusy) {
		writeError(w, http.StatusServiceUnavailable, codeInternal, "server is busy, please retry", nil)
		return
	}
	if err != nil {
		s.log.Error("hash new password", "error", err)
		writeError(w, http.StatusInternalServerError, codeInternal, "could not update password", nil)
		return
	}

	revoked, err := s.store.ChangePassword(r.Context(), user.ID, hash)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// 口令已验证通过：清掉失败计数，别让用户改完密之后还被 429 拦。
	failKey := s.loginFailKey(r, user.Email)
	s.loginFailLimiter.Clear(failKey)

	s.log.Info("password changed; all refresh tokens revoked",
		"user_id", user.ID, "revoked_tokens", revoked)
	s.audit(r, &user.ID, "auth.password_change", user.ID, map[string]any{
		"revokedRefreshTokens": revoked,
	})
	w.WriteHeader(http.StatusNoContent)
}

// handleLogoutAll 吊销该用户全部 refresh token（所有设备下线）。
//
// 单独一个端点而不是「让客户端调 logout 并传 allDevices」：登出接口允许空 body
// （为了只丢 access token 的场景），所以客户端漏传字段时会**静默只登出一台**。
// 安全动作不应该依赖「客户端记得传对参数」——一个不带 body 的 POST 就该确定生效。
func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r.Context())
	n, err := s.store.RevokeAllUserRefreshTokens(r.Context(), claims.UserID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.log.Info("revoked all refresh tokens", "user_id", claims.UserID, "count", n)
	s.audit(r, &claims.UserID, "auth.logout_all", claims.UserID, map[string]any{
		"revokedRefreshTokens": n,
	})
	w.WriteHeader(http.StatusNoContent)
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

// deviceFrom 校验并组装注册用的设备信息。
//
// deviceId 是 uuid 列：这里拦住非法形态，避免它一路走到 SQL 变成 22P02（500）。
func deviceFrom(id, name, platform, appVersion string) (store.DeviceRegistration, error) {
	dev := store.DeviceRegistration{
		ID:         strings.TrimSpace(id),
		Name:       strings.TrimSpace(name),
		Platform:   strings.TrimSpace(platform),
		AppVersion: strings.TrimSpace(appVersion),
	}
	if dev.ID != "" && !idgen.IsUUID(dev.ID) {
		return store.DeviceRegistration{}, errDeviceIDNotUUID
	}
	return dev, nil
}

// writeDeviceError 把设备相关错误翻译成明确的状态码。
//
// deviceId 属于别的账号时必须 409（不是 404）：资源是「冲突」而不是「不存在」，
// 客户端据此知道该换设备 ID / 换账号，而不是傻等重试。
func writeDeviceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDeviceIDNotUUID):
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error(), nil)
	case errors.Is(err, store.ErrDeviceTaken):
		writeError(w, http.StatusConflict, codeConflict,
			"deviceId is already registered to another account", nil)
	default:
		writeStoreError(w, err)
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
