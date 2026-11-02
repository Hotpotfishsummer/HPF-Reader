package main

// SecretService is a deliberately PRIVILEGED service used to prove the impact
// of a compromised renderer. It is a spike artifact, not product code.
//
// The threat model it models: in HPF-Reader the Go side owns the local database,
// the filesystem and the sync credentials. If an untrusted EPUB can reach a
// bound method, it reaches all of that.

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type SecretService struct{}

// GetSecret returns a value a book-content frame must never be able to read.
func (s *SecretService) GetSecret() string {
	return "TOP-SECRET-TOKEN-12345"
}

// WriteFile writes attacker-controlled content to disk. Relative names land in
// the evidence directory so the spike cannot damage unrelated files; absolute
// paths are accepted to show the capability is unscoped. The PoC only ever
// calls it with a relative name.
func (s *SecretService) WriteFile(name string, data string) (string, error) {
	if !filepath.IsAbs(name) {
		name = filepath.Join(evidenceDir(), name)
	}
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return "", err
	}
	stamp := fmt.Sprintf("%s | written via bound Go method\n", time.Now().Format(time.RFC3339Nano))
	if err := os.WriteFile(name, []byte(data+stamp), 0o644); err != nil {
		return "", err
	}
	return name, nil
}

// ReadFile reads an arbitrary path: the classic "read the user's files" impact.
func (s *SecretService) ReadFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(b) > 4096 {
		b = b[:4096]
	}
	return string(b), nil
}
