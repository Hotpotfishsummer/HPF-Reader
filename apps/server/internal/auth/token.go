package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims 是 access token 的载荷。
//
// 注意：这里不携带任何权限位以外的业务状态；权限变更（改密码 / 注销）通过
// refresh token 家族吊销 + 短 TTL（15 分钟）来兜底。
type Claims struct {
	UserID   string `json:"uid"`
	DeviceID string `json:"did,omitempty"`
	Role     string `json:"role,omitempty"`
	jwt.RegisteredClaims
}

// TokenIssuer 签发与校验 access token。
type TokenIssuer struct {
	secret    []byte
	issuer    string
	accessTTL time.Duration
	now       func() time.Time
}

// NewTokenIssuer 构造签发器。secret 长度不足会返回错误。
func NewTokenIssuer(secret, issuer string, accessTTL time.Duration) (*TokenIssuer, error) {
	if len(secret) < 16 {
		return nil, errors.New("auth: jwt secret must be at least 16 bytes")
	}
	if accessTTL <= 0 {
		accessTTL = 15 * time.Minute
	}
	return &TokenIssuer{secret: []byte(secret), issuer: issuer, accessTTL: accessTTL, now: time.Now}, nil
}

// IssueAccessToken 签发 access token，返回 token 与有效期秒数。
func (t *TokenIssuer) IssueAccessToken(userID, deviceID, role string) (string, int, error) {
	now := t.now()
	claims := Claims{
		UserID:   userID,
		DeviceID: deviceID,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			Issuer:    t.issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-30 * time.Second)), // 容忍轻微时钟偏差
			ExpiresAt: jwt.NewNumericDate(now.Add(t.accessTTL)),
			ID:        randomHex(8),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(t.secret)
	if err != nil {
		return "", 0, err
	}
	return signed, int(t.accessTTL.Seconds()), nil
}

// ParseAccessToken 校验并解析 access token。
func (t *TokenIssuer) ParseAccessToken(raw string) (Claims, error) {
	var claims Claims
	_, err := jwt.ParseWithClaims(raw, &claims, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", tok.Header["alg"])
		}
		return t.secret, nil
	}, jwt.WithIssuer(t.issuer), jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return Claims{}, err
	}
	if claims.UserID == "" {
		return Claims{}, errors.New("auth: token missing uid")
	}
	return claims, nil
}

// AccessTTL 返回 access token 有效期。
func (t *TokenIssuer) AccessTTL() time.Duration { return t.accessTTL }

// NewRefreshToken 生成不透明 refresh token（256 位随机），返回明文与其 sha256。
// 明文只回给客户端，服务端仅存哈希 —— 数据库泄露也无法直接冒用会话。
func NewRefreshToken() (plain string, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	plain = base64.RawURLEncoding.EncodeToString(buf)
	return plain, HashRefreshToken(plain), nil
}

// HashRefreshToken 计算 refresh token 的存储哈希。
func HashRefreshToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return hex.EncodeToString(buf)
}
