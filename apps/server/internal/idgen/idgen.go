// Package idgen 提供 ID 生成与校验工具。
//
// 设计约定（与客户端 outbox 一致）：
//   - 实体主键与 opId 一律使用 UUID 字符串形态（小写带连字符）；
//   - HLC 的设备前缀取设备 UUID 的前 8 位十六进制（去掉连字符）。
package idgen

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

// NewUUID 生成 UUID v4 字符串（crypto/rand，无外部依赖）。
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 在受支持的平台上不会失败；真的失败说明系统熵源不可用，
		// 此时宁可直接 panic 也不要返回可预测的 ID。
		panic("idgen: crypto/rand unavailable: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant RFC 4122
	buf := make([]byte, 36)
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], b[10:16])
	return string(buf)
}

// IsUUID 判断字符串是否是规范的 UUID 形态（仅做形态校验，不校验版本）。
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !isHexLower(c) && !(c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}

func isHexLower(c rune) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
}

// DevicePrefix 返回设备 UUID 的前 8 个十六进制字符，用作 HLC 的设备部分。
// 非 UUID 形态的输入退化为「去除非十六进制字符后取前 8 位」，保证一定非空。
func DevicePrefix(deviceID string) string {
	out := make([]byte, 0, 8)
	for _, c := range strings.ToLower(deviceID) {
		if isHexLower(c) {
			out = append(out, byte(c))
			if len(out) == 8 {
				return string(out)
			}
		}
	}
	for len(out) < 8 {
		out = append(out, '0')
	}
	return string(out)
}
