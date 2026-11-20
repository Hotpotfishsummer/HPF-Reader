/**
 * TXT 文本智能分章与转码为标准 EPUB 结构（P4 格式扩展）。
 * 纯客户端标准 Web API，零第三方压缩依赖。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

function writeUInt16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
}

function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
  buf[offset + 2] = (value >> 16) & 0xff
  buf[offset + 3] = (value >> 24) & 0xff
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const encoder = new TextEncoder()

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = entry.data
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    writeUInt32LE(local, 0, 0x04034b50)
    writeUInt16LE(local, 4, 20)
    writeUInt16LE(local, 6, 0x0800)
    writeUInt16LE(local, 8, 0)
    writeUInt16LE(local, 10, 0)
    writeUInt16LE(local, 12, 0x21)
    writeUInt32LE(local, 14, crc)
    writeUInt32LE(local, 18, data.length)
    writeUInt32LE(local, 22, data.length)
    writeUInt16LE(local, 26, nameBytes.length)
    writeUInt16LE(local, 28, 0)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    chunks.push(local)

    const cdir = new Uint8Array(46 + nameBytes.length)
    writeUInt32LE(cdir, 0, 0x02014b50)
    writeUInt16LE(cdir, 4, 20)
    writeUInt16LE(cdir, 6, 20)
    writeUInt16LE(cdir, 8, 0x0800)
    writeUInt16LE(cdir, 10, 0)
    writeUInt16LE(cdir, 12, 0)
    writeUInt16LE(cdir, 14, 0x21)
    writeUInt32LE(cdir, 16, crc)
    writeUInt32LE(cdir, 20, data.length)
    writeUInt32LE(cdir, 24, data.length)
    writeUInt16LE(cdir, 28, nameBytes.length)
    writeUInt16LE(cdir, 30, 0)
    writeUInt16LE(cdir, 32, 0)
    writeUInt16LE(cdir, 34, 0)
    writeUInt16LE(cdir, 36, 0)
    writeUInt32LE(cdir, 38, 0)
    writeUInt32LE(cdir, 42, offset)
    cdir.set(nameBytes, 46)
    central.push(cdir)

    offset += local.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const c of central) centralSize += c.length

  const eocd = new Uint8Array(22)
  writeUInt32LE(eocd, 0, 0x06054b50)
  writeUInt16LE(eocd, 4, 0)
  writeUInt16LE(eocd, 6, 0)
  writeUInt16LE(eocd, 8, entries.length)
  writeUInt16LE(eocd, 10, entries.length)
  writeUInt32LE(eocd, 12, centralSize)
  writeUInt32LE(eocd, 16, centralOffset)
  writeUInt16LE(eocd, 20, 0)

  const totalLength = centralOffset + centralSize + eocd.length
  const out = new Uint8Array(totalLength)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  for (const c of central) {
    out.set(c, pos)
    pos += c.length
  }
  out.set(eocd, pos)
  return out
}

export function decodeTxt(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

interface Chapter {
  title: string
  content: string
}

export function splitChapters(text: string): Chapter[] {
  const chapterPattern = /(?:^[ \t]*(?:第[0-9一二三四五六七八九十百千0-9]+[章回节卷集幕篇部]|Chapter\s+\d+|Section\s+\d+)[^\n\r]{0,35})/gim
  const chapters: Chapter[] = []
  const matches = Array.from(text.matchAll(chapterPattern))

  if (matches.length > 0) {
    // 序言部分（第一章之前的文字）
    const firstMatch = matches[0]!
    if (firstMatch.index !== undefined && firstMatch.index > 0) {
      const intro = text.slice(0, firstMatch.index).trim()
      if (intro) {
        chapters.push({ title: '前言', content: intro })
      }
    }

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!
      const start = match.index!
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length
      const title = match[0].trim()
      const content = text.slice(start + match[0].length, end).trim()
      chapters.push({ title, content })
    }
  } else {
    // 如果没有探测到章节标题，按字数（约 3000 字）分段
    const chunkSize = 3000
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize).trim()
      chapters.push({
        title: `第 ${Math.floor(i / chunkSize) + 1} 节`,
        content: chunk,
      })
    }
  }

  return chapters
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function txtToEpub(filename: string, rawBytes: Uint8Array): File {
  const encoder = new TextEncoder()
  const text = decodeTxt(rawBytes)
  const chapters = splitChapters(text)
  const title = filename.replace(/\.[^/.]+$/, '')

  const entries: ZipEntry[] = []

  // 1. mimetype（必须未压缩排在首位）
  entries.push({ name: 'mimetype', data: encoder.encode('application/epub+zip') })

  // 2. META-INF/container.xml
  entries.push({
    name: 'META-INF/container.xml',
    data: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  })

  // 3. 章节 HTML 文件
  chapters.forEach((chap, idx) => {
    const paragraphs = chap.content
      .split(/\r?\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n')

    const html = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeHtml(chap.title)}</title>
  <meta charset="utf-8"/>
</head>
<body>
  <h1>${escapeHtml(chap.title)}</h1>
  ${paragraphs}
</body>
</html>`

    entries.push({
      name: `OEBPS/chapter_${idx + 1}.xhtml`,
      data: encoder.encode(html),
    })
  })

  // 4. toc.xhtml (Navigation Document)
  const navItems = chapters
    .map((chap, idx) => `<li><a href="chapter_${idx + 1}.xhtml">${escapeHtml(chap.title)}</a></li>`)
    .join('\n')

  const tocHtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>目录</title>
  <meta charset="utf-8"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      ${navItems}
    </ol>
  </nav>
</body>
</html>`

  entries.push({
    name: 'OEBPS/toc.xhtml',
    data: encoder.encode(tocHtml),
  })

  // 5. content.opf
  const manifestItems = chapters
    .map((_, idx) => `<item id="c${idx + 1}" href="chapter_${idx + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ')

  const spineItems = chapters
    .map((_, idx) => `<itemref idref="c${idx + 1}"/>`)
    .join('\n    ')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${title}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`

  entries.push({
    name: 'OEBPS/content.opf',
    data: encoder.encode(opf),
  })

  const zipBytes = buildZip(entries)
  return new File([zipBytes.buffer as ArrayBuffer], `${title}.epub`, { type: 'application/epub+zip' })
}
