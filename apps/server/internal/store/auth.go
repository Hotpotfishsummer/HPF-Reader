package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// User 是 users 表的领域映射。
type User struct {
	ID           string
	Email        string
	PasswordHash string
	DisplayName  *string
	Role         string
	Status       string
	QuotaBytes   int64
	QuotaAICalls int
	FailedLogins int
	LockedUntil  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// IsLocked 报告账号是否处于登录锁定窗口内。
func (u User) IsLocked(now time.Time) bool {
	return u.LockedUntil != nil && u.LockedUntil.After(now)
}

const userColumns = `id, email, password_hash, display_name, role, status,
	quota_bytes, quota_ai_calls, failed_logins, locked_until, created_at, updated_at`

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.DisplayName, &u.Role, &u.Status,
		&u.QuotaBytes, &u.QuotaAICalls, &u.FailedLogins, &u.LockedUntil, &u.CreatedAt, &u.UpdatedAt)
	return u, err
}

// CreateUser 插入新用户；邮箱冲突时返回 ErrConflict。
func (s *Store) CreateUser(ctx context.Context, email, passwordHash, displayName string) (User, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO users (id, email, password_hash, display_name)
		VALUES (gen_random_uuid(), $1, $2, $3)
		RETURNING `+userColumns, email, passwordHash, nullStr(displayName))
	u, err := scanUser(row)
	return u, wrap(err)
}

// GetUserByEmail 按邮箱查询（大小写不敏感，CITEXT）。
func (s *Store) GetUserByEmail(ctx context.Context, email string) (User, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE email = $1`, email)
	u, err := scanUser(row)
	return u, wrap(err)
}

// GetUserByID 按 ID 查询。
func (s *Store) GetUserByID(ctx context.Context, id string) (User, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id)
	u, err := scanUser(row)
	return u, wrap(err)
}

// RegisterLoginFailure 累加失败次数；达到阈值时锁定账号。
// 返回累加后的失败次数是否已达到上限。
func (s *Store) RegisterLoginFailure(ctx context.Context, userID string, maxFailures int, lockWindow time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users
		SET failed_logins = failed_logins + 1,
		    locked_until = CASE
		        WHEN failed_logins + 1 >= $2 THEN now() + $3::interval
		        ELSE locked_until
		    END,
		    updated_at = now()
		WHERE id = $1`, userID, maxFailures, lockWindow.String())
	return wrap(err)
}

// ResetLoginFailures 登录成功后清零失败计数与锁定。
func (s *Store) ResetLoginFailures(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now()
		WHERE id = $1`, userID)
	return wrap(err)
}

// Device 是 devices 表映射。
//
// Name 是 *string：devices.name 可空，空值必须以 null 回给客户端，
// 不能用一个空字符串冒充「有名字」。
type Device struct {
	ID         string
	UserID     string
	Name       *string
	Platform   string
	AppVersion string
	LastSeenAt *time.Time
	CreatedAt  time.Time
}

// DeviceRegistration 是绑定设备时要写入的字段。
type DeviceRegistration struct {
	ID         string
	Name       string
	Platform   string
	AppVersion string
}

// rowQuerier 同时被 *pgxpool.Pool 与 pgx.Tx 满足，便于让同一段 SQL 既能独立执行也能进事务。
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// UpsertDevice 注册设备或刷新 last_seen_at。id 由客户端提供（稳定标识）。
//
// deviceId 已属于另一个账号时返回 ErrDeviceTaken（而不是让 UPDATE 静默影响 0 行后
// 冒出一个语义错误的 ErrNotFound）。
func (s *Store) UpsertDevice(ctx context.Context, id, userID, name, platform, appVersion string) (Device, error) {
	return upsertDevice(ctx, s.pool, userID, DeviceRegistration{
		ID: id, Name: name, Platform: platform, AppVersion: appVersion,
	})
}

// upsertDevice 是 UpsertDevice 的事务内版本：q 可以是连接池，也可以是 pgx.Tx。
//
// 关键在 ON CONFLICT ... WHERE devices.user_id = EXCLUDED.user_id：
// 冲突且属于同一用户时更新，属于别的用户时**不更新且不返回行**——
// 这里把「没有返回行」明确翻译成 ErrDeviceTaken，供上层返回 409。
func upsertDevice(ctx context.Context, q rowQuerier, userID string, dev DeviceRegistration) (Device, error) {
	row := q.QueryRow(ctx, `
		INSERT INTO devices (id, user_id, name, platform, app_version, last_seen_at)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (id) DO UPDATE SET
		    name = COALESCE(EXCLUDED.name, devices.name),
		    platform = COALESCE(EXCLUDED.platform, devices.platform),
		    app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
		    last_seen_at = now()
		WHERE devices.user_id = EXCLUDED.user_id
		RETURNING id, user_id, name, COALESCE(platform, ''), COALESCE(app_version, ''), last_seen_at, created_at`,
		dev.ID, userID, nullStr(dev.Name), nullStr(dev.Platform), nullStr(dev.AppVersion))
	var d Device
	err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &d.AppVersion, &d.LastSeenAt, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrDeviceTaken
	}
	if err != nil {
		return Device{}, wrap(err)
	}
	return d, nil
}

// RegisterAccount 在**单个事务**里创建用户并绑定设备。
//
// 为什么必须是一个事务：注册要同时写 users 和 devices 两张表。
// 之前分两步执行时，deviceId 冲突会让第二步失败、第一步已经提交，
// 于是库里留下一个没有任何设备的「孤儿用户」——邮箱被占用且无法重新注册。
//
// 失败语义：
//   - 邮箱已存在      → ErrConflict
//   - deviceId 归他人 → ErrDeviceTaken（事务回滚，不留用户行）
func (s *Store) RegisterAccount(ctx context.Context, email, passwordHash, displayName string, dev DeviceRegistration) (User, Device, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, Device{}, wrap(err)
	}
	// Commit 之后再 Rollback 会返回 ErrTxClosed，忽略即可。
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
		INSERT INTO users (id, email, password_hash, display_name)
		VALUES (gen_random_uuid(), $1, $2, $3)
		RETURNING `+userColumns, email, passwordHash, nullStr(displayName))
	user, err := scanUser(row)
	if err != nil {
		if isUniqueViolation(err) {
			return User{}, Device{}, fmt.Errorf("%w: %v", ErrConflict, err)
		}
		return User{}, Device{}, wrap(err)
	}
	device, err := upsertDevice(ctx, tx, user.ID, dev)
	if err != nil {
		// ErrDeviceTaken 也会走到这里：直接返回，事务由 defer 回滚。
		return User{}, Device{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, Device{}, wrap(err)
	}
	return user, device, nil
}

// ListDevices 返回用户的设备（最近活跃优先）。
func (s *Store) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, name, COALESCE(platform, ''), COALESCE(app_version, ''), last_seen_at, created_at
		FROM devices WHERE user_id = $1
		ORDER BY COALESCE(last_seen_at, created_at) DESC, id`, userID)
	if err != nil {
		return nil, wrap(err)
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &d.AppVersion, &d.LastSeenAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// TouchDevice 更新设备最后活跃时间（同步请求调用）。
func (s *Store) TouchDevice(ctx context.Context, userID, deviceID string) error {
	if deviceID == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE devices SET last_seen_at = now()
		WHERE id = $1 AND user_id = $2`, deviceID, userID)
	return wrap(err)
}

// RefreshToken 是 refresh_tokens 表映射（明文 token 从不落库）。
type RefreshToken struct {
	ID        string
	UserID    string
	DeviceID  *string
	FamilyID  string
	TokenHash string
	IssuedAt  time.Time
	ExpiresAt time.Time
	UsedAt    *time.Time
	RevokedAt *time.Time
}

// CreateRefreshToken 写入一条 refresh token 记录。
func (s *Store) CreateRefreshToken(ctx context.Context, id, userID, familyID, tokenHash string, deviceID *string, expiresAt time.Time, userAgent string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO refresh_tokens (id, user_id, device_id, family_id, token_hash, expires_at, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, userID, deviceID, familyID, tokenHash, expiresAt, nullStr(userAgent))
	return wrap(err)
}

// GetRefreshTokenByHash 按 token 哈希查询。
func (s *Store) GetRefreshTokenByHash(ctx context.Context, tokenHash string) (RefreshToken, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, user_id, device_id, family_id, token_hash, issued_at, expires_at, used_at, revoked_at
		FROM refresh_tokens WHERE token_hash = $1`, tokenHash)
	var t RefreshToken
	err := row.Scan(&t.ID, &t.UserID, &t.DeviceID, &t.FamilyID, &t.TokenHash, &t.IssuedAt, &t.ExpiresAt, &t.UsedAt, &t.RevokedAt)
	return t, wrap(err)
}

// MarkRefreshTokenRotated 标记旧 token 已被消费。
func (s *Store) MarkRefreshTokenRotated(ctx context.Context, id, replacedBy string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE refresh_tokens SET used_at = now(), replaced_by = $2 WHERE id = $1`, id, replacedBy)
	return wrap(err)
}

// RevokeRefreshTokenFamily 吊销整个 token 家族（检测到重用时）。
// 这是 refresh token 重用检测的核心：任何一次重用都让攻击者与用户同时掉线，用户需重新登录。
func (s *Store) RevokeRefreshTokenFamily(ctx context.Context, familyID string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		WHERE family_id = $1 AND revoked_at IS NULL`, familyID)
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// RevokeRefreshToken 吊销单个 token（登出该设备）。
func (s *Store) RevokeRefreshToken(ctx context.Context, tokenHash string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, tokenHash)
	return wrap(err)
}

// RevokeAllUserRefreshTokens 吊销用户全部 refresh token（改密码 / 注销 / 强制下线）。
func (s *Store) RevokeAllUserRefreshTokens(ctx context.Context, userID string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// DeleteExpiredRefreshTokens 清理过期 token（由定时任务调用）。
func (s *Store) DeleteExpiredRefreshTokens(ctx context.Context, grace time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM refresh_tokens
		WHERE expires_at < now() - $1::interval OR (revoked_at IS NOT NULL AND revoked_at < now() - $1::interval)`,
		grace.String())
	if err != nil {
		return 0, wrap(err)
	}
	return tag.RowsAffected(), nil
}

// WriteAudit 写审计日志（失败不阻塞主流程，调用方自行决定是否记录错误）。
func (s *Store) WriteAudit(ctx context.Context, userID *string, action, target, ip, ua string, detail []byte) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO audit_logs (user_id, action, target, ip, ua, detail)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, action, nullStr(target), nullStr(ip), nullStr(ua), jsonOrNull(detail))
	return wrap(err)
}
