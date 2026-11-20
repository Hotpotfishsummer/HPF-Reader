package main

import (
	"testing"
)

func TestBrowserServiceInputValidation(t *testing.T) {
	s := NewBrowserService()
	// 空 URL 应当报错
	err := s.OpenURL("   ")
	if err == nil {
		t.Fatalf("expected error for empty URL")
	}

	// 正常 URL 不应报错
	err = s.OpenURL("https://singlelogin.re")
	if err != nil {
		t.Fatalf("unexpected error for valid URL: %v", err)
	}
}
