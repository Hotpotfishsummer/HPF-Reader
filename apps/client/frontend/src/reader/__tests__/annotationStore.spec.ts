import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readLocalAnnotations, useAnnotations, writeLocalAnnotations, type AnnotationItem } from '../annotationStore'

describe('annotationStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('支持本地缓存读写', () => {
    const bookId = 'book-1'
    const list: AnnotationItem[] = [
      {
        id: 'ann-1',
        bookId,
        type: 'highlight',
        color: '#fef08a',
        text: '第一句文本',
        cfi: 'epubcfi(/6/2[chap1]!/4/2/1:0)',
        createdAt: new Date().toISOString(),
      },
    ]

    writeLocalAnnotations(bookId, list)
    const read = readLocalAnnotations(bookId)
    expect(read).toHaveLength(1)
    expect(read[0]?.text).toBe('第一句文本')
  })

  it('支持添加下划线与书签标注', async () => {
    const bookId = 'book-2'
    const store = useAnnotations(() => bookId)

    // 添加高亮
    const h = await store.add({
      type: 'highlight',
      color: '#bbf7d0',
      text: '绿色重点',
      cfi: 'cfi-1',
      chapterTitle: '第一章',
      progression: 15,
    })
    expect(h.id).toBeTruthy()
    expect(store.items.value).toHaveLength(1)

    // 添加语句划线（波浪线）
    const u = await store.add({
      type: 'underline',
      color: 'squiggly:#3b82f6',
      style: 'squiggly',
      text: '波浪划线语句',
      cfi: 'cfi-2',
      chapterTitle: '第二章',
      progression: 30,
    })
    expect(u.type).toBe('underline')
    expect(store.items.value).toHaveLength(2)

    // 添加书签
    const b = await store.add({
      type: 'bookmark',
      cfi: 'cfi-bookmark',
      chapterTitle: '第三章',
      progression: 45,
      text: '书签页首文字预览',
      color: '#f59e0b',
    })
    expect(b.type).toBe('bookmark')
    expect(store.items.value).toHaveLength(3)

    // 验证更新
    const updated = await store.update(h.id, {
      note: '添加的想法笔记',
      color: '#fbcfe8',
    })
    expect(updated?.note).toBe('添加的想法笔记')
    expect(updated?.color).toBe('#fbcfe8')

    // 验证删除
    await store.remove(u.id)
    expect(store.items.value).toHaveLength(2)
    expect(store.items.value.find((it) => it.id === u.id)).toBeUndefined()
  })

  it('离线时容错且与 API 结合时自动发起远端同步', async () => {
    const bookId = 'book-3'
    const mockApi = {
      annotations: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'remote-1',
            bookId,
            type: 'highlight',
            color: '#bfdbfe',
            text: '云端同步文本',
            locator: {
              href: 'chap1.xhtml',
              type: 'application/epub+zip',
              title: '第一章',
              locations: { fragments: ['cfi-remote'], progression: 0.2 },
            },
            createdAt: '2026-11-04T00:00:00Z',
            updatedAt: '2026-11-04T00:00:00Z',
          },
        ]),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }

    const store = useAnnotations(() => bookId, () => mockApi as any)
    await store.refresh()

    expect(mockApi.annotations.list).toHaveBeenCalledWith(bookId)
    expect(store.items.value).toHaveLength(1)
    expect(store.items.value[0]?.chapterTitle).toBe('第一章')
    expect(store.items.value[0]?.progression).toBe(20)

    // 本地添加会触发 remote create
    await store.add({
      type: 'bookmark',
      cfi: 'cfi-local-bm',
    })
    expect(mockApi.annotations.create).toHaveBeenCalled()
  })
})
