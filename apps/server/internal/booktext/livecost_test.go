//go:build liveai

// 整书真实成本实测：用真模型把一本书按生产路径（分块 → 逐块翻译 → 累加 usage）跑完，
// 得出「一本书到底花多少钱」。
//
// 为什么这件事必须做：
//   - 规划里「5,000,000 token ≈ 10 整书」是**拍出来的**，没有实测依据；
//   - §10.3 已测出思考 token 让计费输出达可见字数 6.7 倍，但那只基于单句；
//   - 配额默认值直接决定用户能翻几本书，估错会让用户要么用不完、要么中途被 429。
//
// 跑法：
//
//	HPF_LIVE_AI_BASE_URL=... HPF_LIVE_AI_KEY=... HPF_LIVE_AI_MODEL=... \
//	  go test -tags liveai ./internal/booktext/ -run LiveBookCost -v -timeout 60m
package booktext

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hpf-reader/hpf-reader/apps/server/internal/ai"
)

func liveTranslator(t *testing.T) ai.Translator {
	t.Helper()
	base := os.Getenv("HPF_LIVE_AI_BASE_URL")
	key := os.Getenv("HPF_LIVE_AI_KEY")
	model := os.Getenv("HPF_LIVE_AI_MODEL")
	if base == "" || key == "" {
		t.Skip("HPF_LIVE_AI_BASE_URL / HPF_LIVE_AI_KEY 未设置，跳过")
	}
	tr, err := ai.New(ai.Config{Provider: "openai", BaseURL: base, APIKey: key, Model: model, Timeout: 180 * time.Second})
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	return tr
}

// TestLiveBookCost 跑完指定书的**前 N 章**（默认 2 章，避免测试太慢/太贵），
// 按生产分块逻辑切块，逐块真翻译，累加上游 usage，输出每千字成本。
//
// 只跑前几章的理由：成本结构（每块固定开销、思考 token 占比）在前几章就已稳定，
// 跑全书的边际信息量很小，但耗时与费用线性增长。
func TestLiveBookCost(t *testing.T) {
	book := os.Getenv("HPF_LIVE_BOOK")
	if book == "" {
		book = filepath.Join("..", "..", "..", "..", "tests", "fixtures", "books", "frankenstein.epub")
	}
	maxChapters := 2
	if v := os.Getenv("HPF_LIVE_MAX_CHAPTERS"); v != "" {
		fmt.Sscanf(v, "%d", &maxChapters)
	}

	f, err := os.Open(book)
	if err != nil {
		t.Fatalf("open book: %v", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	chapters, err := ExtractEPUB(f, st.Size())
	if err != nil {
		t.Fatalf("extract epub: %v", err)
	}
	// 跳过空章节（封面、版权页、目录页常为 0 段落）。
	//
	// 这不是测试技巧：EPUB 的 spine 里封面/版权页很常见，它们没有正文段落。
	// 生产路径（worker/translate.go:292）对这类章节的处理是「不产生块」，
	// 所以这里也按同样口径过滤，否则会拿到 0 块而误以为解析失败。
	nonEmpty := make([]Chapter, 0, len(chapters))
	for _, ch := range chapters {
		if len(ch.Paragraphs) > 0 {
			nonEmpty = append(nonEmpty, ch)
		}
	}
	skipped := len(chapters) - len(nonEmpty)
	if len(nonEmpty) > maxChapters {
		nonEmpty = nonEmpty[:maxChapters]
	}
	chapters = nonEmpty

	chunks := ChunkChapters(chapters, ai.EstimateTokens)
	t.Logf("书: %s | 总章=%d 跳过空章=%d 实跑章=%d 块=%d",
		filepath.Base(book), len(chapters)+skipped, skipped, len(chapters), len(chunks))
	if len(chunks) == 0 {
		t.Fatalf("没有切出任何块（实跑章=%d），无法测成本", len(chapters))
	}

	tr := liveTranslator(t)
	ctx := context.Background()

	var totalIn, totalOut, totalVisibleRunes, totalSrcChars int
	start := time.Now()
	for i, c := range chunks {
		req := ai.TranslateRequest{
			Text:       c.Text,
			TargetLang: "zh-CN",
			SourceLang: "en",
			Context:    c.Context,
		}
		out, errCh, usageCh, err := tr.TranslateStreamWithUsage(ctx, req)
		if err != nil {
			t.Fatalf("chunk %d: start: %v", i, err)
		}
		var sb strings.Builder
		for piece := range out {
			sb.WriteString(piece)
		}
		for e := range errCh {
			if e != nil {
				t.Fatalf("chunk %d: stream: %v", i, e)
			}
		}
		var u ai.Usage
		select {
		case u = <-usageCh:
		case <-time.After(30 * time.Second):
			t.Fatalf("chunk %d: usage 通道无产出", i)
		}
		visible := len([]rune(strings.TrimSpace(sb.String())))
		totalIn += u.InputTokens
		totalOut += u.OutputTokens
		totalVisibleRunes += visible
		totalSrcChars += len([]rune(c.Text))
		t.Logf("块 %d/%d: 源=%d字 译文=%d字 in=%d out=%d", i+1, len(chunks), len([]rune(c.Text)), visible, u.InputTokens, u.OutputTokens)
	}

	elapsed := time.Since(start)
	total := totalIn + totalOut
	t.Logf("===== 汇总 =====")
	t.Logf("块数=%d  源文字=%d  译文字=%d  耗时=%s", len(chunks), totalSrcChars, totalVisibleRunes, elapsed.Round(time.Second))
	t.Logf("输入 token=%d  输出 token=%d  合计=%d", totalIn, totalOut, total)
	if totalVisibleRunes > 0 {
		t.Logf("每千字译文消耗 token = %d（这是配额换算的关键数字）", total/totalVisibleRunes*1000)
	}
	if totalOut > 0 && totalVisibleRunes > 0 {
		t.Logf("输出/可见字数倍率 = %.2f（思考 token 造成的放大）", float64(totalOut)/float64(totalVisibleRunes))
	}
	if total == 0 {
		t.Fatal("总 token 为 0，说明 usage 完全没拿到")
	}
}
