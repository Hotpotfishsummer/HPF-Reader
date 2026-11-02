#!/usr/bin/env node
/**
 * 生成内置示例 EPUB（public/sample/sample.epub）。
 *
 * 为什么要自造而不用真实书：M1 验收要"能渲染一本真实 EPUB"，同时不能把版权书籍
 * 塞进仓库。这里用最小 ZIP writer 生成一本结构完整的 EPUB 3（含外部样式表，
 * 用来验证 L2 的"blob: 样式表内联"路径）。
 *
 * 用法: corepack pnpm run make:sample
 *
 * ZIP 说明：EPUB 规范要求第一个条目是**未压缩**的 `mimetype`，
 * 其余条目按惯例也可以直接 store（不压缩），所以这里不引入任何压缩库。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, '../public/sample/sample.epub')

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------------- 最小 ZIP writer（store 模式） ---------------- */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 name flag
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date (1980-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    chunks.push(local, nameBytes, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, eocd])
}

/* ---------------- EPUB 内容 ---------------- */
const XHTML = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    <h1>${title}</h1>
${body}
  </body>
</html>
`

const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head><meta charset="utf-8" /><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
        <li><a href="chapter1.xhtml">第一章 · 客户端骨架</a></li>
        <li><a href="chapter2.xhtml">第二章 · 内容隔离</a></li>
        <li><a href="chapter3.xhtml">第三章 · 排版与主题</a></li>
      </ol>
    </nav>
  </body>
</html>
`

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:hpf-reader-sample-0001</dc:identifier>
    <dc:title>HPF Reader 示例书</dc:title>
    <dc:creator>HPF-Reader 团队</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-02T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="css" href="styles.css" media-type="text/css" />
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml" />
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml" />
    <item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="c1" />
    <itemref idref="c2" />
    <itemref idref="c3" />
  </spine>
</package>
`

const styles = `/* 外部样式表：用来验证 L2 会把 blob: 样式表内联成 <style>，保住排版又不放宽 CSP。 */
body { font-family: "Noto Serif CJK SC", serif; line-height: 1.7; margin: 5%; }
h1 { font-size: 1.5em; margin-bottom: 1.2em; }
p { text-indent: 2em; margin: 0.6em 0; }
blockquote { border-inline-start: 3px solid #999; padding-inline-start: 0.8em; color: #555; }
`

const para = (text) => `    <p>${text}</p>`

const chapter1 = XHTML(
  '第一章 · 客户端骨架',
  [
    para('这是 HPF Reader 的内置示例书，用来验证 foliate-js 在这个外壳里能完成分页、翻页、目录与进度上报。'),
    para('客户端由三层组成：Wails v3 的 Go 外壳负责本地文件与原生能力；Vue 3 负责界面与状态；foliate-js 负责 EPUB 的解析与排版。'),
    para('所有第三方内容都必须经过 L2 净化：剥离脚本、事件属性与远程引用，并逐节注入 meta CSP。'),
  ].join('\n'),
)

const chapter2 = XHTML(
  '第二章 · 内容隔离',
  [
    para('Arch-A（opaque 内容帧）已被判定不可行：foliate-js 需要拿到 iframe 的 contentDocument 才能分页与定位。'),
    para('因此主力防线是 L2：同源 iframe + 逐节净化 + script-src \'none\' 的 CSP。'),
    para('净化模块见 src/reader/sanitize.ts，它的单测覆盖内联脚本、onerror、javascript: 链接、远程图片、iframe 与 CSS 外链。'),
  ].join('\n'),
)

const chapter3 = XHTML(
  '第三章 · 排版与主题',
  [
    para('主题切换需要双写：主文档改 CSS 变量，同时通过 renderer.setStyles 把样式写进章节文档。'),
    para('否则会出现「主题只换了一半」—— 界面变了，正文没变。'),
    para('墨水屏模式会关闭混合模式并降低高亮不透明度，保证在 e-ink 上的对比度。'),
  ].join('\n'),
)

const files = [
  { name: 'mimetype', data: 'application/epub+zip' },
  {
    name: 'META-INF/container.xml',
    data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`,
  },
  { name: 'OEBPS/content.opf', data: opf },
  { name: 'OEBPS/nav.xhtml', data: nav },
  { name: 'OEBPS/styles.css', data: styles },
  { name: 'OEBPS/chapter1.xhtml', data: chapter1 },
  { name: 'OEBPS/chapter2.xhtml', data: chapter2 },
  { name: 'OEBPS/chapter3.xhtml', data: chapter3 },
]

mkdirSync(dirname(outPath), { recursive: true })
const zip = buildZip(files)
writeFileSync(outPath, zip)
console.log(`[make-sample-epub] 已生成 ${outPath} (${zip.length} bytes, ${files.length} entries)`)
