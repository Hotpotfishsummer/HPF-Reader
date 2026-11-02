package ai

import (
	"strings"
	"testing"
)

// TestBuildMessagesPutsGlossaryInSystemPrefix 锁住「术语表进 system 前缀」这一结构。
//
// 为什么这很重要：术语表必须放在 system 消息里、且**只放一次**，
// 这样上游的 prefix cache 才能命中——同样的前缀在多块之间复用，
// 缓存命中的输入价格是未命中的 1/50（DeepSeek flash 空闲档 0.02 vs 1 元/百万）。
// 如果把术语表放进每条 user 消息，缓存永远命中不了，整书翻译成本会显著上升。
func TestBuildMessagesPutsGlossaryInSystemPrefix(t *testing.T) {
	req := TranslateRequest{
		Text:       "Elizabeth Bennet said hello.",
		TargetLang: "zh",
		Glossary:   map[string]string{"Elizabeth": "伊丽莎白", "Darcy": "达西"},
	}
	msgs := BuildMessages(req)
	if len(msgs) < 2 {
		t.Fatalf("got %d messages, want at least 2 (system + user)", len(msgs))
	}
	if msgs[0].Role != "system" {
		t.Fatalf("first message role = %q, want system", msgs[0].Role)
	}
	if !strings.Contains(msgs[0].Content, "Elizabeth => 伊丽莎白") {
		t.Fatalf("glossary entry missing from system prefix: %q", msgs[0].Content)
	}
	// 术语表不能重复出现在正文消息里（否则前缀不稳定，缓存失效）。
	last := msgs[len(msgs)-1]
	if strings.Contains(last.Content, "=> 伊丽莎白") {
		t.Fatalf("glossary leaked into the text message: %q", last.Content)
	}
	if last.Content != req.Text {
		t.Fatalf("last message must be the raw text, got %q", last.Content)
	}
}

// TestBuildMessagesInjectsContext 是「chunk.Context 真的进了 prompt」的回归测试。
//
// 缺陷背景：worker 的 translateChunk 曾经没有把 chunk.Context 填进 TranslateRequest，
// 于是 buildChunks 算好的前文上下文**被静默丢弃**，跨块连贯性只剩术语表在维持。
// 这类「字段存在但没人填」的漏接不会报错、不会失败，只能靠测试守住。
//
// 同时断言上下文消息标记为「不要翻译」——否则模型会把前文也翻一遍，
// 既浪费 token，又可能把重复译文混进结果。
func TestBuildMessagesInjectsContext(t *testing.T) {
	req := TranslateRequest{
		Text:    "This is the current chunk.",
		Context: "This is the tail of the previous chunk.",
	}
	msgs := BuildMessages(req)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 (system + context + text)", len(msgs))
	}
	if !strings.Contains(msgs[1].Content, req.Context) {
		t.Fatalf("context not injected: %q", msgs[1].Content)
	}
	if !strings.Contains(msgs[1].Content, "do not translate") {
		t.Fatalf("context message must tell the model not to translate it: %q", msgs[1].Content)
	}
	if msgs[2].Content != req.Text {
		t.Fatalf("last message must be the raw text, got %q", msgs[2].Content)
	}
}

// TestBuildMessagesOmitsContextWhenEmpty 断言空上下文不产生多余消息。
//
// 第一块没有前文。若此时仍插一条空消息，会让前缀在不同块之间不一致，
// 白白破坏 prefix cache 命中率。
func TestBuildMessagesOmitsContextWhenEmpty(t *testing.T) {
	req := TranslateRequest{Text: "First chunk, no context."}
	msgs := BuildMessages(req)
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (system + text) when context is empty", len(msgs))
	}
	if msgs[1].Content != req.Text {
		t.Fatalf("last message must be the raw text, got %q", msgs[1].Content)
	}
}
