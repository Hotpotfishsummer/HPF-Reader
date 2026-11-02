package httpapi

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ★ 契约门禁 2：api/openapi.yaml 必须是**结构合法**的 YAML，不能有重复映射键。
//
// 为什么需要这个测试（真实事故，不是假想）：
//
//	`TestOpenAPINoDanglingRefs` 刻意不用 YAML 解析库（只用正则查 $ref 目标），
//	所以它**结构上不可能**发现「重复 mapping key」这类错误。
//	结果是：openapi.yaml 里曾有一个无名的孤儿块（缩进 6 空格，紧跟在
//	`GlossaryPutRequest.properties.removeKeys` 之后），被解析器当成
//	`GlossaryPutRequest` 下的**第二个 type:/required:/properties:**。
//
//	后果：
//	  - Go 侧全部测试绿（Go 的 yaml 解析对重复键宽容，后者覆盖前者）；
//	  - 前端 `pnpm run api:types` 直接崩：
//	      duplicated mapping key in "openapi.yaml" (635:7)
//	前端拿不到生成类型，整个类型契约链断掉。
//
// 实现方式：**零依赖**的缩进栈。
//
//	作用域由「父路径 + 该层缩进」唯一确定；同一作用域内同名键即重复。
//	不做完整 YAML 解析（那要引依赖），但足以抓住「编辑时误删 schema 名 / 块错位」。
//
//	刻意不试图理解 YAML 全部语法：只处理 `key:` 形式。
//	列表项、流式映射、带引号的键都跳过——它们不是本测试要抓的目标，
//	强行解析反而会制造误报（第一版就是因为路径栈写错而大量误报，已重写）。
func TestOpenAPIHasNoDuplicateMappingKeys(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "api", "openapi.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("openapi.yaml not found at %s: %v", path, err)
	}

	type frame struct {
		indent int    // 该层键的缩进
		path   string // 该层键的完整路径（用于报错定位）
	}
	var stack []frame

	// 作用域 = 父路径 + 该层缩进（+ 列表项序号）；keysByScope[scope][key] = 首次出现行号。
	keysByScope := map[string]map[string]int{}
	// 列表项作用域：YAML 数组的每个元素是独立命名空间。
	listScopeCounter := 0
	curListScope := ""

	for i, raw := range strings.Split(string(b), "\n") {
		lineNo := i + 1
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimLeft(line, " ")
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(trimmed)

		colon := strings.Index(trimmed, ":")
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:colon])
		// 列表项（`- url: ...` / `- { name: bookId, ... }`）：
		// **每一项是独立作用域**，同名键在兄弟项里出现不是重复。
		//
		// 例如 servers: 下两个元素都写 description，这是合法的 YAML。
		// 若不当成新作用域，会误报（第三版就栽在这）。
		// 做法：遇到列表项时，把该缩进层的作用域换成一个新的唯一标识。
		if strings.HasPrefix(trimmed, "-") {
			listScopeCounter++
			curListScope = fmt.Sprintf("item#%d", listScopeCounter)
			continue
		}
		// 去掉键两侧的引号，**但保留带引号的键本身**。
		//
		// 这一点是必须的：HTTP 状态码在 YAML 里通常写成 '200' / '400' / '502'，
		// 它们是真真正正的映射键，是 description/content 的父层。
		// 第一版把这些键整个跳过，导致 '200'/'400'/'502' 三个响应的
		// description/content 被误判成同一作用域内的重复键——大量误报。
		key = strings.Trim(key, "'\"")
		// 只跳过**真正的流式映射/锚点/别名**：这些 key 后面跟着 `{` 或 `&` 或 `*`。
		//
		// 注意不能按「key 里含 {}」来过滤：路径键 `/v1/books/{bookId}` 含 {}，
		// 但它是最正经的映射键（get/post 的父层）。第二版就是按 {} 过滤路径键，
		// 导致同一路径下的 get 被误判成重复。
		rest := strings.TrimSpace(trimmed[colon+1:])
		if strings.HasPrefix(rest, "{") || strings.HasPrefix(rest, "&") || strings.HasPrefix(rest, "*") {
			// 流式映射的值不展开为子结构，但该键本身仍是合法映射键，需登记。
		}
		if key == "" || strings.Contains(key, " ") {
			continue
		}

		// 回退：弹出所有缩进 >= 当前行的层，使栈顶成为真正的父层。
		for len(stack) > 0 && stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		parentPath := "<root>"
		if len(stack) > 0 {
			parentPath = stack[len(stack)-1].path
		}
		scope := fmt.Sprintf("%s|%d|%s", parentPath, indent, curListScope)
		if keysByScope[scope] == nil {
			keysByScope[scope] = map[string]int{}
		}
		if first, dup := keysByScope[scope][key]; dup {
			t.Errorf("重复映射键 %q 于 %s 下（缩进 %d）：首次第 %d 行，再次第 %d 行",
				key, parentPath, indent, first, lineNo)
			continue
		}
		keysByScope[scope][key] = lineNo

		// 该键成为后续更深缩进行的父路径。
		stack = append(stack, frame{indent: indent, path: parentPath + "/" + key})
	}
}
