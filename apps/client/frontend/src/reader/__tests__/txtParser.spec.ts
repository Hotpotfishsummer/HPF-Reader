import { describe, expect, it } from 'vitest'
import { decodeTxt, splitChapters, txtToEpub } from '../txtParser'

describe('txtParser', () => {
  it('解码 UTF-8 文本', () => {
    const raw = new TextEncoder().encode('测试 UTF-8 文本')
    expect(decodeTxt(raw)).toBe('测试 UTF-8 文本')
  })

  it('智能探测并分割章节（包含前言与多章节）', () => {
    const text = `
这是书的前言介绍内容。
在第一章开始前。

第一章 初遇
这里是第一章的正文内容。

第二章 重逢
这里是第二章的正文内容。

Chapter 3 The End
Final chapter content.
`
    const chapters = splitChapters(text)
    expect(chapters.length).toBe(4)
    expect(chapters[0]?.title).toBe('前言')
    expect(chapters[0]?.content).toContain('这是书的前言介绍内容')
    expect(chapters[1]?.title).toBe('第一章 初遇')
    expect(chapters[1]?.content).toContain('这里是第一章的正文内容')
    expect(chapters[2]?.title).toBe('第二章 重逢')
    expect(chapters[3]?.title).toBe('Chapter 3 The End')
  })

  it('无章节标题时按字数分段', () => {
    const longText = '这是一段普通的无章节文字。'.repeat(300)
    const chapters = splitChapters(longText)
    expect(chapters.length).toBeGreaterThan(1)
    expect(chapters[0]?.title).toBe('第 1 节')
  })

  it('将文本成功转为标准 EPUB 3 zip 文件', () => {
    const sampleTxt = `
第一章 启程
这是测试正文段落 1。
这是测试正文段落 2。

第二章 探险
继续探险的正文内容。
`
    const raw = new TextEncoder().encode(sampleTxt)
    const file = txtToEpub('MyBook.txt', raw)
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('MyBook.epub')
    expect(file.type).toBe('application/epub+zip')
    expect(file.size).toBeGreaterThan(500)
  })
})
