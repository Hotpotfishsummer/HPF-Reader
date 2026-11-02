package ai

// Token 计数与成本估算。
//
// 核心原则（来自规划 §2.3）：**不要假装精确**。
// OpenAI 兼容协议的流式响应默认不回 usage，上游是否回 usage 取决于：
//   * 请求体是否带 stream_options.include_usage（OpenAI / DeepSeek 支持，Ollama 不支持）；
//   * 上游实现是否真的遵守。
// 因此每条记账都要标 usage_source：upstream（真实）或 estimated（本地粗估）。
// 两者在成本分析里可信度完全不同，混在一起会让「按 usage 计费」的结论站不住脚。

// Usage 是一次调用的 token 用量与来源。
type Usage struct {
	InputTokens  int
	OutputTokens int
	// Source 取值 upstream | estimated。
	Source string
}

// 用量来源常量。
const (
	UsageSourceUpstream  = "upstream"
	UsageSourceEstimated = "estimated"
)

// EstimateTokens 在拿不到上游 usage 时做本地粗估。
//
// 估算口径（经验值，非精确）：
//   - 中日韩等表意文字：约 1.5 字/token（DeepSeek 对中文的分词密度大致如此）；
//   - 拉丁字母等：约 4 字符/token（这是业界对英文的通用经验值）。
//
// 混合文本按两类字符占比分别折算后相加，比「一刀切按字符数/4」更贴近中文场景。
//
// ⚠️ 这个数字**只用于记账与配额预扣**，不能用于计费仲裁——
// 真实账单必须以上游 usage 为准（见 docs/M5-PLAN.md §8 的核实要求）。
func EstimateTokens(s string) int {
	if s == "" {
		return 0
	}
	var cjk, other int
	for _, r := range s {
		if isCJK(r) {
			cjk++
		} else {
			other++
		}
	}
	// 中文 1.5 字/token → 每字约 0.667 token；英文 4 字符/token → 每字符 0.25 token。
	est := float64(cjk)/1.5 + float64(other)/4.0
	if est < 1 {
		// 非空文本至少算 1 token：0 会让「按 token 计费」的额度永远用不完。
		return 1
	}
	return int(est + 0.5) // 四舍五入
}

// isCJK 判断是否为表意文字（中日韩统一表意文字 + 假名 + 谚文）。
func isCJK(r rune) bool {
	switch {
	case r >= 0x4E00 && r <= 0x9FFF: // CJK 统一表意文字
		return true
	case r >= 0x3400 && r <= 0x4DBF: // 扩展 A
		return true
	case r >= 0x3040 && r <= 0x30FF: // 平假名 + 片假名
		return true
	case r >= 0xAC00 && r <= 0xD7AF: // 谚文音节
		return true
	case r >= 0xF900 && r <= 0xFAFF: // 兼容表意文字
		return true
	case r >= 0xFF00 && r <= 0xFFEF: // 全角标点
		return true
	}
	return false
}

// EstimateRequestTokens 估算一次翻译请求的输入 token（含 system prompt 与上下文）。
//
// 直接拿 BuildMessages 的实际内容估算，而不是只估正文：
// 术语表可能很大（整书几百条），漏算会让预扣严重偏低，闸门就形同虚设。
func EstimateRequestTokens(req TranslateRequest) int {
	total := 0
	for _, m := range BuildMessages(req) {
		total += EstimateTokens(m.Content)
	}
	return total
}

// TokenPrice 是按「人民币分/百万 token」计的单价。
//
// 数值取自 DeepSeek 官方价目（2026-11-03 抓取，见 docs/M5-PLAN.md §8.1）的**空闲档**：
//
//	输入（缓存未命中）1 元/百万 token = 100 分/百万；
//	输出 4 元/百万 token = 400 分/百万。
//
// 取空闲档而不是高峰档，是因为成本记账要保守估低值？——不，恰恰相反：
// 记账用的是「实际发生」的量，而 cost_cents 只作为量级参考。真正的账单以供应商为准。
// 若要按高峰计价，改这两个常量即可，调用方无需改动。
type TokenPrice struct {
	InputCentsPerMillion  int64
	OutputCentsPerMillion int64
}

// DefaultTokenPrice 是 deepseek-flash 空闲时段单价。
var DefaultTokenPrice = TokenPrice{InputCentsPerMillion: 100, OutputCentsPerMillion: 400}

// CostCents 按单价折算成本（单位：分）。
//
// 用「分」而不是「元」：整型避免浮点累积误差，且与 ai_usage.cost_cents 列一致。
// 单次划词翻译的成本通常不足 1 分，会被向下取整成 0——这是刻意的：
// 记账粒度到分已经够用，强行引入小数分只会让汇总时更难对齐。
func (p TokenPrice) CostCents(inputTokens, outputTokens int) int {
	in := int64(inputTokens) * p.InputCentsPerMillion / 1_000_000
	out := int64(outputTokens) * p.OutputCentsPerMillion / 1_000_000
	return int(in + out)
}
