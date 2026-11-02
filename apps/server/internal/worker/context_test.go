package worker

import (
	"context"
	"testing"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
	"github.com/hpf-reader/hpf-reader/apps/server/internal/store"
)

// storeChunkWithContext 构造一个用于测试的块（只填本用例关心的字段）。
func storeChunkWithContext(text, ctxText string) store.TranslationChunk {
	return store.TranslationChunk{
		JobID:      "test-job",
		ChunkIndex: 1,
		SourceText: text,
		Context:    ctxText,
	}
}

// recordingTranslator 记录每次收到的 TranslateRequest，用于断言 worker 到底传了什么。
//
// 为什么需要它：Context 这类字段是**可选**的，漏传不会编译失败、不会报错、
// 也不会让任何既有测试变红——它只会让翻译质量悄悄下降。
// 唯一能守住这种漏接的办法，是断言翻译器**实际收到**的请求内容。
type recordingTranslator struct {
	reqs []ai.TranslateRequest
}

func (r *recordingTranslator) Name() string { return "recording" }

func (r *recordingTranslator) TranslateStream(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, error) {
	r.reqs = append(r.reqs, req)
	return r.emit()
}

func (r *recordingTranslator) TranslateStreamWithUsage(ctx context.Context, req ai.TranslateRequest) (<-chan string, <-chan error, <-chan ai.Usage, error) {
	r.reqs = append(r.reqs, req)
	ch, errs, err := r.emit()
	u := make(chan ai.Usage, 1)
	u <- ai.Usage{Source: ai.UsageSourceEstimated}
	close(u)
	return ch, errs, u, err
}

func (r *recordingTranslator) emit() (<-chan string, <-chan error, error) {
	ch := make(chan string, 1)
	ch <- "translated"
	close(ch)
	errs := make(chan error, 1)
	errs <- nil
	close(errs)
	return ch, errs, nil
}

// TestTranslateChunkForwardsContext 是「chunk.Context 被静默丢弃」的回归测试。
//
// 缺陷背景：buildChunks 已经算好了每块的前文上下文（booktext.Chunk.Context），
// 但 translateChunk 构造 TranslateRequest 时**没有填 Context 字段**，
// 于是上下文在进入 prompt 之前就被丢掉了。跨块连贯性只剩术语表在维持。
//
// 这个测试断言翻译器**实际收到**了 Context，而不是只断言「函数能跑通」。
func TestTranslateChunkForwardsContext(t *testing.T) {
	rec := &recordingTranslator{}
	w := New(Deps{Translator: rec})
	chunk := storeChunkWithContext("current text", "previous chunk tail")
	if _, _, err := w.translateChunk(context.Background(), chunk, bookTranslateOptions{TargetLang: "zh"}); err != nil {
		t.Fatalf("translateChunk: %v", err)
	}
	if len(rec.reqs) != 1 {
		t.Fatalf("translator called %d times, want 1", len(rec.reqs))
	}
	if rec.reqs[0].Context != "previous chunk tail" {
		t.Fatalf("translator received Context = %q, want %q: "+
			"chunk.Context is being silently dropped before it reaches the prompt",
			rec.reqs[0].Context, "previous chunk tail")
	}
	if rec.reqs[0].Text != "current text" {
		t.Fatalf("translator received Text = %q, want the chunk source text", rec.reqs[0].Text)
	}
}

// TestTranslateChunkForwardsGlossary 断言术语表也被完整转发。
//
// 术语表若丢失，全书译名一致性就彻底失效——而同样地，它丢失时不会报错。
func TestTranslateChunkForwardsGlossary(t *testing.T) {
	rec := &recordingTranslator{}
	w := New(Deps{Translator: rec})
	chunk := storeChunkWithContext("text", "")
	opts := bookTranslateOptions{
		TargetLang: "zh",
		Glossary:   map[string]string{"Elizabeth": "伊丽莎白"},
	}
	if _, _, err := w.translateChunk(context.Background(), chunk, opts); err != nil {
		t.Fatalf("translateChunk: %v", err)
	}
	if got := rec.reqs[0].Glossary["Elizabeth"]; got != "伊丽莎白" {
		t.Fatalf("glossary not forwarded, got %q", got)
	}
}
