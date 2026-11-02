package httpapi

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// ★ 契约门禁：api/openapi.yaml 里**不得有悬空 $ref**。
//
// 背景：书源相关的 schema 在本轮有增改（新增 SourceList、扩展 SourceItem 的
// license 枚举与 downloadUrl 说明）。契约文件是前后端的单一权威，
// 一个悬空 $ref 会让生成的前端类型直接崩掉，而且**不会**在 Go 侧报错 ——
// 所以必须有一个测试守住它。
//
// 这里刻意不引入 YAML 解析依赖：我们只需要把所有 $ref 抽出来，
// 检查每个指向的目标在文件里**确实被定义**。用正则足够，且不会因为
// YAML 解析库版本差异导致误报。
func TestOpenAPINoDanglingRefs(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "api", "openapi.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("openapi.yaml not found at %s: %v", path, err)
	}
	doc := string(b)

	// 1) 收集所有 $ref 目标
	refRe := regexp.MustCompile(`\$ref:\s*'?([^'"\s]+)'?`)
	refs := map[string]bool{}
	for _, m := range refRe.FindAllStringSubmatch(doc, -1) {
		refs[m[1]] = true
	}
	if len(refs) == 0 {
		t.Fatal("no $ref found in openapi.yaml — regex or file layout changed")
	}

	// 2) 收集所有已定义的 schema 名（components.schemas 下的二级键）
	//    形如 "    SourceItem:"（4 空格缩进，位于 components.schemas 段内）
	defRe := regexp.MustCompile(`(?m)^    ([A-Za-z][A-Za-z0-9_]*):\s*$`)
	defined := map[string]bool{}
	for _, m := range defRe.FindAllStringSubmatch(doc, -1) {
		defined[m[1]] = true
	}

	// 3) 逐个校验：只校验指向 components/schemas 的 ref（其它类型由别的规则保证）
	var dangling []string
	for ref := range refs {
		const prefix = "#/components/schemas/"
		if !strings.HasPrefix(ref, prefix) {
			continue
		}
		name := strings.TrimPrefix(ref, prefix)
		// 去掉可能的 JSON-pointer 尾段（例如 Foo/properties/bar）
		if i := strings.IndexByte(name, '/'); i >= 0 {
			name = name[:i]
		}
		if !defined[name] {
			dangling = append(dangling, ref)
		}
	}
	if len(dangling) > 0 {
		sort.Strings(dangling)
		t.Fatalf("dangling $ref(s) in api/openapi.yaml: %v", dangling)
	}

	// 4) 顺带断言本轮新增的契约元素确实在
	for _, want := range []string{"SourceList:", "/v1/sources:"} {
		if !strings.Contains(doc, want) {
			t.Fatalf("openapi.yaml missing expected entry %q (task-21 contract change)", want)
		}
	}
}

// SourceItem 的 license 枚举必须与 Go 侧实际产生的值一致。
//
// 这是"文档说的一套、代码做的一套"的典型漂移点：如果代码里出现了
// 枚举外的 license，前端会拿到未声明的值。
func TestSourceItemLicenseEnumMatchesCode(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "api", "openapi.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("openapi.yaml not found: %v", err)
	}
	doc := string(b)

	m := regexp.MustCompile(`(?m)^        license:\s*\n(?:.*\n)*?          enum: \[([^\]]+)\]`).FindStringSubmatch(doc)
	if m == nil {
		t.Fatal("could not locate license enum in SourceItem")
	}
	declared := map[string]bool{}
	for _, v := range strings.Split(m[1], ",") {
		declared[strings.TrimSpace(v)] = true
	}

	// 代码侧实际会用到的值（与 internal/sources 保持一致）
	for _, want := range []string{"public-domain", "open-access", "mixed-open-access"} {
		if !declared[want] {
			t.Fatalf("license %q used by code but not declared in openapi enum (declared: %v)", want, m[1])
		}
	}
}
