# 测试用公版电子书

用途：**真实排版**的验收素材。之前的 `sample.epub`（5.4KB 合成）测不出真实目录结构、CSS、图片与多章节分页，容易给出假阳性结论。

| 文件 | 大小 | 结构 | sha256（前 16 位） | 来源 |
|---|---|---|---|---|
| `pride-and-prejudice.epub` | 594.9 KB | 24 条目 / 17 HTML | `2172db6a64d45b02` | [Gutenberg #1342](https://www.gutenberg.org/ebooks/1342) |
| `alice-in-wonderland.epub` | 133.6 KB | 21 条目 / 14 HTML / 1 图 | `08a2de3a58226311` | [Gutenberg #11](https://www.gutenberg.org/ebooks/11) |
| `frankenstein.epub` | 287.3 KB | 38 条目 / 31 HTML | `bf04d57cf243314a` | [Gutenberg #84](https://www.gutenberg.org/ebooks/84) |

下载地址形如 `https://www.gutenberg.org/cache/epub/<id>/pg<id>.epub`，抓取日期 2026-11-03。

除上面三本真书，本目录还有两本**自造**的压力书（用于排版性能判别，不入产品分发）：

| 文件 | 形态 | 生成方式 |
|---|---|---|
| `large-book.epub` | 20 章 × 120 段 + 120 张内联 SVG | `node tests/tools/make-large-epub.mjs` |
| `single-chapter-large.epub` | 1 章 4000 段（≈48 万字）+ 400 张内联 SVG | `node tests/tools/make-single-chapter-epub.mjs` |

两本都可随时重生成；生成器在 [`tests/tools/`](../../tools/)（零依赖，`node:zlib` 手写 ZIP）。

## 许可

三本均为**公有领域**作品（作者逝世逾 70 年）。Project Gutenberg 对其电子文本的许可条款允许在美国境内自由复制与分发，并要求在再分发时保留 Gutenberg 头信息——**本目录只做本地测试用，不随产品分发**。

## 为什么选这三个

| 书 | 它测什么 |
|---|---|
| Alice | 章节多、篇幅小，适合快速回归；带插图，能测 `img-src data: blob:` 的 CSP 是否放行图片 |
| Frankenstein | 31 个 HTML、38 个 zip 条目 → **接近真实书的结构复杂度**，能暴露「大书打开慢/内存涨」类问题 |
| Pride and Prejudice | 17 章、近 600KB → 测分页性能与进度持久化在长书上的表现 |

## 用法

```powershell
# 客户端：把书拖进书库，或直接指向路径
# 服务端冒烟：上传时用 contentHash 去重，同一文件二次上传应命中已有记录
curl -X PUT http://127.0.0.1:8080/v1/books/<bookId>/file \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/epub+zip" \
  --data-binary @tests/fixtures/books/alice-in-wonderland.epub
```

> 新增素材时请一并更新本表（含 sha256 前 16 位），因为服务端按内容寻址去重，哈希是测试断言的一部分。
