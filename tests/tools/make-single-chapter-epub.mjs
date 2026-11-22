#!/usr/bin/env node
/**
 * 生成一本"单章超长"的 EPUB，用于排版性能判别实验。
 *
 * 背景：用户反馈"排版花十几/数十秒"。已排除：初排（小书/大书多章节）、
 * 状态栏切换、窗口缩放、章节数（foliate-js 惰性加载）。
 * 下一个最可能的根因是**单章节内容过大**：网文 epub 常把数万字 + 大量图片
 * 塞进少数章节。单章的 DOMParser 解析 → L2 净化遍历 → setImageSize 逐图
 * getComputedStyle → columnize 布局，成本随单章元素数放大。
 *
 * 本脚本生成 1 章，4000 段（每段约 120 字 ≈ 48 万字），400 张内联 SVG 图，
 * 用来验证"单章元素数"是否是排版耗时的放大因子。
 *
 * 用法（仓库根）: node tests/tools/make-single-chapter-epub.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, '../fixtures/books/single-chapter-large.epub')

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

/* ---------------- ZIP writer（deflate） ---------------- */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const comp = deflateRawSync(raw)
    const useStore = comp.length >= raw.length
    const data = useStore ? raw : comp
    const method = useStore ? 0 : 8
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
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

const SENTENCE = '这是一段用于单章超大性能判别实验的正文内容，考察阅读器在处理单章节元素数量极大时的解析净化与排版开销。'
const para = (n) => `    <p>${SENTENCE.repeat(n)}</p>`
const svg = (i) => `    <p><svg width="200" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="120" fill="hsl(${(i * 37) % 360},60%,70%)" /><text x="10" y="65" font-size="16" fill="#333">图 ${i}</text></svg></p>`

const PARAS = 4000
const IMAGES = 400

const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head><meta charset="utf-8" /><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
        <li><a href="chapter1.xhtml">唯一章节 · 单章超大判别</a></li>
      </ol>
    </nav>
  </body>
</html>
`

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:hpf-reader-single-large-0001</dc:identifier>
    <dc:title>HPF Reader 单章超大判别</dc:title>
    <dc:creator>HPF-Reader 团队</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-02T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="css" href="styles.css" media-type="text/css" />
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml" />
  </manifest>
  <spine>
    <itemref idref="c1" />
  </spine>
</package>
`

const styles = `body { font-family: "Noto Serif CJK SC", serif; line-height: 1.7; margin: 5%; }
h1 { font-size: 1.5em; margin-bottom: 1.2em; }
p { text-indent: 2em; margin: 0.6em 0; }
svg { display: block; margin: 1em auto; }
`

const paras = []
for (let p = 0; p < PARAS; p += 1) paras.push(para(2))
for (let im = 0; im < IMAGES; im += 1) paras.push(svg(im))

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
  { name: 'OEBPS/chapter1.xhtml', data: XHTML('唯一章节 · 单章超大判别', paras.join('\n')) },
]

mkdirSync(dirname(outPath), { recursive: true })
const zip = buildZip(files)
writeFileSync(outPath, zip)
console.log(`[make-single-chapter-epub] 已生成 ${outPath}`)
console.log(`  章节 1，段落 ${PARAS}，图片 ${IMAGES}，条目 ${files.length}，体积 ${(zip.length / 1024).toFixed(1)} KB`)
