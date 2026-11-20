import { describe, expect, it } from 'vitest'
import { expandRangeToSentence } from '../sentenceHelper'

describe('sentenceHelper - expandRangeToSentence', () => {
  it('正确扩展中文单句（含句号）', () => {
    const p = document.createElement('p')
    p.textContent = '这是第一句话。这是第二句话。这是第三句话。'
    document.body.appendChild(p)

    const textNode = p.firstChild as Text
    const range = document.createRange()
    // 选中 "第二"
    range.setStart(textNode, 9)
    range.setEnd(textNode, 11)

    const expanded = expandRangeToSentence(range, document)
    expect(expanded).not.toBeNull()
    expect(expanded!.text).toBe('这是第二句话。')
  })

  it('正确吃进组合标点与后引号（“这是引文！”）', () => {
    const p = document.createElement('p')
    p.textContent = '前言。他说：“这是精彩的引文！？”然后走开了。'
    document.body.appendChild(p)

    const textNode = p.firstChild as Text
    const range = document.createRange()
    // 选中 "精彩"
    range.setStart(textNode, 9)
    range.setEnd(textNode, 11)

    const expanded = expandRangeToSentence(range, document)
    expect(expanded).not.toBeNull()
    expect(expanded!.text).toBe('他说：“这是精彩的引文！？”')
  })

  it('跨内联标签（如 <em>, <strong>）也能正确合并整句', () => {
    const p = document.createElement('p')
    p.innerHTML = '第一句结束。这是包含<em>重点词汇</em>的完整句子！第三句。'
    document.body.appendChild(p)

    const em = p.querySelector('em')!
    const range = document.createRange()
    range.selectNodeContents(em)

    const expanded = expandRangeToSentence(range, document)
    expect(expanded).not.toBeNull()
    expect(expanded!.text).toBe('这是包含重点词汇的完整句子！')
  })

  it('英文句子探测及前导空格处理', () => {
    const p = document.createElement('p')
    p.textContent = 'First sentence. This is the second sentence! Third one.'
    document.body.appendChild(p)

    const textNode = p.firstChild as Text
    const range = document.createRange()
    // 选中 "second"
    const start = p.textContent.indexOf('second')
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 6)

    const expanded = expandRangeToSentence(range, document)
    expect(expanded).not.toBeNull()
    expect(expanded!.text).toBe('This is the second sentence!')
  })

  it('段落末尾无标点时平滑扩展到段末', () => {
    const p = document.createElement('p')
    p.textContent = '第一句已完。这一句没有标点'
    document.body.appendChild(p)

    const textNode = p.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 9)
    range.setEnd(textNode, 11)

    const expanded = expandRangeToSentence(range, document)
    expect(expanded).not.toBeNull()
    expect(expanded!.text).toBe('这一句没有标点')
  })
})
