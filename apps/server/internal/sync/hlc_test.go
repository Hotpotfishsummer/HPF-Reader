package sync

import (
	"testing"
	"time"
)

func TestHLCFormatRoundTrip(t *testing.T) {
	h, err := NewHLC("7f3c9d21", time.UnixMilli(0x0192a3f4c1b0))
	if err != nil {
		t.Fatalf("NewHLC: %v", err)
	}
	h.Seq = 0xa
	s := h.String()
	const want = "00192a3f4c1b0-0000000a-7f3c9d21"
	if s != want {
		t.Fatalf("String() = %q, want %q", s, want)
	}
	back, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if back != h {
		t.Fatalf("round trip mismatch: %+v vs %+v", back, h)
	}
}

func TestHLCParseRejectsMalformed(t *testing.T) {
	bad := []string{
		"",
		"0192a3f4c1b0-0000000a",                 // 缺设备段
		"00192a3f4c1b-0000000a-7f3c9d21",        // 时间位数不足
		"00192a3f4c1b0_0000000a_7f3c9d21",       // 分隔符错误
		"00192a3f4c1b0-0000000g-7f3c9d21",       // 非十六进制
		"00192a3f4c1b0-0000000a-7f3c9d21-extra", // 过长
		"zzzzzzzzzzzzz-0000000a-7f3c9d21",       // 时间非十六进制
	}
	for _, s := range bad {
		if _, err := Parse(s); err == nil {
			t.Fatalf("Parse(%q) should fail", s)
		}
	}
	if IsValidHLC("00192a3f4c1b0-0000000a-7f3c9d21") != true {
		t.Fatal("valid HLC rejected")
	}
}

func TestHLCStringOrderEqualsTimeOrder(t *testing.T) {
	dev := "aaaaaaaa"
	cur := int64(1000)
	var prev string
	for i := 0; i < 5; i++ {
		a := makeHLC(cur, 1, dev)
		b := makeHLC(cur, 2, dev)
		if !(a < b) {
			t.Fatalf("same ms: %s should sort before %s", a, b)
		}
		c := makeHLC(cur+1, 0, dev)
		if !(b < c) {
			t.Fatalf("next ms: %s should sort before %s", b, c)
		}
		if prev != "" && !(prev < a) {
			t.Fatalf("monotonic ordering broken: %s !< %s", prev, a)
		}
		prev = a
		cur++
	}
}

// 同一设备调用 Send 必须严格递增，即使墙钟不前进或回拨。
func TestClockSendIsStrictlyMonotonic(t *testing.T) {
	wall := int64(1_700_000_000_000)
	c, err := NewClock("deadbeef", time.UnixMilli(wall))
	if err != nil {
		t.Fatalf("NewClock: %v", err)
	}
	var last string
	for i := 0; i < 100; i++ {
		h, err := c.Send(time.UnixMilli(wall))
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		s := h.String()
		if last != "" && !(last < s) {
			t.Fatalf("iteration %d: %s is not < %s", i, last, s)
		}
		last = s
	}
	// 时钟回拨：仍然必须递增。
	h, err := c.Send(time.UnixMilli(wall - 60_000))
	if err != nil {
		t.Fatalf("Send after rollback: %v", err)
	}
	if !(last < h.String()) {
		t.Fatalf("rollback broke monotonicity: %s !< %s", last, h.String())
	}
}

// Observe 之后，本设备新产生的 HLC 必须晚于所有已观测事件（因果单调）。
func TestClockObserveAdvancesPastRemote(t *testing.T) {
	wall := int64(1_700_000_000_000)
	c, _ := NewClock("11111111", time.UnixMilli(wall))
	remote := makeHLC(wall+5000, 7, "22222222")
	observed, err := c.Observe(mustParse(t, remote), time.UnixMilli(wall))
	if err != nil {
		t.Fatalf("Observe: %v", err)
	}
	if !(remote < observed.String()) {
		t.Fatalf("observed %s should be > remote %s", observed.String(), remote)
	}
	next, err := c.Send(time.UnixMilli(wall)) // 墙钟依旧落后
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !(observed.String() < next.String()) {
		t.Fatalf("local clock did not stay ahead: %s !< %s", observed.String(), next.String())
	}
}

// 两个设备互相 Observe 后，后写者一定能覆盖先写者（收敛性前提）。
func TestTwoClocksConvergeOnMax(t *testing.T) {
	wall := int64(1_700_000_000_000)
	a, _ := NewClock("aaaaaaaa", time.UnixMilli(wall))
	b, _ := NewClock("bbbbbbbb", time.UnixMilli(wall))

	ha, _ := a.Send(time.UnixMilli(wall))
	hb, _ := b.Observe(mustParse(t, ha.String()), time.UnixMilli(wall))
	if !(ha.String() < hb.String()) {
		t.Fatalf("b should produce a greater HLC after observing a: %s !< %s", ha.String(), hb.String())
	}
	ha2, _ := a.Observe(mustParse(t, hb.String()), time.UnixMilli(wall))
	if !(hb.String() < ha2.String()) {
		t.Fatalf("a should produce a greater HLC after observing b: %s !< %s", hb.String(), ha2.String())
	}
}

func mustParse(t *testing.T, s string) HLC {
	t.Helper()
	h, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return h
}
