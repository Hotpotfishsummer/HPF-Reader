// Package normalize 把人物/术语的多种写法归一到稳定的 key。
//
// 这是人名归一化的地基：同一人物在不同上下文被算成不同 key，整个归一化就废了。
// 因此这里全部是**纯函数**——无 I/O、无全局可变状态、无随机，可被穷举单测。
//
// 设计依据见 docs/research/80-entity-normalization.md §A7/§3.3 与
// docs/M5-PLAN-APPENDIX.md §11.5。
package normalize

import (
	"strings"
	"sync"
	"unicode"

	"github.com/longbridgeapp/opencc"
	"github.com/mozillazg/go-pinyin"
)

// Key 是一个写法的全部归一化形态。
//
// 分多个字段而不是单个字符串，是因为它们**证据强度不同**，
// 聚类时必须区别对待（见 Cluster）：
//   - NormKey 精确相等 = 同一人（确定性）
//   - PinyinKey 精确相等 = 同音异形，**但必须先排除空 key**
//   - 只有相似度 = 弱信号，只能标「疑似」
type Key struct {
	// Form 是原始写法，保留给展示与日志。
	Form string
	// Simplified 是繁转简后的写法。
	Simplified string
	// NormKey 是最终归一 key：转简→去变音符→去尊称→去标点→小写→压缩空白。
	NormKey string
	// PinyinKey 是无声调拼音串，例如 "yilishabai"。
	// **非中文写法会是空串**（拼音库对 ASCII 无输出）。调用方必须判空。
	PinyinKey string
}

// honorifics 是需要剥离的英文尊称前缀。
var honorifics = []string{
	"mr", "mrs", "ms", "miss", "mister", "madam", "madame", "sir", "lady",
	"lord", "duke", "duchess", "count", "countess", "baron", "baroness",
	"dr", "doctor", "prof", "professor", "capt", "captain", "col", "colonel",
	"gen", "general", "major", "lt", "lieutenant", "sgt", "sergeant",
	"rev", "reverend", "father", "mother", "brother", "sister",
	"king", "queen", "prince", "princess", "uncle", "aunt", "auntie", "cousin",
}

// honorificSuffixes 是中文里跟在名字后面的称谓。
//
// 例：「达西先生」剥成「达西」，否则「达西」和「达西先生」会是两个 key。
var honorificSuffixes = []string{
	"先生", "女士", "小姐", "太太", "夫人", "少爷", "老爷", "公子",
	"大人", "阁下", "殿下", "陛下", "教授", "博士", "医生", "老师",
	"上校", "将军", "船长", "爵士", "神父", "修女", "国王", "女王", "王子", "公主",
}

var (
	t2sOnce sync.Once
	t2sConv *opencc.OpenCC
	t2sErr  error
)

// traditionalToSimplified 把繁体转为简体。
//
// 词典 embed 进二进制（无外部文件依赖），首次调用初始化后复用。
// 初始化失败不 panic：归一化是增强功能，失败时退化为「不转简」，
// 不能让一个可选依赖把整个翻译流程搞挂。
func traditionalToSimplified(s string) string {
	t2sOnce.Do(func() {
		t2sConv, t2sErr = opencc.New("t2s")
	})
	if t2sErr != nil || t2sConv == nil {
		return s
	}
	out, err := t2sConv.Convert(s)
	if err != nil {
		return s
	}
	return out
}

// StripHonorific 去掉尊称前缀/后缀。导出是为了让单测直接断言这一层。
func StripHonorific(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// 后缀（中文）：循环剥离，「达西先生阁下」这类叠加也能处理。
	for {
		changed := false
		for _, suf := range honorificSuffixes {
			if strings.HasSuffix(s, suf) && len(s) > len(suf) {
				s = strings.TrimSpace(strings.TrimSuffix(s, suf))
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	// 前缀（英文）：按空白 token 剥，且只剥到还剩至少一个 token。
	for {
		fields := strings.Fields(s)
		if len(fields) <= 1 {
			break
		}
		first := strings.ToLower(strings.Trim(fields[0], ".,;:"))
		if !isHonorific(first) {
			break
		}
		s = strings.Join(fields[1:], " ")
	}
	return strings.TrimSpace(s)
}

func isHonorific(tok string) bool {
	for _, h := range honorifics {
		if tok == h {
			return true
		}
	}
	return false
}

// stripDiacritics 去掉拉丁字母的变音符号（é→e, ü→u）。
//
// 中文没有变音符号，这一步对中文是恒等变换。
func stripDiacritics(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if mapped, ok := diacriticMap[r]; ok {
			b.WriteRune(mapped)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

var diacriticMap = map[rune]rune{
	'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
	'ā': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'ē': 'e',
	'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'ī': 'i', 'ó': 'o',
	'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ō': 'o', 'ø': 'o',
	'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ū': 'u', 'ý': 'y',
	'ÿ': 'y', 'ç': 'c', 'ñ': 'n', 'ß': 's', 'Á': 'a', 'À': 'a',
	'Â': 'a', 'Ä': 'a', 'Ã': 'a', 'Å': 'a', 'Ā': 'a', 'É': 'e',
	'È': 'e', 'Ê': 'e', 'Ë': 'e', 'Ē': 'e', 'Í': 'i', 'Ì': 'i',
	'Î': 'i', 'Ï': 'i', 'Ī': 'i', 'Ó': 'o', 'Ò': 'o', 'Ô': 'o',
	'Ö': 'o', 'Õ': 'o', 'Ō': 'o', 'Ø': 'o', 'Ú': 'u', 'Ù': 'u',
	'Û': 'u', 'Ü': 'u', 'Ū': 'u', 'Ý': 'y', 'Ç': 'c', 'Ñ': 'n',
}

// Normalize 计算一个写法的全部归一化形态。
//
// 顺序**不能乱**：
//  1. 先转简（跨繁体/简体版本的书能归一到同一实体）
//  2. 去变音符（英文名 é/ü）
//  3. 去尊称（Mr. Darcy → Darcy）
//  4. 去标点 + 小写 + 压缩空白
//  5. 最后算拼音（必须基于已清理的串，否则标点会污染拼音输出）
func Normalize(form string) Key {
	k := Key{Form: form}
	s := strings.TrimSpace(form)
	if s == "" {
		return k
	}
	s = traditionalToSimplified(s)
	k.Simplified = s
	s = stripDiacritics(s)
	s = StripHonorific(s)
	s = stripPunct(s)
	s = collapseSpace(strings.ToLower(s))
	k.NormKey = s
	k.PinyinKey = pinyinKey(s)
	return k
}

// stripPunct 去掉标点与符号，但**保留汉字、字母、数字、空白**。
//
// 用 unicode.IsPunct/IsSymbol 而不是白名单：OCR 出来的名字常带奇怪符号，
// 白名单会把它们留在 key 里，导致同一人被算成两个。
func stripPunct(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsPunct(r) || unicode.IsSymbol(r) {
			// 连字符/间隔号换成空格而不是删掉：
			// 「O'Hara」删掉变「ohara」，加空格变「o hara」，后者更接近真实分词。
			if r == '-' || r == '\u00b7' || r == '\u2027' || r == '\u30fb' {
				b.WriteRune(' ')
			}
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// collapseSpace 把连续空白压成单个空格。
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// pinyinKey 生成无声调拼音串。
//
// **非中文返回空串**——这是刻意保留的语义，调用方必须判空：
// 英文人名、数字、纯符号的拼音都是 ""，若把「拼音相等」无条件当强信号，
// 任意两个英文名都会被判为同音而错误合并。
func pinyinKey(s string) string {
	if s == "" || !hasHan(s) {
		return ""
	}
	a := pinyin.NewArgs()
	a.Fallback = func(r rune, a pinyin.Args) []string { return nil }
	rows := pinyin.Pinyin(s, a)
	var b strings.Builder
	for _, r := range rows {
		if len(r) > 0 {
			b.WriteString(r[0])
		}
	}
	return b.String()
}

// hasHan 判断串里是否含汉字。
func hasHan(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// HasHan 供聚类逻辑判断是否能用拼音做证据。
func HasHan(s string) bool { return hasHan(s) }
