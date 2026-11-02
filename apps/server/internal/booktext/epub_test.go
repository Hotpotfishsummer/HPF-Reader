package booktext

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// buildEPUB 构造一个最小可用的 EPUB，用于测试抽取器。
//
// 刻意**不**按文件名顺序排列章节（ch10 的文件名排在 ch2 前面），
// 用来证明抽取器走的是 OPF spine 而不是文件名排序。
func buildEPUB(t *testing.T, chapters []struct{ Href, Title, Body string }) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}

	add("mimetype", "application/epub+zip")
	add("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)

	var items, refs strings.Builder
	for i, c := range chapters {
		add("OEBPS/"+c.Href, `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>`+c.Title+`</title>
<style>p{color:red}</style></head><body>`+c.Body+`</body></html>`)
		id := "c" + string(rune('0'+i))
		items.WriteString(`<item id="` + id + `" href="` + c.Href + `" media-type="application/xhtml+xml"/>`)
		refs.WriteString(`<itemref idref="` + id + `"/>`)
	}
	add("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/>
<manifest>`+items.String()+`</manifest><spine>`+refs.String()+`</spine></package>`)

	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

// TestExtractEPUBFollowsSpineOrder 证明章节顺序来自 spine，而不是文件名。
func TestExtractEPUBFollowsSpineOrder(t *testing.T) {
	data := buildEPUB(t, []struct{ Href, Title, Body string }{
		{"ch10.xhtml", "第一章", "<p>第一段。</p><p>第二段。</p>"},
		{"ch2.xhtml", "第二章", "<p>第三章的内容。</p>"},
	})
	chapters, err := ExtractEPUB(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if len(chapters) != 2 {
		t.Fatalf("chapters = %d, want 2", len(chapters))
	}
	// 若按文件名排序，ch10 会排在 ch2 前面 → 顺序错乱。
	if chapters[0].Href != "OEBPS/ch10.xhtml" {
		t.Fatalf("first chapter href = %q, want ch10（spine 顺序）", chapters[0].Href)
	}
	if got := len(chapters[0].Paragraphs); got != 2 {
		t.Fatalf("first chapter paragraphs = %d, want 2", got)
	}
	if chapters[0].Title != "第一章" {
		t.Fatalf("title = %q, want 第一章", chapters[0].Title)
	}
}

// TestExtractEPUBSkipsStyleAndScript 证明 CSS/JS 不会被当成正文送去翻译。
// 这是真实存在的坑：把整份 CSS 送去翻译既花钱又会污染译文。
func TestExtractEPUBSkipsStyleAndScript(t *testing.T) {
	data := buildEPUB(t, []struct{ Href, Title, Body string }{
		{"c1.xhtml", "T", "<style>p{font-size:12px}</style><script>var x=1;</script><p>真正的正文。</p>"},
	})
	chapters, err := ExtractEPUB(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	text := chapters[0].Text()
	for _, bad := range []string{"font-size", "var x"} {
		if strings.Contains(text, bad) {
			t.Fatalf("正文里混入了样式/脚本 %q: %q", bad, text)
		}
	}
	if !strings.Contains(text, "真正的正文。") {
		t.Fatalf("正文丢失: %q", text)
	}
}
