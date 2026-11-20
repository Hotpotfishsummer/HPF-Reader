import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ReaderSearchPanel from '../components/ReaderSearchPanel.vue'
import ReaderDrawer from '../components/ReaderDrawer.vue'
import ReaderToolbar from '../components/ReaderToolbar.vue'
import ReaderBookmarksPopover from '../components/ReaderBookmarksPopover.vue'
import type { FoliateEngine } from '../useFoliateEngine'
import { PlatformKey } from '@/platform'
import { createTestPlatform } from '@/platform/test'
import type { AnnotationItem } from '../annotationStore'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params) return `${key}:${JSON.stringify(params)}`
      return key
    },
  }),
}))

function createMockEngine(overrides: Partial<FoliateEngine> = {}): FoliateEngine {
  return {
    ready: { value: true } as any,
    open: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    goTo: vi.fn(),
    getToc: vi.fn().mockReturnValue([]),
    getCurrentHref: vi.fn().mockReturnValue(''),
    setStyles: vi.fn(),
    setLayout: vi.fn(),
    getPageCount: vi.fn().mockReturnValue(10),
    getCFI: vi.fn().mockReturnValue('epubcfi(/6/2)'),
    addAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    search: vi.fn().mockImplementation(async function* () {
      yield { progress: 0.5 }
      yield {
        label: 'Chapter 1',
        subitems: [
          {
            cfi: 'cfi-match-1',
            excerpt: { pre: 'Hello ', match: 'world', post: ' today' },
          },
        ],
      }
      yield 'done'
    }),
    clearSearch: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
}

describe('ReaderSearchPanel.vue', () => {
  it('执行搜索并渲染搜索结果，支持跳转与前进后退', async () => {
    const engine = createMockEngine()
    const wrapper = mount(ReaderSearchPanel, {
      props: {
        open: true,
        engine,
      },
    })

    const input = wrapper.find('[data-testid="search-input"]')
    await input.setValue('world')
    await wrapper.find('form').trigger('submit')

    expect(engine.search).toHaveBeenCalledWith('world', { matchCase: false })

    // 等待异步迭代完成
    await new Promise((r) => setTimeout(r, 20))
    await wrapper.vm.$nextTick()

    // 应该发出了第一次 jump
    expect(wrapper.emitted('jump')?.[0]).toEqual(['cfi-match-1'])

    // 应该渲染了高亮词
    const mark = wrapper.find('mark')
    expect(mark.exists()).toBe(true)
    expect(mark.text()).toBe('world')

    // 清除搜索
    const closeBtn = wrapper.find('[data-testid="close-search"]')
    await closeBtn.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})

describe('ReaderDrawer.vue', () => {
  const mockToc = [
    { label: '第一章 启程', target: 'chap1.xhtml' },
    { label: '第二章 冒险', target: 'chap2.xhtml' },
  ]

  const mockAnnotations: AnnotationItem[] = [
    {
      id: 'a1',
      bookId: 'b1',
      type: 'highlight',
      color: '#fef08a',
      text: '普通高亮引文',
      cfi: 'cfi-1',
      chapterTitle: '第一章 启程',
      progression: 10,
      createdAt: '2026-11-04T00:00:00Z',
    },
    {
      id: 'a2',
      bookId: 'b1',
      type: 'underline',
      color: 'squiggly:#3b82f6',
      style: 'squiggly',
      text: '波浪划线语句',
      cfi: 'cfi-2',
      chapterTitle: '第二章 冒险',
      progression: 25,
      createdAt: '2026-11-04T01:00:00Z',
    },
    {
      id: 'a3',
      bookId: 'b1',
      type: 'note',
      color: '#fef08a',
      text: '带想法的引文',
      note: '读者深刻的体会',
      cfi: 'cfi-3',
      chapterTitle: '第二章 冒险',
      progression: 30,
      createdAt: '2026-11-04T02:00:00Z',
    },
    {
      id: 'bm1',
      bookId: 'b1',
      type: 'bookmark',
      cfi: 'cfi-bm',
      chapterTitle: '第二章 冒险',
      progression: 35,
      text: '书签处段首内容',
      createdAt: '2026-11-04T03:00:00Z',
    },
  ]

  it('展示目录并在点击时发出 jumpToc 事件', async () => {
    const engine = createMockEngine()
    const wrapper = mount(ReaderDrawer, {
      props: {
        tab: 'toc',
        toc: mockToc,
        annotations: mockAnnotations,
        engine,
        bookTitle: '测试书名',
      },
    })

    const buttons = wrapper.findAll('ul li button')
    expect(buttons).toHaveLength(2)
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('jumpToc')?.[0]).toEqual(['chap1.xhtml'])
  })

  it('展示书签 Tab 并支持点击跳转与删除', async () => {
    const engine = createMockEngine()
    const wrapper = mount(ReaderDrawer, {
      props: {
        tab: 'bookmarks',
        toc: mockToc,
        annotations: mockAnnotations,
        engine,
        bookTitle: '测试书名',
      },
    })

    // 应该只展示 1 条书签
    const bookmarkItems = wrapper.findAll('ul li')
    expect(bookmarkItems).toHaveLength(1)
    expect(bookmarkItems[0]!.text()).toContain('书签处段首内容')

    // 点击书签跳转
    await bookmarkItems[0]!.trigger('click')
    expect(wrapper.emitted('jumpAnnotation')?.[0]).toEqual([mockAnnotations[3]])

    // 点击删除
    const deleteBtn = bookmarkItems[0]!.find('button[title="common.delete"]')
    await deleteBtn.trigger('click')
    expect(wrapper.emitted('deleteAnnotation')?.[0]).toEqual([mockAnnotations[3]])
  })

  it('支持切换 Tab 触发 update:tab', async () => {
    const engine = createMockEngine()
    const wrapper = mount(ReaderDrawer, {
      props: {
        tab: 'toc',
        toc: mockToc,
        annotations: mockAnnotations,
        engine,
        bookTitle: '测试书名',
      },
    })

    await wrapper.find('[data-testid="drawer-tab-bookmarks"]').trigger('click')
    expect(wrapper.emitted('update:tab')?.[0]).toEqual(['bookmarks'])

    await wrapper.find('[data-testid="drawer-tab-search"]').trigger('click')
    expect(wrapper.emitted('update:tab')?.[1]).toEqual(['search'])
  })
})

describe('ReaderToolbar.vue 动作按钮响应与高亮', () => {
  it('点击双语对照、朗读、排版设置按钮正确触发对应事件', async () => {
    const wrapper = mount(ReaderToolbar, {
      global: {
        provide: {
          [PlatformKey]: createTestPlatform(),
        },
      },
      props: {
        chapter: '第 1 章',
        progress: 15,
        tocOpen: false,
        sanitizeSummary: '',
        compact: false,
        orientation: 'landscape',
        columns: 2,
        themeLabel: '纸白',
        title: '测试图书',
        bilingualOpen: false,
        ttsOpen: false,
        typographyOpen: false,
      },
    })

    const bilingualBtn = wrapper.find('[data-testid="toggle-bilingual"]')
    const ttsBtn = wrapper.find('[data-testid="toggle-tts"]')
    const typographyBtn = wrapper.find('[data-testid="toggle-typography"]')

    expect(bilingualBtn.exists()).toBe(true)
    expect(ttsBtn.exists()).toBe(true)
    expect(typographyBtn.exists()).toBe(true)

    await bilingualBtn.trigger('click')
    expect(wrapper.emitted('toggle-bilingual')).toHaveLength(1)

    await ttsBtn.trigger('click')
    expect(wrapper.emitted('toggle-tts')).toHaveLength(1)

    await typographyBtn.trigger('click')
    expect(wrapper.emitted('toggle-typography')).toHaveLength(1)
  })

  it('打开对应面板时渲染激活高亮样式', async () => {
    const wrapper = mount(ReaderToolbar, {
      global: {
        provide: {
          [PlatformKey]: createTestPlatform(),
        },
      },
      props: {
        chapter: '第 1 章',
        progress: 15,
        tocOpen: false,
        sanitizeSummary: '',
        compact: false,
        orientation: 'landscape',
        columns: 2,
        themeLabel: '纸白',
        title: '测试图书',
        bilingualOpen: true,
        ttsOpen: true,
        typographyOpen: true,
      },
    })

    const bilingualBtn = wrapper.find('[data-testid="toggle-bilingual"]')
    const ttsBtn = wrapper.find('[data-testid="toggle-tts"]')
    const typographyBtn = wrapper.find('[data-testid="toggle-typography"]')

    expect(bilingualBtn.classes()).toContain('text-[var(--color-accent)]')
    expect(ttsBtn.classes()).toContain('text-[var(--color-accent)]')
    expect(typographyBtn.classes()).toContain('text-[var(--color-accent)]')
  })

  it('点击全屏按钮触发 toggle-fullscreen 事件，双击标题栏触发窗口最大化', async () => {
    const testPlatform = createTestPlatform()
    const toggleMaximizeSpy = vi.spyOn(testPlatform.window, 'toggleMaximize')

    const wrapper = mount(ReaderToolbar, {
      global: {
        provide: {
          [PlatformKey]: testPlatform,
        },
      },
      props: {
        chapter: '第 1 章',
        progress: 15,
        tocOpen: false,
        sanitizeSummary: '',
        compact: false,
        orientation: 'landscape',
        columns: 2,
        themeLabel: '纸白',
        title: '测试图书',
        isFullscreen: false,
      },
    })

    const fsBtn = wrapper.find('[data-testid="toggle-fullscreen"]')
    expect(fsBtn.exists()).toBe(true)
    await fsBtn.trigger('click')
    expect(wrapper.emitted('toggle-fullscreen')).toHaveLength(1)

    // 双击标题栏空白处
    const header = wrapper.find('[data-testid="reader-toolbar"]')
    await header.trigger('dblclick')
    expect(toggleMaximizeSpy).toHaveBeenCalled()
  })

  it('书签按钮组支持标记当前页以及展开书签查看面板', async () => {
    const wrapper = mount(ReaderToolbar, {
      global: {
        provide: {
          [PlatformKey]: createTestPlatform(),
        },
      },
      props: {
        chapter: '第 1 章',
        progress: 15,
        tocOpen: false,
        sanitizeSummary: '',
        compact: false,
        orientation: 'landscape',
        columns: 2,
        themeLabel: '纸白',
        title: '测试图书',
        bookmarked: true,
        bookmarksOpen: false,
        bookmarkCount: 3,
      },
    })

    const toggleBookmarkBtn = wrapper.find('[data-testid="toggle-bookmark"]')
    const openBookmarksBtn = wrapper.find('[data-testid="open-bookmarks-panel"]')

    expect(toggleBookmarkBtn.exists()).toBe(true)
    expect(openBookmarksBtn.exists()).toBe(true)
    expect(openBookmarksBtn.text()).toContain('3')

    await toggleBookmarkBtn.trigger('click')
    expect(wrapper.emitted('toggle-bookmark')).toHaveLength(1)

    await openBookmarksBtn.trigger('click')
    expect(wrapper.emitted('toggle-bookmarks')).toHaveLength(1)
  })
})

describe('ReaderBookmarksPopover.vue 书签查看控件', () => {
  const sampleBookmarks: AnnotationItem[] = [
    {
      id: 'bm-1',
      bookId: 'book-1',
      type: 'bookmark',
      cfi: 'epubcfi(/6/2[chap1]!/4/2:0)',
      chapterTitle: '第一章 启程',
      progression: 12,
      text: '天空泛起了鱼肚白，旅人背起了行囊。',
      createdAt: '2026-11-10T10:00:00.000Z',
    },
    {
      id: 'bm-2',
      bookId: 'book-1',
      type: 'bookmark',
      cfi: 'epubcfi(/6/4[chap2]!/4/10:5)',
      chapterTitle: '第二章 暗流',
      progression: 45,
      text: '城门缓缓关闭，警钟在夜空中回荡。',
      note: '关键转折点',
      createdAt: '2026-11-10T11:30:00.000Z',
    },
  ]

  it('展示空状态提示', () => {
    const wrapper = mount(ReaderBookmarksPopover, {
      props: {
        open: true,
        bookmarks: [],
      },
    })

    expect(wrapper.find('[data-testid="bookmarks-empty"]').exists()).toBe(true)
  })

  it('展示书签列表，包含章节、进度、引文摘录、备注和时间', () => {
    const wrapper = mount(ReaderBookmarksPopover, {
      props: {
        open: true,
        bookmarks: sampleBookmarks,
        currentCfi: 'epubcfi(/6/2[chap1]!/4/2:0)',
        isCurrentBookmarked: true,
      },
    })

    const items = wrapper.findAll('[data-testid="bookmark-item"]')
    expect(items).toHaveLength(2)

    expect(items[0]!.text()).toContain('第一章 启程')
    expect(items[0]!.text()).toContain('12%')
    expect(items[0]!.text()).toContain('天空泛起了鱼肚白')
    expect(items[0]!.text()).toContain('reader.currentPage')

    expect(items[1]!.text()).toContain('第二章 暗流')
    expect(items[1]!.text()).toContain('45%')
    expect(items[1]!.text()).toContain('城门缓缓关闭')
    expect(items[1]!.text()).toContain('关键转折点')
  })

  it('支持搜索过滤书签', async () => {
    const wrapper = mount(ReaderBookmarksPopover, {
      props: {
        open: true,
        bookmarks: sampleBookmarks,
      },
    })

    const searchInput = wrapper.find('[data-testid="bookmarks-search-input"]')
    expect(searchInput.exists()).toBe(true)

    await searchInput.setValue('暗流')
    const filtered = wrapper.findAll('[data-testid="bookmark-item"]')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.text()).toContain('第二章 暗流')
  })

  it('点击书签项触发 jump，点击删除触发 delete，点击标记本页触发 toggleCurrent', async () => {
    const wrapper = mount(ReaderBookmarksPopover, {
      props: {
        open: true,
        bookmarks: sampleBookmarks,
        isCurrentBookmarked: false,
      },
    })

    const items = wrapper.findAll('[data-testid="bookmark-item"]')
    await items[0]!.trigger('click')
    expect(wrapper.emitted('jump')?.[0]).toEqual([sampleBookmarks[0]])

    const deleteBtn = items[0]!.find('button[title="common.delete"]')
    await deleteBtn.trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual([sampleBookmarks[0]])

    const toggleCurrentBtn = wrapper.find('[data-testid="popover-toggle-current"]')
    await toggleCurrentBtn.trigger('click')
    expect(wrapper.emitted('toggleCurrent')).toHaveLength(1)
  })
})

describe('createWheelTurnHandler', () => {
  it('单次物理滚轮事件（deltaY=100）立即触发翻页并进入冷却', async () => {
    const { createWheelTurnHandler } = await import('../bridge')
    const onWheel = vi.fn()
    const handler = createWheelTurnHandler(onWheel, { wheelThreshold: 60, wheelCooldownMs: 150 })

    const fakeEvent = {
      preventDefault: vi.fn(),
      deltaY: 100,
      deltaMode: 0,
    } as unknown as WheelEvent

    handler(fakeEvent)
    expect(fakeEvent.preventDefault).toHaveBeenCalled()
    expect(onWheel).toHaveBeenCalledTimes(1)
    expect(onWheel).toHaveBeenCalledWith(100)

    // 冷却期内的后续微小事件不应重复触发
    handler(fakeEvent)
    expect(onWheel).toHaveBeenCalledTimes(1)
  })
})
