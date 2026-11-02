package booktext

import "strings"

// 分块：把「章节 → 段落」切成约 6000 token 的块，供后台翻译任务逐块处理。
//
// 为什么按章切、章内按段落聚合到 6000 token：
//
//  1. **块边界必须在段落边界**。切断句子会让模型「补全」缺失部分，产生幻觉——
//     这是翻译质量的头号杀手，比任何 prompt 技巧都重要。
//  2. **约 6000 token** 是成本与可续跑性的折中。调研实测（docs/research/ 系列）：
//     分块比整书一次性贵约 1.9 倍（因为每块都要重复发 system 前缀与上下文），
//     但买的是断点续跑——一本 30 万字的书要跑几十分钟，中途崩溃重头再来是不可接受的。
//     这个交换值得，**不要为了省钱改回整书一次性**。
//  3. **不重叠**。重叠会让同一段被计费两次，且拼接时要去重，得不偿失。
//     跨块的连贯性靠「前一块末尾作为上下文」来补（见 Chunk.Context），而不是靠重叠原文。

// 分块参数。
const (
	// TargetTokensPerChunk 是每块的目标 token 数。
	TargetTokensPerChunk = 6000
	// MaxTokensPerChunk 是硬上限：单个段落超长时（罕见但存在，例如整章无分段），
	// 超过它就不再往块里塞，避免一次请求超出模型上下文窗口。
	MaxTokensPerChunk = 9000
	// ContextTailChars 是随块发送的「上一块末尾原文」长度上限。
	// 只带尾部而不是整块：带整块会让输入翻倍，而连贯性收益递减。
	ContextTailChars = 600
)

// Chunk 是一个待翻译的文本块。
type Chunk struct {
	// Index 是全局块序号（从 0 开始，跨章节连续）。
	Index int
	// ChapterIndex 是所属章节序号。
	ChapterIndex int
	// ChapterTitle 是章节标题（可能为空）。
	ChapterTitle string
	// Text 是本块原文（段落间以两个换行分隔，**段落边界被保留**）。
	Text string
	// Paragraphs 是本块包含的段落数（用于诊断与进度显示）。
	Paragraphs int
	// Context 是前一块末尾的原文，用于保持跨块连贯。
	// 不带译文而带原文：译文还没生成时就要构造 prompt，且原文是模型可见的稳定锚点。
	Context string
}

// ChunkChapters 把章节切成块。
//
// estimate 是 token 估算函数（由调用方注入，避免 booktext 依赖 ai 包造成循环引用）。
// 传入 nil 时按字符数粗略折算（中文约 1.5 字/token，见 ai.EstimateTokens）。
func ChunkChapters(chapters []Chapter, estimate func(string) int) []Chunk {
	if estimate == nil {
		estimate = roughTokenEstimate
	}
	var (
		chunks    []Chunk
		prevTail  string
		globalIdx int
	)

	for _, ch := range chapters {
		var (
			curParas []string
			curTok   int
		)
		flushChunk := func() {
			if len(curParas) == 0 {
				return
			}
			text := joinParagraphs(curParas)
			chunks = append(chunks, Chunk{
				Index:        globalIdx,
				ChapterIndex: ch.Index,
				ChapterTitle: ch.Title,
				Text:         text,
				Paragraphs:   len(curParas),
				Context:      prevTail,
			})
			globalIdx++
			prevTail = tailChars(text, ContextTailChars)
			curParas = nil
			curTok = 0
		}

		for _, para := range ch.Paragraphs {
			if strings.TrimSpace(para) == "" {
				continue
			}
			pt := estimate(para)
			// 加段落前先判断：加上它会不会显著超出目标？
			// 用「当前非空 且 加上后超过目标」作为切块条件，
			// 保证每块都尽量接近 6000 而不会被一个短段落提前截断。
			if len(curParas) > 0 && curTok+pt > TargetTokensPerChunk {
				flushChunk()
			}
			curParas = append(curParas, para)
			curTok += pt
			// 硬上限：单块不得无限增长（极端情况是一个超长段落本身）。
			if curTok >= MaxTokensPerChunk {
				flushChunk()
			}
		}
		flushChunk() // 章末收尾：块不跨章节边界
	}
	return chunks
}

// joinParagraphs 用两个换行拼接段落（保留段落边界供模型识别）。
func joinParagraphs(paras []string) string {
	return strings.Join(paras, "\n\n")
}

// tailChars 取字符串末尾 n 个字符（按 rune 计，避免把多字节字符截半）。
func tailChars(s string, n int) string {
	if n <= 0 || s == "" {
		return ""
	}
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[len(rs)-n:])
}

// roughTokenEstimate 是不依赖 ai 包的粗略估算（中文约 1.5 字/token）。
//
// 这里刻意不复用 ai.EstimateTokens：booktext 是底层包，被 worker 与 ai 双方使用，
// 反向依赖 ai 会造成循环引用。调用方传入真实估算函数即可获得精确值。
func roughTokenEstimate(s string) int {
	if s == "" {
		return 0
	}
	var cjk, other int
	for _, r := range s {
		if r >= 0x4E00 && r <= 0x9FFF {
			cjk++
		} else {
			other++
		}
	}
	n := int(float64(cjk)/1.5 + float64(other)/4.0 + 0.5)
	if n < 1 {
		return 1
	}
	return n
}
