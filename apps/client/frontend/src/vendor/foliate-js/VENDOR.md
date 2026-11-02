# foliate-js（vendored，固定 commit）

## 为什么 vendor 而不是装 npm 包

npm 上的 `foliate-js` 是**第三方冒名包**，不是上游作者的仓库（见 docs/research/50-vue3-reader-stack.md §2.1 / §5.7）。
上游 README 自己就写着「Expect it to break and the API to change at any time. Use it at your own risk.」
并建议以 git submodule 方式引入。因此这里直接把上游源码拷进仓库并固定 commit。

## 固定版本

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/johnfactotum/foliate-js |
| **commit** | **`78914aef4466eb960965702401634c2cb348e9b1`** |
| commit 标题 | Use original hrefs for external links and add isExternal in fb2.js (#129) |
| commit 时间 | 2026-05-01 19:24:25 +0000 |
| 获取方式 | `git clone --depth 1` 后删除 `.git`（本目录已无 git 元数据） |
| 许可 | MIT（见同目录 `LICENSE`） |

## 怎么补/怎么升级

```powershell
# 重新拉取（升级时用；注意先确认新 commit 的 API 变化）
cd apps/client/frontend/src/vendor
Remove-Item -Recurse -Force foliate-js
git clone --depth 1 https://github.com/johnfactotum/foliate-js foliate-js
cd foliate-js
git rev-parse HEAD          # ← 把这个值更新到上面的表格
Remove-Item -Recurse -Force .git
```

## 我们依赖的上游事实（改动时要重新核对）

| 事实 | 位置 | 我们怎么用 |
|---|---|---|
| `foliate-view` 是 custom element，closed shadow root | `view.js` `#root = this.attachShadow({mode:'closed'})` | 实例绝不进 ref/reactive；样式只能靠 `::part()` |
| 章节文档只能通过 `#iframe.contentDocument` 拿到 | `paginator.js` | 这是 Arch-A（opaque 帧）判死的原因（ADR-003 §9.1） |
| **不注入任何脚本** | `paginator.js` 全文无 `<script>` | L2 的 `script-src 'none'` 不会破坏分页（ADR-003 §9.2） |
| `transformTarget` 的 `data` 事件是唯一早于解析的变换点 | `epub.js` `Loader.createURL` | L2 净化的接入点，见 `src/reader/sanitize.ts` |
| `renderer.setStyles(string \| [before, style])` | `paginator.js` `setStyles` | 主题双写的第二节 |
| 高亮外观走 `--overlayer-highlight-opacity` / `-blend-mode` | `overlayer.js` | 主题变量里已定义 |

## 已知的 Vite 兼容问题（未打补丁，目前不影响）

构建时会打印：

```
[plugin builtin:vite-import-glob] Invalid glob pattern: `vendor/pdfjs/*` in file 'src/vendor/foliate-js/pdf.js'
```

这是 `pdf.js` 里 `import.meta.glob('vendor/pdfjs/*')` 的写法不满足 Vite 8 的 glob 规则。
**只影响 PDF 的 cmaps/standard_fonts 预加载，不影响 EPUB**（本里程碑只验 EPUB），
所以没有改上游源码。接入 PDF 时按 `jinhuan138/vue-book-reader` 的 `scripts/fix-foliate.mjs`
打两个补丁（`?inline` CSS + 字符串守卫）再处理这条 glob。

## 已删除/未纳入的内容

- `.git`（已删除，避免和主仓库的 git 索引冲突）
- `vendor/pdfjs/*.map`（source map，约 7.6 MB）**保留**，但注意它们会让仓库体积明显变大；
  如果之后要瘦身，删掉 `*.map` 是安全的（不影响运行）。
- `node_modules` 相关的构建产物（上游无构建步骤，源码即产物）。
