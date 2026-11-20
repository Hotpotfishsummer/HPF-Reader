/**
 * 语句识别与整句选区扩展辅助工具。
 *
 * 专门用于阅读器「语句划线 / 智能选句」功能：
 * 当用户点选或拖选一个短语/词汇时，智能向左向右探测中文与西文标点，
 * 将 Range 平滑扩展至整句话（含句末标点及后随引号）。
 */

const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '.', '\n', '\r'])
const CLOSING_QUOTES = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '}', '》', '〉', '』', '」'])
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'TD', 'TH',
])

interface CharMapping {
  char: string
  node: Text
  offset: number
}

function findBlockAncestor(node: Node): HTMLElement {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  while (el && el.parentElement && !BLOCK_TAGS.has(el.tagName)) {
    el = el.parentElement
  }
  return (el || node.ownerDocument?.body) as HTMLElement
}

function collectTextNodes(root: Node, list: Text[] = []): Text[] {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      list.push(child as Text)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as HTMLElement).tagName
      if (!BLOCK_TAGS.has(tag) || child === root) {
        collectTextNodes(child, list)
      }
    }
  }
  return list
}

export function expandRangeToSentence(
  range: Range,
  doc: Document,
): { range: Range; text: string } | null {
  if (!range || !doc) return null

  const common = range.commonAncestorContainer
  const block = findBlockAncestor(common)
  if (!block) return null

  const textNodes = collectTextNodes(block)
  if (textNodes.length === 0) return null

  const charMap: CharMapping[] = []
  let startIndex = -1
  let endIndex = -1

  for (const tNode of textNodes) {
    const str = tNode.data || ''
    for (let i = 0; i < str.length; i += 1) {
      const isStart =
        (tNode === range.startContainer && i === range.startOffset) ||
        (startIndex === -1 && typeof range.comparePoint === 'function' && range.comparePoint(tNode, i) >= 0)
      if (isStart && startIndex === -1) {
        startIndex = charMap.length
      }

      const isEnd =
        (tNode === range.endContainer && i === range.endOffset) ||
        (startIndex !== -1 && endIndex === -1 && typeof range.comparePoint === 'function' && range.comparePoint(tNode, i) > 0)
      if (isEnd && endIndex === -1) {
        endIndex = charMap.length
      }

      charMap.push({
        char: str[i]!,
        node: tNode,
        offset: i,
      })
    }
    // 处理选区正好落在节点末尾的情况
    if (tNode === range.startContainer && range.startOffset === str.length) {
      startIndex = charMap.length
    }
    if (tNode === range.endContainer && range.endOffset === str.length) {
      endIndex = charMap.length
    }
  }

  if (charMap.length === 0) return null
  if (startIndex === -1) startIndex = 0
  if (endIndex === -1) endIndex = charMap.length

  // 向前探测句首（跳过前一句的句末标点）
  let sentenceStart = startIndex
  while (sentenceStart > 0) {
    const prevChar = charMap[sentenceStart - 1]!.char
    if (SENTENCE_ENDERS.has(prevChar)) {
      break
    }
    sentenceStart -= 1
  }

  // 跳过句首可能跟随的空格
  while (sentenceStart < startIndex && /\s/.test(charMap[sentenceStart]!.char)) {
    sentenceStart += 1
  }

  // 向后探测句末标点
  let sentenceEnd = Math.max(endIndex, sentenceStart)
  while (sentenceEnd < charMap.length) {
    const ch = charMap[sentenceEnd]!.char
    if (SENTENCE_ENDERS.has(ch)) {
      // 包含这个标点
      sentenceEnd += 1
      // 如果紧接着省略号、感叹号等组合标点，继续吃进
      while (sentenceEnd < charMap.length && SENTENCE_ENDERS.has(charMap[sentenceEnd]!.char)) {
        sentenceEnd += 1
      }
      // 如果紧接着后引号/括号（如：“这是引文！”），也一并吃进
      while (sentenceEnd < charMap.length && CLOSING_QUOTES.has(charMap[sentenceEnd]!.char)) {
        sentenceEnd += 1
      }
      break
    }
    sentenceEnd += 1
  }

  if (sentenceStart >= sentenceEnd) {
    return { range, text: range.toString() }
  }

  const startEntry = charMap[sentenceStart]!
  const newRange = doc.createRange()
  newRange.setStart(startEntry.node, startEntry.offset)

  if (sentenceEnd >= charMap.length) {
    const lastNode = textNodes[textNodes.length - 1]!
    newRange.setEnd(lastNode, lastNode.data.length)
  } else {
    const endEntry = charMap[sentenceEnd]!
    newRange.setEnd(endEntry.node, endEntry.offset)
  }

  return {
    range: newRange,
    text: newRange.cloneContents().textContent || newRange.toString() || '',
  }
}
