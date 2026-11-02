//go:build liveai

// Package ai 的真模型验证测试（需要真实 API key，故加 build tag 隔离）。
//
// 为什么必须单独跑：
//   - fake provider 能验证 SSE 链路、错误处理、取消，但**验证不了**真实 usage 帧、
//   - 真实模型的 usage 帧格式（stream_options.include_usage）与假实现完全不同，
//   - 计费依赖 usage 的数字，用假数据「验证」等于没验证。
//
// 跑法：
//
//	HPF_LIVE_AI_BASE_URL=... HPF_LIVE_AI_KEY=... HPF_LIVE_AI_MODEL=... \
//	  go test -tags liveai ./internal/ai/ -run Live -v
package ai

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func liveTranslator(t *testing.T) Translator {
	t.Helper()
	base := os.Getenv("HPF_LIVE_AI_BASE_URL")
	key := os.Getenv("HPF_LIVE_AI_KEY")
	model := os.Getenv("HPF_LIVE_AI_MODEL")
	if base == "" || key == "" {
		t.Skip("HPF_LIVE_AI_BASE_URL / HPF_LIVE_AI_KEY 未设置，跳过真模型验证")
	}
	tr, err := New(Config{Provider: "openai", BaseURL: base, APIKey: key, Model: model, Timeout: 90 * time.Second})
	if err != nil {
		t.Fatalf("construct translator: %v", err)
	}
	return tr
}

// TestLiveTranslateReturnsChinese 验证**真的翻出中文**，而不是把原文抄回来。
//
// 这是最基本也最容易自欺的一条：假实现可以返回任意字符串，「测试通过」毫无意义。
// 这里断言输出里必须出现中文字符，且不能等于原文。
func TestLiveTranslateReturnsChinese(t *testing.T) {
	tr := liveTranslator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	req := TranslateRequest{
		Text:       "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
		TargetLang: "zh-CN",
		SourceLang: "en",
	}
	out, errCh, err := tr.TranslateStream(ctx, req)
	if err != nil {
		t.Fatalf("start stream: %v", err)
	}

	var sb strings.Builder
	for piece := range out {
		sb.WriteString(piece)
	}
	for e := range errCh {
		if e != nil {
			t.Fatalf("stream error: %v", e)
		}
	}

	got := strings.TrimSpace(sb.String())
	if got == "" {
		t.Fatal("译文为空")
	}
	if got == req.Text {
		t.Fatalf("译文与原文完全相同，说明模型没翻译: %q", got)
	}
	hasHan := false
	for _, r := range got {
		if r >= 0x4E00 && r <= 0x9FFF {
			hasHan = true
			break
		}
	}
	if !hasHan {
		t.Fatalf("译文里没有汉字，目标语言是 zh-CN: %q", got)
	}
	t.Logf("译文（%d 字符）: %s", len([]rune(got)), got)
}

// TestLiveUsageFrameIsReal 验证 usage 帧能被解析且数字合理。
//
// 这是**fake provider 测不出来的**部分，也是计费的唯一依据。
// 断言 token 数 > 0 且与输入长度大致成比例（不是随便给的常数）。
func TestLiveUsageFrameIsReal(t *testing.T) {
	tr := liveTranslator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	text := "The quick brown fox jumps over the lazy dog. " + strings.Repeat("This sentence exists only to make the input longer. ", 8)
	req := TranslateRequest{Text: text, TargetLang: "zh-CN", SourceLang: "en"}
	out, errCh, usageCh, err := tr.TranslateStreamWithUsage(ctx, req)
	if err != nil {
		t.Fatalf("start stream: %v", err)
	}
	for range out {
	}
	for e := range errCh {
		if e != nil {
			t.Fatalf("stream error: %v", e)
		}
	}

	var u Usage
	select {
	case u = <-usageCh:
	case <-time.After(10 * time.Second):
		t.Fatal("usage 通道没有产出（调用方会永久阻塞——这正是注释里警告的情形）")
	}

	if u.InputTokens <= 0 || u.OutputTokens <= 0 {
		t.Fatalf("usage 数字不合理: input=%d output=%d", u.InputTokens, u.OutputTokens)
	}
	// 输入约 340 字符英文，token 数应在合理区间；给宽区间只为抓「明显错」，不锁死模型行为。
	if u.InputTokens < 20 || u.InputTokens > 2000 {
		t.Fatalf("input tokens=%d 与输入长度不匹配（约 %d 字符）", u.InputTokens, len(text))
	}
	t.Logf("usage: input=%d output=%d source=%s", u.InputTokens, u.OutputTokens, u.Source)
}

// TestLiveGlossaryIsHonored 验证术语表**真的生效**（模型用指定译名）。
//
// 这条如果不通过，术语一致性功能就是空话。
func TestLiveGlossaryIsHonored(t *testing.T) {
	tr := liveTranslator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	req := TranslateRequest{
		Text:       "Mr. Darcy smiled at Elizabeth.",
		TargetLang: "zh-CN",
		SourceLang: "en",
		Glossary:   map[string]string{"Mr. Darcy": "达西先生", "Elizabeth": "伊丽莎白"},
	}
	out, errCh, err := tr.TranslateStream(ctx, req)
	if err != nil {
		t.Fatalf("start stream: %v", err)
	}
	var sb strings.Builder
	for piece := range out {
		sb.WriteString(piece)
	}
	for e := range errCh {
		if e != nil {
			t.Fatalf("stream error: %v", e)
		}
	}
	got := sb.String()
	if !strings.Contains(got, "达西") {
		t.Fatalf("术语表未生效：译文里没有「达西」，实际: %q", got)
	}
	t.Logf("术语表译文: %s", got)
}

// TestLiveReasoningTokensAreCounted 记录一个**会真实影响成本口径**的上游行为：
//
// 推理型模型（如 deepseek-v4.1 系列）把思考过程计入 completion_tokens，
// 但**不把思考内容放进正文流**。实测上游原始帧：
//
//	completion_tokens=232，其中 completion_tokens_details.reasoning_tokens=210
//
// 也就是说 31 个字的译文，用户实际为 232 个输出 token 付费，其中 210 个是看不见的思考。
//
// 这条测试**不是断言「不应该这样」**——那是上游行为，我们改不了。
// 它的作用是留下证据，让「整书翻译的实际成本比按字数估算高 N 倍」有据可查，
// 而不是等用户看到账单才发现。
func TestLiveReasoningTokensAreCounted(t *testing.T) {
	tr := liveTranslator(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// 一句短文本：如果按字数估，输出应该只有几十 token。
	req := TranslateRequest{
		Text:       "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
		TargetLang: "zh-CN",
		SourceLang: "en",
	}
	out, errCh, usageCh, err := tr.TranslateStreamWithUsage(ctx, req)
	if err != nil {
		t.Fatalf("start stream: %v", err)
	}
	var sb strings.Builder
	for piece := range out {
		sb.WriteString(piece)
	}
	for e := range errCh {
		if e != nil {
			t.Fatalf("stream error: %v", e)
		}
	}
	var u Usage
	select {
	case u = <-usageCh:
	case <-time.After(10 * time.Second):
		t.Fatal("usage 通道无产出")
	}

	visible := len([]rune(strings.TrimSpace(sb.String())))
	if visible == 0 {
		t.Fatal("译文为空")
	}
	// 只记录、不强断言倍数：不同模型/不同文本的思考量差异很大，锁死会变成脆弱测试。
	// 但若 output 竟然小于可见字符数，说明 usage 解析出错，这个要断言。
	if u.OutputTokens < visible {
		t.Fatalf("输出 token(%d) 小于可见字符数(%d)，usage 解析可能有误", u.OutputTokens, visible)
	}
	t.Logf("可见译文 %d 字，计费输出 token=%d（含思考 token，正文看不到）", visible, u.OutputTokens)
	if u.OutputTokens > visible*3 {
		t.Logf("⚠️ 计费输出是可见字数的 %.1f 倍：整书翻译成本会显著高于「按字数估算」，请据此校准配额",
			float64(u.OutputTokens)/float64(visible))
	}
}
