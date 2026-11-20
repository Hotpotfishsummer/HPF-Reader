//go:build !windows

package main

func readWindowsSystemProxy() (ProxyConfig, bool) {
	return ProxyConfig{}, false
}
