// Package sync 实现 HPF-Reader 的同步内核：HLC 混合逻辑时钟与服务端权威合并规则。
//
// 这里刻意不依赖数据库与 HTTP，全部是纯函数，便于单元测试与将来在客户端复用同一套算法。
// 对应设计文档：docs/TECH-PLAN.md §4.3。
package sync

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// HLC 字符串格式：<13 位十六进制毫秒>-<8 位十六进制计数器>-<8 位十六进制设备前缀>。
// 例：0192a3f4c1b0-0000000a-7f3c9d21。
//
// 关键性质：**字符串字典序 == 时间序**。因此可以直接在 SQL 里用 `hlc > $1` 比较，
// 也可以直接用 Go 的字符串比较，不需要解码。
const (
	hlcTimeDigits = 13
	hlcSeqDigits  = 8
	hlcDevDigits  = 8
	// 13 + 1 + 8 + 1 + 8 = 31 字符。
	// 定长是关键：只要宽度固定，字典序就等于时间序，SQL 里可以直接比较 hlc 字符串。
	hlcTotal      = hlcTimeDigits + 1 + hlcSeqDigits + 1 + hlcDevDigits
	hlcDevAllZero = "00000000"
)

var (
	// ErrHLCFormat 表示 HLC 字符串形态非法。
	ErrHLCFormat = errors.New("sync: malformed hlc")
	// ErrHLCOverflow 表示计数器溢出（同一毫秒内超过 2^32 次事件，实际不可能发生）。
	ErrHLCOverflow = errors.New("sync: hlc counter overflow")
)

// hlcMaxTime 限制物理时间部分不超过 13 位十六进制（约公元 10889 年），
// 保证 Format 出来的字符串长度恒定（变长会破坏字典序比较）。
const hlcMaxTime = uint64(1)<<52 - 1

// HLC 是一个混合逻辑时钟值。零值不可用，用 NewHLC 构造。
type HLC struct {
	// Time 是毫秒精度的逻辑时间（可能被远程事件推进到快于本地墙钟）。
	Time uint64
	// Seq 是同一毫秒内的事件计数器。
	Seq uint32
	// Device 是 8 位十六进制设备前缀，用于同 HLC 时的确定性 tie-break。
	Device string
}

// NewHLC 用本地墙钟与设备前缀初始化时钟。
// devicePrefix 由调用方用 idgen.DevicePrefix(deviceID) 计算，必须是 8 位十六进制。
func NewHLC(devicePrefix string, now time.Time) (HLC, error) {
	dev, err := sanitizeDevice(devicePrefix)
	if err != nil {
		return HLC{}, err
	}
	ms := uint64(now.UnixMilli())
	if ms > hlcMaxTime {
		ms = hlcMaxTime
	}
	return HLC{Time: ms, Seq: 0, Device: dev}, nil
}

// sanitizeDevice 把任意设备标识规整成 8 位小写字母数字：
// 非 [0-9a-z] 的字符丢弃，不足补 '0'，超长截断。
//
// 说明：HLC 只要求设备段「定长、可比较、稳定」，并不要求是十六进制；
// 规整成小写字母数字既保留了 openapi.yaml 里 \`7f3c9d21\` 的形态，
// 又让任意形态的 deviceId（例如 \`alice-pc\`）都能确定性地参与 tie-break。
func sanitizeDevice(p string) (string, error) {
	var b strings.Builder
	for _, c := range strings.ToLower(strings.TrimSpace(p)) {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') {
			b.WriteRune(c)
			if b.Len() == hlcDevDigits {
				break
			}
		}
	}
	out := b.String()
	if out == "" {
		return hlcDevAllZero, nil
	}
	return out + strings.Repeat("0", hlcDevDigits-len(out)), nil
}

// Parse 解析 HLC 字符串。严格校验长度、分隔符与十六进制合法性。
func Parse(s string) (HLC, error) {
	if len(s) != hlcTotal {
		return HLC{}, fmt.Errorf("%w: want %d chars, got %d", ErrHLCFormat, hlcTotal, len(s))
	}
	if s[hlcTimeDigits] != '-' || s[hlcTimeDigits+1+hlcSeqDigits] != '-' {
		return HLC{}, fmt.Errorf("%w: missing separators in %q", ErrHLCFormat, s)
	}
	timePart := s[:hlcTimeDigits]
	seqPart := s[hlcTimeDigits+1 : hlcTimeDigits+1+hlcSeqDigits]
	devPart := s[hlcTimeDigits+1+hlcSeqDigits+1:]
	ms, err := strconv.ParseUint(timePart, 16, 64)
	if err != nil {
		return HLC{}, fmt.Errorf("%w: bad time part %q", ErrHLCFormat, timePart)
	}
	seq, err := strconv.ParseUint(seqPart, 16, 32)
	if err != nil {
		return HLC{}, fmt.Errorf("%w: bad seq part %q", ErrHLCFormat, seqPart)
	}
	for _, c := range devPart {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'z') {
			return HLC{}, fmt.Errorf("%w: bad device part %q", ErrHLCFormat, devPart)
		}
	}
	return HLC{Time: ms, Seq: uint32(seq), Device: devPart}, nil
}

// IsValidHLC 是 Parse 的便捷判断，供请求校验使用。
func IsValidHLC(s string) bool {
	_, err := Parse(s)
	return err == nil
}

// String 输出定长 HLC 字符串；长度恒定是「字典序 == 时间序」的前提。
func (h HLC) String() string {
	if h.Device == "" {
		h.Device = hlcDevAllZero
	}
	return fmt.Sprintf("%0*x-%0*x-%s", hlcTimeDigits, h.Time, hlcSeqDigits, h.Seq, h.Device)
}

// Compare 按 (Time, Seq, Device) 三元组比较：
//   - 负值：h 早于 o
//   - 0   ：完全相同
//   - 正值：h 晚于 o
func (h HLC) Compare(o HLC) int {
	if h.Time != o.Time {
		if h.Time < o.Time {
			return -1
		}
		return 1
	}
	if h.Seq != o.Seq {
		if h.Seq < o.Seq {
			return -1
		}
		return 1
	}
	if h.Device == o.Device {
		return 0
	}
	if h.Device < o.Device {
		return -1
	}
	return 1
}

// Before 报告 h 是否严格早于 o。
func (h HLC) Before(o HLC) bool { return h.Compare(o) < 0 }

// Time 以毫秒为单位返回逻辑时间对应的墙钟时间（仅用于展示/审计）。
func (h HLC) WallTime() time.Time { return time.UnixMilli(int64(h.Time)) }

// Clock 是可变的本地时钟，持有「已发出的最大值」以保证单调。
// 并发安全由调用方负责（本项目里每个请求/每个 op 串行使用）。
type Clock struct {
	last   HLC
	device string
}

// NewClock 创建本地时钟。
func NewClock(devicePrefix string, now time.Time) (*Clock, error) {
	base, err := NewHLC(devicePrefix, now)
	if err != nil {
		return nil, err
	}
	return &Clock{last: base, device: base.Device}, nil
}

// Device 返回该时钟的设备前缀（8 位小写字母数字）。
func (c *Clock) Device() string { return c.device }

// Last 返回最近一次发出的时钟值。
func (c *Clock) Last() HLC { return c.last }

// next 实现 HLC 的推进算法：
//
//	pt = max(now, last.Time)
//	若 pt == last.Time：Seq++（溢出则 Time++ 且 Seq 归零）
//	否则：Time = pt, Seq = 0
//
// 这保证「同一设备任意两次调用返回严格递增的 HLC」。
func (c *Clock) next(now time.Time) (HLC, error) {
	ms := uint64(now.UnixMilli())
	if ms > hlcMaxTime {
		ms = hlcMaxTime
	}
	if ms > c.last.Time {
		c.last = HLC{Time: ms, Seq: 0, Device: c.device}
		return c.last, nil
	}
	// 墙钟没有前进（同毫秒或时钟回拨）：靠计数器保证单调。
	if c.last.Seq == ^uint32(0) {
		if c.last.Time >= hlcMaxTime {
			return HLC{}, ErrHLCOverflow
		}
		c.last = HLC{Time: c.last.Time + 1, Seq: 0, Device: c.device}
		return c.last, nil
	}
	c.last = HLC{Time: c.last.Time, Seq: c.last.Seq + 1, Device: c.device}
	return c.last, nil
}

// Send 产生一个本地事件的新 HLC。
func (c *Clock) Send(now time.Time) (HLC, error) { return c.next(now) }

// Observe 处理收到远程 HLC 的事件（读/写皆可），把本地时钟推进到「已知的最大值之后」，
// 从而保证本地之后产生的 HLC 一定晚于远程事件 —— 这就是因果单调性。
func (c *Clock) Observe(remote HLC, now time.Time) (HLC, error) {
	if remote.Device == "" {
		return HLC{}, fmt.Errorf("%w: empty device prefix", ErrHLCFormat)
	}
	ms := uint64(now.UnixMilli())
	if ms > hlcMaxTime {
		ms = hlcMaxTime
	}
	// pt = max(local, remote, wall)
	maxTime := c.last.Time
	if remote.Time > maxTime {
		maxTime = remote.Time
	}
	if ms > maxTime {
		maxTime = ms
	}
	switch {
	case maxTime == c.last.Time && maxTime == remote.Time:
		// 三者同毫秒：计数器取较大者 + 1，保证严格大于两者。
		seq := c.last.Seq
		if remote.Seq > seq {
			seq = remote.Seq
		}
		if seq == ^uint32(0) {
			if maxTime >= hlcMaxTime {
				return HLC{}, ErrHLCOverflow
			}
			c.last = HLC{Time: maxTime + 1, Seq: 0, Device: c.device}
		} else {
			c.last = HLC{Time: maxTime, Seq: seq + 1, Device: c.device}
		}
	case maxTime == c.last.Time:
		// 本地更大或相等：沿用本地计数器 +1。
		if c.last.Seq == ^uint32(0) {
			c.last = HLC{Time: maxTime + 1, Seq: 0, Device: c.device}
		} else {
			c.last = HLC{Time: maxTime, Seq: c.last.Seq + 1, Device: c.device}
		}
	case maxTime == remote.Time:
		// 远程更大：从远程计数器 +1 起算，丢弃本地陈旧计数。
		if remote.Seq == ^uint32(0) {
			c.last = HLC{Time: maxTime + 1, Seq: 0, Device: c.device}
		} else {
			c.last = HLC{Time: maxTime, Seq: remote.Seq + 1, Device: c.device}
		}
	default:
		// 墙钟最大：全新起算。
		c.last = HLC{Time: maxTime, Seq: 0, Device: c.device}
	}
	return c.last, nil
}
