package booktext

import (
	"strings"
	"testing"
)

// TestChunkChaptersRespectsParagraphBoundaries 是分块最重要的性质：
// **块边界必须在段落边界**。切断句子会让模型补全缺失部分，产生幻觉。
func TestChunkChaptersRespectsParagraphBoundaries(t *testing.T) {
	paras := []string{
		"第一段内容。", "第二段内容。", "第三段内容。", "第四段内容。",
	}
	chapters := []Chapter{{Index: 0, Title: "第一章", Paragraphs: paras}}
	// 用一个把每段估成 3000 token 的估算函数，逼它每 2 段切一块。
	chunks := ChunkChapters(chapters, func(string) int { return 3000 })
	if len(chunks) != 2 {
		t.Fatalf("chunks = %d, want 2（4 段 × 3000 token，目标 6000）", len(chunks))
	}
	for i, c := range chunks {
		if c.Paragraphs != 2 {
			t.Fatalf("chunk %d 段数 = %d, want 2", i, c.Paragraphs)
		}
		// 关键断言：每块拼回去必须还是完整段落，不能有半句。
		for _, para := range strings.Split(c.Text, "\n\n") {
			if !strings.HasSuffix(para, "。") {
				t.Fatalf("chunk %d 出现被切断的段落: %q", i, para)
			}
		}
	}
}

// TestChunkChaptersNoOverlap 证明块之间**不重叠**。
// 重叠会让同一段被计费两次。
func TestChunkChaptersNoOverlap(t *testing.T) {
	paras := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		paras = append(paras, "段落"+string(rune('A'+i))+"。")
	}
	chapters := []Chapter{{Index: 0, Paragraphs: paras}}
	chunks := ChunkChapters(chapters, func(string) int { return 1000 })
	seen := map[string]bool{}
	total := 0
	for _, c := range chunks {
		for _, para := range strings.Split(c.Text, "\n\n") {
			if seen[para] {
				t.Fatalf("段落被重复计入多个块（重叠）: %q", para)
			}
			seen[para] = true
			total++
		}
	}
	if total != 20 {
		t.Fatalf("总段落数 = %d, want 20（不重不漏）", total)
	}
}

// TestChunkChaptersDoesNotCrossChapter 证明块不跨章节边界。
// 跨章节会让「本章上下文」串味，且不利于按章展示进度。
func TestChunkChaptersDoesNotCrossChapter(t *testing.T) {
	chapters := []Chapter{
		{Index: 0, Paragraphs: []string{"A1。", "A2。"}},
		{Index: 1, Paragraphs: []string{"B1。", "B2。"}},
	}
	// 估算很小，若允许跨章会把四段合成一块。
	chunks := ChunkChapters(chapters, func(string) int { return 10 })
	if len(chunks) != 2 {
		t.Fatalf("chunks = %d, want 2（每章一块，不跨章）", len(chunks))
	}
	for i, c := range chunks {
		if c.ChapterIndex != i {
			t.Fatalf("chunk %d ChapterIndex = %d, want %d", i, c.ChapterIndex, i)
		}
	}
}

// TestChunkChaptersCarriesContext 证明后续块带上了前一块末尾原文。
// 跨块连贯性靠这个上下文补，而不是靠重叠原文。
func TestChunkChaptersCarriesContext(t *testing.T) {
	chapters := []Chapter{{Index: 0, Paragraphs: []string{"第一段。", "第二段。", "第三段。"}}}
	chunks := ChunkChapters(chapters, func(string) int { return 3000 })
	if len(chunks) < 2 {
		t.Fatalf("chunks = %d, want >= 2", len(chunks))
	}
	if chunks[0].Context != "" {
		t.Fatalf("第一块不该有上下文，得到 %q", chunks[0].Context)
	}
	if chunks[1].Context == "" {
		t.Fatal("第二块应带上第一块末尾作为上下文")
	}
}
