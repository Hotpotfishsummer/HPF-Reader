#!/usr/bin/env node
/**
 * 生成一本"大书"用于排版性能判别实验。
 *
 * 目的：用户反馈"排版花十几/数十秒"，而仓库里的测试书都很小（≤600KB），
 * 初排只要 178ms。本脚本生成一本**明显更大**的 EPUB（多章节 + 每章多段落 + 多图片），
 * 用来验证"排版耗时是否随书规模（章节数 / 元素数 / 图片数）放大"。
 *
 * 结构：20 章，每章 120 段（每段约 180 字），每章 6 张内联 SVG 图。
 *   总段落 ~2400，总图片 ~120。用 deflate 压缩，体积可控。
 *
 * 用法: corepack pnpm exec node scripts/make-large-epub.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, '../../../../testdata/books/large-book.epub')

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

/* ---------------- ZIP writer（deflate 压缩） ---------------- */
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

/* ---------------- 内容生成 ---------------- */
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

// 一段固定的中文文本（避免 XML 转义麻烦，不含特殊字符）。
const SENTENCE = '这是一段用于性能判别实验的正文内容，描述阅读器在处理较大书籍时的排版行为与重排开销。'
const para = (n) => `    <p>${SENTENCE.repeat(n)}</p>`

// 内联 SVG 图：foliate-js 的 setImageSize 会对每个 img/svg 调 getComputedStyle。
const svg = (i) => `    <p><svg width="200" height="120" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="120" fill="hsl(${(i * 37) % 360},60%,70%)" /><text x="10" y="65" font-size="16" fill="#333">图 ${i}</text></svg></p>`

const CHAPTERS = 20
const PARAS_PER_CHAPTER = 120
const IMAGES_PER_CHAPTER = 6

const navItems = []
for (let c = 1; c <= CHAPTERS; c += 1) {
  navItems.push(`        <li><a href="chapter${c}.xhtml">第 ${c} 章 · 性能判别实验</a></li>`)
}
const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head><meta charset="utf-8" /><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
${navItems.join('\n')}
      </ol>
    </nav>
  </body>
</html>
`

const manifestItems = ['    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />', '    <item id="css" href="styles.css" media-type="text/css" />']
const spineItems = []
for (let c = 1; c <= CHAPTERS; c += 1) {
  manifestItems.push(`    <item id="c${c}" href="chapter${c}.xhtml" media-type="application/xhtml+xml" />`)
  spineItems.push(`    <itemref idref="c${c}" />`)
}

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:hpf-reader-large-0001</dc:identifier>
    <dc:title>HPF Reader 大书性能判别</dc:title>
    <dc:creator>HPF-Reader 团队</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-02T00:00:00Z</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine>
${spineItems.join('\n')}
  </spine>
</package>
`

const styles = `body { font-family: "Noto Serif CJK SC", serif; line-height: 1.7; margin: 5%; }
h1 { font-size: 1.5em; margin-bottom: 1.2em; }
p { text-indent: 2em; margin: 0.6em 0; }
svg { display: block; margin: 1em auto; }
`

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
]

for (let c = 1; c <= CHAPTERS; c += 1) {
  const paras = []
  for (let p = 0; p < PARAS_PER_CHAPTER; p += 1) paras.push(para(2))
  for (let im = 0; im < IMAGES_PER_CHAPTER; im += 1) paras.push(svg(c * 10 + im))
  files.push({ name: `OEBPS/chapter${c}.xhtml`, data: XHTML(`第 ${c} 章 · 性能判别实验`, paras.join('\n')) })
}

mkdirSync(dirname(outPath), { recursive: true })
const zip = buildZip(files)
writeFileSync(outPath, zip)
const totalParas = CHAPTERS * PARAS_PER_CHAPTER
const totalImgs = CHAPTERS * IMAGES_PER_CHAPTER
console.log(`[make-large-epub] 已生成 ${outPath}`)
console.log(`  章节 ${CHAPTERS}，段落 ${totalParas}，图片 ${totalImgs}，条目 ${files.length}，体积 ${(zip.length / 1024).toFixed(1)} KB`)
