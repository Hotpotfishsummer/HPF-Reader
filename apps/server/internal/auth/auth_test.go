package auth

import (
	"strings"
	"testing"
	"time"
)

// 测试用的低成本参数（生产默认 64MB 内存，跑单元测试太慢）。
var testParams = Argon2Params{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple", testParams)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("unexpected PHC prefix: %s", hash)
	}
	ok, err := VerifyPassword("correct horse battery staple", hash)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("correct password rejected")
	}
	bad, err := VerifyPassword("wrong password", hash)
	if err != nil {
		t.Fatalf("VerifyPassword(wrong): %v", err)
	}
	if bad {
		t.Fatal("wrong password accepted")
	}
}

func TestHashPasswordIsSaltedPerCall(t *testing.T) {
	a, _ := HashPassword("same-password", testParams)
	b, _ := HashPassword("same-password", testParams)
	if a == b {
		t.Fatal("two hashes of the same password must differ (per-call salt)")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	for _, bad := range []string{"", "plaintext", "$argon2id$v=19$m=1,t=1,p=1$onlyfourparts", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Fatalf("malformed hash %q should error", bad)
		}
	}
}

func TestTokenIssuerRoundTrip(t *testing.T) {
	iss, err := NewTokenIssuer("0123456789abcdef0123456789abcdef", "hpf-reader", 15*time.Minute)
	if err != nil {
		t.Fatalf("NewTokenIssuer: %v", err)
	}
	token, expiresIn, err := iss.IssueAccessToken("user-1", "device-1", "user")
	if err != nil {
		t.Fatalf("IssueAccessToken: %v", err)
	}
	if expiresIn != 900 {
		t.Fatalf("expiresIn = %d, want 900", expiresIn)
	}
	claims, err := iss.ParseAccessToken(token)
	if err != nil {
		t.Fatalf("ParseAccessToken: %v", err)
	}
	if claims.UserID != "user-1" || claims.DeviceID != "device-1" || claims.Role != "user" {
		t.Fatalf("claims mismatch: %+v", claims)
	}
}

func TestTokenIssuerRejectsForeignSignature(t *testing.T) {
	a, _ := NewTokenIssuer("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hpf-reader", time.Minute)
	b, _ := NewTokenIssuer("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "hpf-reader", time.Minute)
	token, _, _ := a.IssueAccessToken("user-1", "", "user")
	if _, err := b.ParseAccessToken(token); err == nil {
		t.Fatal("token signed by another secret must be rejected")
	}
}

func TestTokenIssuerRejectsWrongIssuer(t *testing.T) {
	a, _ := NewTokenIssuer("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "issuer-a", time.Minute)
	token, _, _ := a.IssueAccessToken("user-1", "", "user")
	b, _ := NewTokenIssuer("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "issuer-b", time.Minute)
	if _, err := b.ParseAccessToken(token); err == nil {
		t.Fatal("token from a different issuer must be rejected")
	}
}

func TestTokenIssuerRejectsShortSecret(t *testing.T) {
	if _, err := NewTokenIssuer("short", "hpf-reader", time.Minute); err == nil {
		t.Fatal("short secret must be rejected")
	}
}

func TestRefreshTokenHashing(t *testing.T) {
	plain, hash, err := NewRefreshToken()
	if err != nil {
		t.Fatalf("NewRefreshToken: %v", err)
	}
	if plain == "" || hash == "" {
		t.Fatal("empty token")
	}
	if plain == hash {
		t.Fatal("stored hash must not equal the plaintext token")
	}
	if HashRefreshToken(plain) != hash {
		t.Fatal("hash mismatch for the same token")
	}
	other, _, _ := NewRefreshToken()
	if HashRefreshToken(other) == hash {
		t.Fatal("two tokens must not share a hash")
	}
}

func TestRateLimiterFixedWindow(t *testing.T) {
	rl := NewRateLimiter(3, time.Minute)
	now := time.Now()
	rl.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if ok, _ := rl.Allow("1.2.3.4"); !ok {
			t.Fatalf("request %d should be allowed", i+1)
		}
	}
	if ok, reset := rl.Allow("1.2.3.4"); ok {
		t.Fatal("4th request should be limited")
	} else if !reset.After(now) {
		t.Fatal("reset time should be in the future")
	}
	// 另一个 key 不受影响。
	if ok, _ := rl.Allow("5.6.7.8"); !ok {
		t.Fatal("other keys must not be affected")
	}
	// 窗口过后恢复。
	now = now.Add(2 * time.Minute)
	if ok, _ := rl.Allow("1.2.3.4"); !ok {
		t.Fatal("window should have reset")
	}
}
