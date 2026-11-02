// Package booktext 从书籍文件里抽取「章节 → 段落」结构，供后台翻译任务分块使用。
//
// 为什么自己写而不是引第三方 EPUB 库：
//  1. 我们只需要「按顺序取出各章的可见文本」，不需要渲染、不需要样式、不需要导航；
//  2. EPUB 的本质就是一个 zip + XHTML，标准库 archive/zip + encoding/xml 足够；
//  3. 少一个依赖就少一处供应链风险，而这一层的复杂度是可控的（见下）。
//
// 已知取舍：只支持 EPUB（zip 容器）。PDF/MOBI/AZW3 需要完全不同的解析栈，
// 本层对它们返回明确的 ErrUnsupportedFormat，而不是猜测或静默产出空文本。
package booktext

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
)

// ErrUnsupportedFormat 表示该格式本层不支持。
var ErrUnsupportedFormat = errors.New("booktext: unsupported format")

// ErrMalformed 表示文件看起来是 EPUB，但结构不合法。
var ErrMalformed = errors.New("booktext: malformed epub")

// Chapter 是一章的结构化文本。
type Chapter struct {
	// Index 是从 0 开始的章节序号（按阅读顺序）。
	Index int
	// Title 来自 EPUB 导航或 XHTML title，可能为空。
	Title string
	// Href 是章节文件在 EPUB 内的路径（用于日志与排错）。
	Href string
	// Paragraphs 是按文档顺序切出的段落。
	// **保留段落边界**是刻意设计：翻译分块必须在段落边界切开，
	// 切断句子会让模型「补全」缺失部分，产生幻觉。
	Paragraphs []string
}

// Text 返回该章拼接后的纯文本（段落间用两个换行分隔）。
func (c Chapter) Text() string { return strings.Join(c.Paragraphs, "\n\n") }

// ExtractEPUB 从 EPUB 字节中按阅读顺序抽取章节。
//
// 流程：读 META-INF/container.xml 找 OPF → 解析 OPF 的 spine（阅读顺序）→
// 逐个读 XHTML 抽段落。走 spine 而不是按文件名排序，是因为文件名顺序
// 与阅读顺序经常不一致（有些书是 ch10 排在 ch2 前面）。
func ExtractEPUB(r io.ReaderAt, size int64) ([]Chapter, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		// 不是 zip：可能是 PDF/TXT 等本层不支持的格式。
		return nil, fmt.Errorf("%w: not a zip container (%v)", ErrUnsupportedFormat, err)
	}
	opfPath, err := findOPFPath(zr)
	if err != nil {
		return nil, err
	}
	opf, err := readZipFile(zr, opfPath)
	if err != nil {
		return nil, err
	}
	doc, err := parseOPF(opf, path.Dir(opfPath))
	if err != nil {
		return nil, err
	}

	chapters := make([]Chapter, 0, len(doc.spine))
	for i, href := range doc.spine {
		raw, err := readZipFile(zr, href)
		if err != nil {
			// 单个章节文件缺失不应让整本书失败：记录为空章并继续，
			// 否则一个坏的 EPUB 会让用户完全无法翻译。
			chapters = append(chapters, Chapter{Index: i, Href: href})
			continue
		}
		paras, title := extractParagraphs(raw)
		chapters = append(chapters, Chapter{
			Index: i, Title: title, Href: href, Paragraphs: paras,
		})
	}
	return chapters, nil
}

// findOPFPath 从 META-INF/container.xml 读出 OPF 的相对路径。
func findOPFPath(zr *zip.Reader) (string, error) {
	raw, err := readZipFile(zr, "META-INF/container.xml")
	if err != nil {
		return "", fmt.Errorf("%w: missing META-INF/container.xml", ErrMalformed)
	}
	var c struct {
		Rootfiles []struct {
			FullPath string `xml:"full-path,attr"`
			Media    string `xml:"media-type,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if err := xml.Unmarshal(raw, &c); err != nil {
		return "", fmt.Errorf("%w: bad container.xml: %v", ErrMalformed, err)
	}
	for _, rf := range c.Rootfiles {
		if strings.Contains(rf.Media, "oebps-package") || rf.Media == "" {
			return strings.TrimPrefix(rf.FullPath, "/"), nil
		}
	}
	if len(c.Rootfiles) > 0 {
		return strings.TrimPrefix(c.Rootfiles[0].FullPath, "/"), nil
	}
	return "", fmt.Errorf("%w: no rootfile in container.xml", ErrMalformed)
}

// opfDoc 是解析后的 OPF 关键信息。
type opfDoc struct {
	spine []string // 章节文件在 zip 内的绝对路径，按阅读顺序
}

// parseOPF 解析 OPF，返回按 spine 顺序排列的章节路径。
func parseOPF(raw []byte, baseDir string) (opfDoc, error) {
	var pkg struct {
		Manifest []struct {
			ID   string `xml:"id,attr"`
			Href string `xml:"href,attr"`
		} `xml:"manifest>item"`
		Spine []struct {
			IDRef string `xml:"idref,attr"`
		} `xml:"spine>itemref"`
	}
	if err := xml.Unmarshal(raw, &pkg); err != nil {
		return opfDoc{}, fmt.Errorf("%w: bad OPF: %v", ErrMalformed, err)
	}
	byID := make(map[string]string, len(pkg.Manifest))
	for _, it := range pkg.Manifest {
		byID[it.ID] = resolveZipPath(baseDir, it.Href)
	}
	out := opfDoc{spine: make([]string, 0, len(pkg.Spine))}
	for _, ref := range pkg.Spine {
		if href, ok := byID[ref.IDRef]; ok {
			out.spine = append(out.spine, href)
		}
	}
	if len(out.spine) == 0 {
		// 没有 spine 的 EPUB 不合法；但为了让调用方拿到明确原因，这里报 ErrMalformed。
		return opfDoc{}, fmt.Errorf("%w: empty spine", ErrMalformed)
	}
	return out, nil
}

// resolveZipPath 把 OPF 内的相对 href 解析成 zip 内的绝对路径。
func resolveZipPath(baseDir, href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	// href 可能带 fragment（chapter.xhtml#part2），zip 内不存在这种路径。
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href = href[:i]
	}
	if baseDir == "" || baseDir == "." {
		return path.Clean(href)
	}
	return path.Clean(path.Join(baseDir, href))
}

// readZipFile 读取 zip 内的一个文件。
func readZipFile(zr *zip.Reader, name string) ([]byte, error) {
	name = strings.TrimPrefix(path.Clean(name), "/")
	for _, f := range zr.File {
		if strings.TrimPrefix(f.Name, "/") == name {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer func() { _ = rc.Close() }()
			// 单文件上限 16MiB：一本书的单个章节远小于此，超过必是异常文件。
			return io.ReadAll(io.LimitReader(rc, 16<<20))
		}
	}
	return nil, fmt.Errorf("booktext: %s not found in archive", name)
}

// blockTags 是「块级」标签集合：它们产生段落边界。
// 行内标签（span/a/b/i/em/strong）不切段——若按行内标签切，
// 一个带斜体的句子会被切成三段，翻译质量直接崩坏。
var blockTags = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "blockquote": true,
	"li": true, "tr": true, "h1": true, "h2": true, "h3": true, "h4": true,
	"h5": true, "h6": true, "pre": true, "dd": true, "dt": true, "figcaption": true,
}

// skipTags 是内容不是正文的标签：整棵子树都跳过。
// script/style 尤其重要：把 CSS 当成正文送去翻译既浪费钱又会污染译文。
var skipTags = map[string]bool{
	"script": true, "style": true, "head": true, "nav": true, "noscript": true,
}

// extractParagraphs 从 XHTML 抽段落与标题。
//
// 用一个手写的 token 扫描器而不是 xml.Decoder 的严格模式：
// 真实世界的 EPUB 里 XHTML 经常不合法（未闭合的 br/img、裸的 & 符号），
// 严格解析会让大量正常书籍失败。我们只需要「按块级标签切段」这一个行为，
// 容错比严格更重要。
func extractParagraphs(raw []byte) ([]string, string) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	// Strict=false 让解码器容忍未声明的实体与不合法结构。
	dec.Strict = false
	dec.CharsetReader = charsetReader

	var (
		paragraphs []string
		cur        strings.Builder
		title      string
		skipDepth  int
		inTitle    bool
		inBody     bool
		// seenBody 用于兼容不含 <body> 的片段文件。
		seenBody bool
	)

	flush := func() {
		s := collapseSpace(cur.String())
		cur.Reset()
		if s != "" {
			paragraphs = append(paragraphs, s)
		}
	}

	for {
		tok, err := dec.Token()
		if err != nil {
			break // io.EOF 或结构错误：已抽到的内容照样可用。
		}
		switch t := tok.(type) {
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			// <title> 必须**在** skipTags 判断之前处理：
			// 它位于 <head> 内部，而 head 是整棵跳过。若先判 skip，标题永远抓不到。
			if name == "title" {
				inTitle = true
				continue
			}
			if skipTags[name] {
				skipDepth++
				continue
			}
			if skipDepth > 0 {
				continue
			}
			switch name {
			case "body":
				inBody, seenBody = true, true
			default:
				if blockTags[name] {
					// 块级标签开始：先把已累积的内容收成一段，保证边界不被跨标签合并。
					flush()
				}
			}
		case xml.EndElement:
			name := strings.ToLower(t.Name.Local)
			if name == "title" {
				inTitle = false
				continue
			}
			if skipTags[name] {
				if skipDepth > 0 {
					skipDepth--
				}
				continue
			}
			if skipDepth > 0 {
				continue
			}
			switch name {
			case "body":
				inBody = false
			default:
				if blockTags[name] {
					flush()
				}
			}
		case xml.CharData:
			// inTitle 判断必须在 skipDepth 之前：
			// <title> 位于 <head> 内，此时 skipDepth > 0，
			// 若先判 skip 就永远收不到标题文本。
			if inTitle {
				title = collapseSpace(title + " " + string(t))
				continue
			}
			if skipDepth > 0 {
				continue
			}
			// 没有 body 的片段（少见但存在）也照常收文本。
			if !seenBody || inBody {
				cur.WriteString(string(t))
			}
		}
	}
	flush() // 收掉最后一段
	return paragraphs, strings.TrimSpace(title)
}

// collapseSpace 把连续空白压成单个空格并去掉首尾空白。
//
// XHTML 源码里换行与缩进是格式化用的，不是语义；不压平的话
// 每一段都会带着一堆无意义的空白送去翻译，白花钱且污染 token 计数。
func collapseSpace(s string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '\r', '\v', '\f', '\u00a0':
			space = true
		default:
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		}
	}
	return b.String()
}

// charsetReader 让 xml 解码器能处理非 UTF-8 声明。
// 老书常见 windows-1252 / iso-8859-1 声明，标准库默认会报错拒绝。
// 这里对未知字符集直接按字节透传（损失部分特殊字符，但不会让整本书失败）。
func charsetReader(charset string, input io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "", "utf-8", "utf8", "us-ascii", "ascii":
		return input, nil
	default:
		return input, nil
	}
}

// SortChapters 按 Index 排序（防御性：抽取顺序理论上已是正确的）。
func SortChapters(chs []Chapter) {
	sort.Slice(chs, func(i, j int) bool { return chs[i].Index < chs[j].Index })
}
