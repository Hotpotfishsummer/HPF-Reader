<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useDebounceFn } from '@vueuse/core'
import { useSettingsStore, type ReaderTheme } from '@/stores/settings'
import { useSelectionTranslate } from '@/features/ai/composables/useSelectionTranslate'
import { useGlossary } from '@/features/ai/glossaryStore'
import TranslateBubble from '@/features/ai/components/TranslateBubble.vue'
import BookTranslatePanel from '@/features/ai/components/BookTranslatePanel.vue'
import GlossaryPanel from '@/features/ai/components/GlossaryPanel.vue'
import BilingualView from '@/features/ai/components/BilingualView.vue'
import { useTts } from '@/features/tts/useTts'
import TtsPlayer from '@/features/tts/components/TtsPlayer.vue'
import ReaderSettingsPopover from './components/ReaderSettingsPopover.vue'
import ReaderSearchPanel from './components/ReaderSearchPanel.vue'
import ReaderDrawer, { type DrawerTab } from './components/ReaderDrawer.vue'
import ReaderBookmarksPopover from './components/ReaderBookmarksPopover.vue'
import { useAnnotations, type AnnotationItem } from './annotationStore'
import { usePageTurnAnimation } from './usePageTurnAnimation'
import './pageTurnAnimations.css'
import { useApi } from '@/api'
import { usePlatform } from '@/platform'
import { SAMPLE_BOOK_ID, getRememberedBook, isLocalOnlyBook, rememberBook } from './bookSession'
import { useFoliateEngine, type RelocateDetail } from './useFoliateEngine'
import { useReaderLayout, COLUMN_GAP_PERCENT } from './useReaderLayout'
import { bridgeSectionDocument, createWheelTurnHandler } from './bridge'
import { anchorFromRange } from './coords'
import { buildReaderStyles, resolveReaderTokens } from './readerStyles'
import {
  cacheResolvedProgress,
  rememberProgress,
  resolveProgress,
  resolveReaderProgress,
  type RemoteProgress,
} from './progressStore'
import { createProgressSync } from './progressSync'
import { getSyncEngine, getSyncRuntime } from '@/features/sync/runtime'
import ReaderToolbar from './components/ReaderToolbar.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const platform = usePlatform()
const settings = useSettingsStore()
const layout = useReaderLayout()

const bookId = computed(() => String(route.params['bookId'] ?? ''))
const isSample = computed(() => bookId.value === SAMPLE_BOOK_ID)

/**
 * ★ 进度该写到哪（本地优先的核心判断）。
 *
 *   - 桌面（capabilities 含 `library.local`）：**总是**走 platform —— 那边的"platform"
 *     就是本机 Go 书库，写进去是落本地文件，离线完全可用。
 *   - Web/服务端模式：只有"服务端确实有这本书"时才联网。示例书和直接打开的本地文件
 *     服务端不存在，此时传 `undefined`，progressStore 退化为纯 localStorage ——
 *     于是本地优先的书在 Web 模式下是**零网络请求**，不会制造 404 噪音。
 */
const progressBackend = computed(() => {
  const platformHasLocalLibrary = platform.capabilities.includes('library.local')
  if (platformHasLocalLibrary) return platform
  const localOnly = isSample.value || isLocalOnlyBook(bookId.value)
  return localOnly ? undefined : platform
})

const hostRef = useTemplateRef<HTMLElement>('hostRef')
const loading = ref(true)
const failed = ref<string | null>(null)
const toc = shallowRef<{ label: string; target: string | number }[]>([])
const progress = ref(0)
const chapterLabel = ref('')
const tocOpen = ref(layout.value.tocMode === 'sidebar')
const drawerTab = ref<DrawerTab>('toc')
/** 侧栏 / 弹窗面板状态 */
const aiPanelOpen = ref(false)
const glossaryOpen = ref(false)
const typographyOpen = ref(false)
const bilingualOpen = ref(false)
const ttsOpen = ref(false)
const searchOpen = ref(false)
const bookmarksOpen = ref(false)
const currentCfi = ref('')
const currentExcerpt = ref('')
const currentChapterIndex = ref(0)

/** 沉浸式阅读：控制顶部状态栏/工具栏的显示与隐藏 */
const toolbarVisible = ref(true)
/** 全屏状态 */
const isFullscreen = ref(false)
let cleanupFullscreenWatcher: (() => void) | undefined
let unbindHostWheel: (() => void) | undefined

function focusReadingArea(): void {
  try {
    if (currentDoc?.defaultView) {
      currentDoc.defaultView.focus()
      return
    }
  } catch {
    // 跨域或未就绪防护
  }
  hostRef.value?.focus()
}

function toggleToolbar(): void {
  toolbarVisible.value = !toolbarVisible.value
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (platform.window?.toggleFullscreen) {
      await platform.window.toggleFullscreen()
    }
    if (platform.window?.isFullscreen) {
      isFullscreen.value = await platform.window.isFullscreen()
    } else {
      isFullscreen.value = !isFullscreen.value
    }
  } catch {
    isFullscreen.value = !isFullscreen.value
  }
}

const api = useApi()

/**
 * ★ task-4：同步引擎只对"服务端也有的书"生效。
 *
 * 桌面本机书库（`library.local`）、内置示例书、直接拖进来的本地文件 —— 这些书服务端
 * 根本没有，拿它们去同步只会制造噪音。所以 `syncBookEligible` 为 false 时：
 *   - 进度：`getEngine()` 返回 undefined → 节流器直接跳过，零网络请求；
 *   - 标注：走旧的 REST 兜底路径（未登录语义）。
 */
const syncBookEligible = computed(() => !isSample.value && !isLocalOnlyBook(bookId.value))

/** 惰性取引擎：服务器地址变更后 runtime 会重建，缓存实例会踩到旧会话。 */
function resolveEngine() {
  if (!syncBookEligible.value) return undefined
  if (contentHashKnown && !isHexHash(contentHash)) return undefined
  return getSyncEngine()
}

/** 只有 hex 哈希（sha256 的前 16 位 / 全 64 位）才可能与云端 contentHash 对上。 */
function isHexHash(value: string | null): boolean {
  return typeof value === 'string' && /^[0-9a-f]{16,64}$/i.test(value)
}

/** 已登录才推/拉：未登录时阅读器是纯本地的（与 task-12 行为一致）。 */
function isLoggedIn(): boolean {
  try {
    return getSyncRuntime().session.accessToken !== null
  } catch {
    return false
  }
}

const annotations = useAnnotations(() => bookId.value, () => api, {
  getEngine: resolveEngine,
  isLoggedIn,
})

/**
 * ★ task-4：进度入队的节流器。
 *
 * 位置变化非常频繁（滚动/翻页每帧都可能触发 relocate），所以：
 *   - 本地 localStorage 仍然**每次都写**（同步、廉价、保证秒开）；
 *   - 云端入队按「≥2s 或进度变化 ≥0.5%」节流；用户显式跳转立即入队。
 *
 * 映射不到 server bookId（书还没上传到云端）时它自己会跳过 —— 不伪造 id。
 */
const progressSync = createProgressSync({
  getContentHash: () => contentHash,
  getEngine: resolveEngine,
  isLoggedIn,
})

/**
 * ★ 统一的"跳转到某位置"入口：目录 / 书签 / 搜索 / 章节 / 结果列表都走它。
 *
 * 下一处 relocate 会被标记成**用户显式跳转**：节流器立即入队，并且如果位置真的
 * 往后退，会带上 `explicitRewind: true`（服务端"允许回退且不覆盖历史最远"的信号）。
 * 自然翻页走 engine.next()/prev()，不经过这里 —— 于是不会误标。
 */
async function jumpTo(target: string | number | { fraction: number }): Promise<void> {
  progressSync.markExplicitJump()
  await engine.goTo(target)
  // ★ 这里**不**主动 flush：goTo 会触发 relocate，那一次带着 explicit 标记、不受节流限制。
  //   如果目标位置与当前页相同，relocate 不会发 —— 那说明位置压根没变，没有东西需要同步。
  //   （提前 flush 反而会把"跳转前的旧位置"发上去。）
}

/**
 * 打开书时 foliate 会先发一次 relocate（= 续读位置本身）。
 *
 * ★ 那一次**不同步**：续读位置可能比云端"历史最远"更靠前（用户上次只是翻回去看看），
 *   把它推上去会无谓地触发一次 rewind 语义。真正的阅读位置从下一次翻页开始同步。
 */
let progressSyncReady = false

/**
 * 入队一次进度；引擎/存储异常都不能打断阅读。
 *
 * 用户显式跳转不需要在这里做特殊处理：`jumpTo` 已经打了 explicit 标记，
 * 该标记会让**紧随其后的这次 relocate** 绕过节流，并携带正确的 explicitRewind。
 */
function applyProgressSync(bookId: string, location: RelocateDetail): void {
  if (!progressSyncReady) return
  try {
    progressSync.handleRelocate(bookId, {
      cfi: location.cfi,
      fraction: location.fraction,
      index: location.index,
    })
  } catch (error) {
    console.warn('[reader] 进度入队失败（本地已保存，稍后同步会补上）', error)
  }
}

const bookmarkedItems = computed(() => {
  return annotations.items.value.filter((a) => a.type === 'bookmark')
})

const isBookmarked = computed(() => {
  const cfi = currentCfi.value || lastCfi
  if (!cfi) return false
  return annotations.items.value.some((a) => a.type === 'bookmark' && a.cfi === cfi)
})

async function toggleBookmark(): Promise<void> {
  const cfi = currentCfi.value || lastCfi
  if (!cfi) return
  const existing = annotations.items.value.find((a) => a.type === 'bookmark' && a.cfi === cfi)
  if (existing) {
    await annotations.remove(existing.id)
  } else {
    const snippet = currentExcerpt.value || getCurrentReadableText().replace(/\s+/g, ' ').slice(0, 150)
    await annotations.add({
      type: 'bookmark',
      cfi,
      chapterTitle: chapterLabel.value || t('reader.title'),
      progression: progress.value,
      text: snippet || undefined,
    })
  }
}

async function handleEditNote(ann: AnnotationItem): Promise<void> {
  const current = ann.note ?? ''
  const updated = window.prompt(t('reader.editNote') || '编辑想法/备注', current)
  if (updated !== null && updated !== current) {
    await annotations.update(ann.id, { note: updated.trim() })
  }
}

const tts = useTts()

function getCurrentReadableText(): string {
  if (selectionText.value) return selectionText.value
  if (!currentDoc?.body) return ''
  return (currentDoc.body.innerText || currentDoc.body.textContent || '').trim()
}

function startTts(): void {
  const text = getCurrentReadableText()
  if (!text) return
  const lang = settings.locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  tts.speak(text, lang)
}

function toggleTts(): void {
  if (ttsOpen.value) {
    tts.stop()
    ttsOpen.value = false
  } else {
    ttsOpen.value = true
    startTts()
  }
}
const sanitizeSummary = ref('')
const selectionRectCount = ref(0)
/** 续读提示：只在"确实从上次位置继续"时显示一次。 */
const resumedFrom = ref('')
/**
 * ★ task-4：本次打开用的是**云端权威进度**（另一台设备读到的位置）。
 * locator 在下面 `loadBook` 里解析，这里存服务端信息用于提示与后续 enqueue。
 */
const remoteResume = ref<RemoteProgress | null>(null)
/** 当前书的 contentHash：用来把本地书映射到 server bookId（内容哈希是唯一桥梁）。 */
let contentHash: string | null = null
/** contentHash 是否已经是"可信的完整哈希"（否则不写进进度 op，避免服务端按错副本合并）。 */
let contentHashKnown = false

/**
 * ★ 当前章节文档：仅用于挂监听与算坐标（coords.ts 需要它）。
 * 它是 DOM 节点，**绝不**进响应式状态 —— 放闭包普通变量。
 */
let currentDoc: Document | null = null
let unbridge: (() => void) | null = null
let lastSaved = ''
/** 最近一次 relocate 的 CFI：换屏/旋转后用它把阅读位置拉回来。 */
let lastCfi = ''

/** 划词结果：只把"值"交给 Vue（文本 + 可见矩形数），Range 本身留在闭包里。 */
const selectionText = ref('')
let selectionRange: Range | null = null

/**
 * 划词翻译（task-23）。
 *
 * ★ 气泡锚点用**主文档视口坐标**（fixed 定位）：选区在 iframe 里，
 *   必须经 coords.ts 换算（selectionAnchor 已经算好了）。
 *   锚点变化时气泡跟随；选区清空时气泡保持（用户可能想先读完再关）。
 */
const selectionTranslate = useSelectionTranslate()
const bubbleAnchor = ref<{ left: number; top: number } | null>(null)

/** 目标语言跟随界面语言：中文界面→译成中文，英文界面→译成英文。 */
const targetLang = computed(() => (settings.locale === 'zh-CN' ? 'zh-CN' : 'en'))

/**
 * 本书术语表 → 翻译接口的 `glossary` 字段。
 *
 * 这条链路是**服务端已实现**的（POST /v1/ai/translate 的 glossary 进 system 前缀），
 * 所以划词翻译也会遵守已确认的译名 —— 这是术语一致性的实际落点。
 */
const glossary = useGlossary(() => bookId.value, () => targetLang.value)
const glossaryForTranslate = computed(() => glossary.translateGlossary.value)

const themeOrder: ReaderTheme[] = ['light', 'sepia', 'dark', 'ink']
const themeLabel = computed(() => t(`settings.themeName.${settings.readerTheme}`))

/**
 * 把当前选区换算成主文档视口坐标（§5.5 三个坐标空间的换算）。
 * iframe 通过 `doc.defaultView.frameElement` 拿到 —— foliate-js 不暴露它。
 */
function selectionAnchor(): { left: number; top: number } | null {
  if (!currentDoc || !selectionRange) return null
  const frame = currentDoc.defaultView?.frameElement
  if (!(frame instanceof HTMLIFrameElement)) return null
  const anchor = anchorFromRange(selectionRange, frame)
  if (!anchor) return null
  return { left: anchor.rect.left, top: anchor.rect.top }
}

/** M1 的最小划词动作：把选中的文本复制到剪贴板（浮层 UI 在 M2 接入）。 */
async function copySelection(): Promise<void> {
  if (!selectionRange || !selectionText.value) return
  try {
    await navigator.clipboard.writeText(selectionText.value)
  } catch (error) {
    console.warn('[reader] clipboard write failed', error)
  }
  selectionRange = null
  selectionText.value = ''
  selectionRectCount.value = 0
  bubbleAnchor.value = null
  selectionTranslate.reset()
}

/**
 * 开始划词翻译：把选中文本交给流式接口。
 *
 * ★ 锚点在这一刻才算（而不是选区一变就算）：这样选区只是"高亮 + 出现操作条"，
 *   不会立刻弹出一个大气泡挡住正文。用户点了「翻译」才需要看译文。
 */
function translateSelection(): void {
  if (selectionText.value === '') return
  const anchor = selectionAnchor()
  if (anchor) bubbleAnchor.value = anchor
  void selectionTranslate.start({
    text: selectionText.value,
    targetLang: targetLang.value,
    bookId: bookId.value,
    glossary: glossaryForTranslate.value,
  })
}

/** 关闭气泡：中止在途请求（★ 取消后不再烧钱）。 */
function closeBubble(): void {
  selectionTranslate.cancel()
  selectionTranslate.reset()
  bubbleAnchor.value = null
}

const FONT_MAP: Record<string, string> = {
  serif: 'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  kaiti: '"KaiTi", "STKaiti", "BiauKai", serif',
  system: 'system-ui, -apple-system, sans-serif',
}

function readerStyleInput() {
  // ★ 必须解析成具体值：CSS 变量不跨文档继承，直接写 var(...) 进 iframe 会静默失效。
  const tokens = resolveReaderTokens()
  return {
    fontFamily: FONT_MAP[settings.fontFamily] || tokens.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: 0.01,
    marginBlock: 32,
    paper: tokens.paper,
    ink: tokens.ink,
    textIndent: settings.textIndent,
    einkMode: settings.einkMode,
  }
}

/**
 * ★ 把"窗口尺寸"翻译成 engine 的几何参数（task-12 §3）。
 *
 * 真实的页边距取 `min(用户设置, 当前窗口允许的最大值)`：用户偏好优先，
 * 但竖屏窄窗下不能让页边距把正文挤没。
 */
let lastColumns: 1 | 2 = 1

function applyLayout(): void {
  const state = layout.value
  const columnsChanged = lastColumns !== state.columns
  lastColumns = state.columns

  engine.setLayout({
    columns: state.columns,
    maxInlineSize: state.maxInlineSize,
    marginInline: Math.min(settings.marginInline, state.maxMarginInline),
    columnGapPercent: COLUMN_GAP_PERCENT,
  })
  // 只有分栏数发生实质切换（如横竖屏旋转 1 栏 ↔ 2 栏）时，才需要强制把阅读位置拉回去；
  // 普通尺寸微调交由 paginator 原生 ResizeObserver 与 #anchor 机制平滑重排，
  // 避免微调窗口尺寸或侧栏折叠时重复调用 goTo 打断分页状态。
  if (columnsChanged && lastCfi) {
    void engine.goTo(lastCfi).catch(() => {
      // 位置在当前屏已经不存在（例如旋转后落在最后一页之外）：忽略，
      // paginator 自己的 #anchor 机制会把位置夹到最近的有效页。
    })
  }
}

/**
 * 旋转 / 拖拽窗口时会连续触发；重排整本书不便宜，所以这里防抖。
 * 注意 layout 状态本身不防抖 —— UI 要立刻跟着方向变。
 */
const reflow = useDebounceFn(() => {
  if (loading.value) return
  applyLayout()
}, 150)

const engine = useFoliateEngine(() => hostRef.value, {
  onReady(book) {
    loading.value = false
    toc.value = (book.toc ?? []).map((item) => ({ label: item.label, target: item.href }))
    applyStyles()
    applyLayout()
    setTimeout(() => focusReadingArea(), 50)
  },
  onError(error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  },
  onRelocate(location: RelocateDetail) {
    progress.value = Math.round(location.fraction * 100)
    chapterLabel.value = location.tocLabel
    currentChapterIndex.value = location.index
    if (location.cfi) {
      lastCfi = location.cfi
      currentCfi.value = location.cfi
    }
    if (location.excerpt) {
      currentExcerpt.value = location.excerpt
    } else {
      const fallback = getCurrentReadableText().replace(/\s+/g, ' ').slice(0, 150)
      if (fallback) currentExcerpt.value = fallback
    }
    persistProgress(location)
    // 首次 relocate 是"续读位置本身"，从第二次开始才是真正的阅读位置。
    progressSyncReady = true
  },
  onLoad(doc) {
    // 每次换页 / 换章节都会来一次：先清掉旧监听，再挂新的。
    unbridge?.()
    currentDoc = doc
    unbridge = bridgeSectionDocument(doc, {
      onWheel: (delta) => {
        if (delta > 0) void turnPage('next')
        else void turnPage('prev')
      },
      onKey: (event) => handleKey(event),
      onClick: ({ clientX, innerWidth }) => {
        if (clientX < innerWidth * 0.25) {
          void turnPage('prev')
        } else if (clientX > innerWidth * 0.75) {
          void turnPage('next')
        } else {
          // 点击正文中间区域：切换顶栏/状态栏沉浸式显示与隐藏
          toggleToolbar()
        }
      },
      onSelection: (selection) => {
        // ★ 只把值交给 Vue；Range 是活对象，留在闭包变量里（§5.2 规则 3）。
        selectionRange = selection?.range ?? null
        selectionText.value = selection?.text ?? ''
        if (selection) {
          const visible = Array.from(selection.range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          )
          selectionRectCount.value = visible.length
        } else {
          selectionRectCount.value = 0
        }
        // 选区变化只更新操作条；气泡锚点在点击「翻译」时才算（见 translateSelection）。
        // 选区清空时**不清气泡**：用户正在读译文，清掉会闪。
        // 这里仍然跑一次坐标换算，确保坐标系在真实 DOM 上被验证过（值本身留给点击时用）。
        selectionAnchor()
      },
    })
    applyStyles()
    setTimeout(() => focusReadingArea(), 50)
  },
  onExternalLink(href) {
    if (href) void platform.system.openExternal(href)
  },
  onSanitize(stats) {
    sanitizeSummary.value = `剥离 ${stats.removedElements} 元素 / ${stats.removedAttributes} 属性 / ${stats.removedCssUrls} 条 CSS 外链`
  },
})

const { animClasses, turnPage } = usePageTurnAnimation({
  getAnimation: () => settings.pageTurnAnimation,
  isEinkMode: () => settings.einkMode,
  onNext: () => engine.next(),
  onPrev: () => engine.prev(),
})

function applyStyles(): void {
  engine.setStyles(buildReaderStyles(readerStyleInput()))
}

/**
 * ★ 进度落盘（task-12 的关键验收项）。
 *
 * 走 progressStore 而不是直接 platform：本地是**同步**写 localStorage，
 * 所以"翻页后立刻读得到"这一点在没有任何后端时也成立；
 * platform（Go 的 progress.json / 将来的服务端）是同一次调用的附带效果。
 */
function persistProgress(location: RelocateDetail): void {
  if (!location.cfi || location.cfi === lastSaved) return
  lastSaved = location.cfi
  // 本地优先：localStorage 每次都写（同步、必须成功）。
  rememberProgress(bookId.value, location.cfi, location.fraction, progressBackend.value)
  // 云端：节流后入队（无映射 / 未登录 / 本机书库时自动跳过）。
  applyProgressSync(bookId.value, location)
}

function cycleTheme(): void {
  const index = themeOrder.indexOf(settings.readerTheme)
  settings.setReaderTheme(themeOrder[(index + 1) % themeOrder.length] as ReaderTheme)
}

function handleKey(event: KeyboardEvent): void {
  if (event.key === 'F11') {
    event.preventDefault()
    void toggleFullscreen()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    if (event.shiftKey) {
      bookmarksOpen.value = !bookmarksOpen.value
    } else {
      void toggleBookmark()
    }
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    searchOpen.value = !searchOpen.value
    if (searchOpen.value) {
      aiPanelOpen.value = false
      glossaryOpen.value = false
      bilingualOpen.value = false
      typographyOpen.value = false
    }
    return
  }
  switch (event.key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      event.preventDefault()
      void turnPage('next')
      break
    case 'ArrowLeft':
    case 'PageUp':
      event.preventDefault()
      void turnPage('prev')
      break
    case 'Escape':
      if (bookmarksOpen.value) {
        bookmarksOpen.value = false
        break
      }
      if (searchOpen.value) {
        searchOpen.value = false
        break
      }
      if (typographyOpen.value) {
        typographyOpen.value = false
        break
      }
      if (bilingualOpen.value) {
        bilingualOpen.value = false
        break
      }
      if (ttsOpen.value) {
        tts.stop()
        ttsOpen.value = false
        break
      }
      if (aiPanelOpen.value) {
        aiPanelOpen.value = false
        break
      }
      if (glossaryOpen.value) {
        glossaryOpen.value = false
        break
      }
      if (layout.value.tocMode === 'overlay' && tocOpen.value) {
        tocOpen.value = false
        break
      }
      // 如果顶部状态栏隐藏，按 Escape 呼出状态栏
      if (!toolbarVisible.value) {
        toolbarVisible.value = true
        break
      }
      // 如果全屏，按 Escape 退出全屏
      if (isFullscreen.value) {
        void toggleFullscreen()
        break
      }
      void goBack()
      break
    default:
      break
  }
}

async function goBack(): Promise<void> {
  await engine.close()
  await router.push('/')
}

async function openTocItem(target: string | number): Promise<void> {
  if (layout.value.tocMode === 'overlay') tocOpen.value = false
  await engine.goTo(target)
}

/** 把字节交给引擎；`lastLocation` 失效时自动降级为从头打开，绝不白屏。 */
async function openBytes(file: File, lastLocation: string): Promise<void> {
  try {
    await engine.open(file, lastLocation ? { lastLocation } : {})
  } catch (error) {
    if (!lastLocation) throw error
    console.warn('[reader] 续读位置失效，改为从头打开', error)
    resumedFrom.value = ''
    await engine.open(file)
  }
}

/** 重新打开一本书之前，把本文件的"每本书"状态复位。 */
function resetBookScopedState(): void {
  resumedFrom.value = ''
  remoteResume.value = null
  contentHash = null
  contentHashKnown = false
  lastSaved = ''
  progressSyncReady = false
  progressSync.reset()
}

/**
 * 打开书时的进度解析（task-4 验收项的落点）。
 *
 * 优先级：**云端权威（比本地更远 / 本地无记录） > 本地缓存 > platform**。
 * 解析出结果后立刻回填本地缓存 —— 否则下一次打开又会回到旧位置。
 * 传给 foliate 的始终是字面 locator（我们的本地缓存本来就是 foliate 的 CFI 串）。
 */
async function resolveOpenProgress(bookId: string, hash: string | null): Promise<string> {
  if (!syncBookEligible.value) {
    // 本机书库 / 示例书 / 直接打开的本地文件：不做云端解析，行为与 task-12 完全一致。
    return resolveProgress(bookId, progressBackend.value)
  }

  // 已登录时先跑一次完整同步（推 outbox + 拉到 head），保证投影是新鲜的：
  // 否则刚登录 / 刚换设备时 engine.local 还是空的，云端进度会被漏掉。
  if (isLoggedIn()) {
    try {
      await resolveEngine()?.run()
    } catch (error) {
      // 离线是正常情况：用现有投影 + 本地缓存继续。
      console.warn('[reader] 打开前同步失败，使用本地/现有投影', error)
    }
  }

  const resolved = await resolveReaderProgress({
    bookId,
    contentHash: hash,
    engine: resolveEngine(),
    platform: progressBackend.value,
  })

  if (resolved.source === 'remote') {
    remoteResume.value = resolved.remote
  }
  // 本地缓存 / platform 命中：回填一次（保留原有百分比，platform 命中时按 0 记）。
  if (resolved.locator && resolved.source !== 'remote') {
    cacheResolvedProgress(bookId, resolved.locator)
  }
  return resolved.locator
}

async function loadBook(): Promise<void> {
  loading.value = true
  failed.value = null
  resetBookScopedState()
  try {
    if (isSample.value) {
      // 示例书走 URL：fetch 后转成 File 交给 foliate-js。
      const saved = await resolveOpenProgress(bookId.value, null)
      const res = await fetch('/sample/sample.epub')
      if (!res.ok) throw new Error(`sample.epub: ${res.status}`)
      const blob = await res.blob()
      if (saved) resumedFrom.value = saved
      await openBytes(new File([blob], 'sample.epub', { type: 'application/epub+zip' }), saved)
      return
    }

    let payload = getRememberedBook(bookId.value)
    if (!payload) {
      if (isLocalOnlyBook(bookId.value)) {
        throw new Error(t('reader.empty'))
      }
      payload = await platform.library.openBook(bookId.value)
      rememberBook(payload)
    }
    contentHash = payload.book.contentHash || null
    contentHashKnown = isHexHash(contentHash)

    // ★ 先解析进度，再打开 —— 顺序不能反：foliate 的 init() 只在 open 时接受 lastLocation。
    const saved = await resolveOpenProgress(bookId.value, contentHash)

    // 用 ArrayBuffer 构造 Blob：Uint8Array<ArrayBufferLike> 不满足 BlobPart 的类型要求
    // （它可能是 SharedArrayBuffer 视图），复制成确定的 ArrayBuffer 最稳妥。
    const bytes = new Uint8Array(payload.bytes)
    const file = new File([bytes.buffer as ArrayBuffer], `${payload.book.id}.${payload.book.format || 'epub'}`, {
      type: 'application/epub+zip',
    })
    if (saved) resumedFrom.value = saved
    await openBytes(file, saved)
    void annotations.refresh()
  } catch (error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  }
}

// ★ 横竖屏 / 宽窄屏切换 → 触发引擎重排（防抖）。
watch(() => [layout.value.columns, layout.value.maxMarginInline], reflow)
// 用户在设置里改了字号/页边距/字体/缩进/墨水屏：样式与几何都要重算。
watch(
  () => [
    settings.fontSize,
    settings.lineHeight,
    settings.marginInline,
    settings.fontFamily,
    settings.textIndent,
    settings.einkMode,
  ],
  () => {
    applyStyles()
    reflow()
  },
)
// ★ 换主题（含"夜间模式"按钮）必须重写 iframe 里的样式表：
//   主文档的 data-reader-theme 变化不会自动传播到章节文档。
// flush: 'post' —— data-reader-theme 属性由 stores/settings.ts 的 watcher 写，
// 必须等那一步生效后再 `getComputedStyle` 读变量，否则会读到旧主题的颜色。
watch(
  () => settings.readerTheme,
  () => {
    applyStyles()
  },
  { flush: 'post' },
)
// 宽屏横屏时目录常驻；切回窄屏要把它收起来，免得盖住正文。
watch(() => layout.value.tocMode, (mode, previous) => {
  if (mode === 'overlay' && previous === 'sidebar') tocOpen.value = false
  if (mode === 'sidebar' && previous === 'overlay' && !tocOpen.value) tocOpen.value = true
})

function isInteractiveElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function onWindowKey(event: KeyboardEvent): void {
  // 只要焦点不在输入控件内，按键一律响应（方向键翻页、全屏快捷键等）
  if (isInteractiveElement(event.target)) return
  handleKey(event)
}

function onWindowMouseMove(event: MouseEvent): void {
  // 沉浸模式（顶栏隐藏时），鼠标移至顶部边缘自动呼出
  if (!toolbarVisible.value && event.clientY <= 8) {
    toolbarVisible.value = true
  }
}

onMounted(async () => {
  void loadBook()
  window.addEventListener('keydown', onWindowKey)
  window.addEventListener('mousemove', onWindowMouseMove)

  if (platform.window?.isFullscreen) {
    try {
      isFullscreen.value = await platform.window.isFullscreen()
    } catch {
      // 容错
    }
  }
  if (platform.window?.onFullscreenChanged) {
    cleanupFullscreenWatcher = platform.window.onFullscreenChanged((val) => {
      isFullscreen.value = val
    })
  }

  // 给宿主容器挂载滚轮翻页监听：在文字外围、两侧留白区域滚动鼠标也能翻页
  if (hostRef.value) {
    const hostWheel = createWheelTurnHandler((delta) => {
      if (delta > 0) void turnPage('next')
      else void turnPage('prev')
    })
    const el = hostRef.value
    el.addEventListener('wheel', hostWheel, { passive: false })
    unbindHostWheel = () => el.removeEventListener('wheel', hostWheel)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  window.removeEventListener('mousemove', onWindowMouseMove)
  cleanupFullscreenWatcher?.()
  unbindHostWheel?.()
  tts.stop()
  unbridge?.()
  unbridge = null
  currentDoc = null
  // ★ 离开阅读页前把"最后一页"的进度入队：节流窗口内未发的部分不能丢。
  try {
    if (progressSyncReady) progressSync.flush()
  } catch (error) {
    console.warn('[reader] 退出时进度入队失败（本地已保存）', error)
  }
  void engine.close()
})
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden bg-[var(--reader-paper)]" :data-orientation="layout.orientation">
    <Transition name="toolbar-slide">
      <ReaderToolbar
        v-if="toolbarVisible"
        :chapter="chapterLabel"
        :progress="progress"
        :toc-open="tocOpen"
        :sanitize-summary="sanitizeSummary"
        :compact="layout.compact"
        :orientation="layout.orientation"
        :columns="layout.columns"
        :theme-label="themeLabel"
        :title="t('reader.title')"
        :bookmarked="isBookmarked"
        :bookmarks-open="bookmarksOpen"
        :bookmark-count="bookmarkedItems.length"
        :search-open="searchOpen"
        :typography-open="typographyOpen"
        :bilingual-open="bilingualOpen"
        :tts-open="ttsOpen"
        :ai-open="aiPanelOpen"
        :glossary-open="glossaryOpen"
        :is-fullscreen="isFullscreen"
        @back="goBack"
        @prev="turnPage('prev')"
        @next="turnPage('next')"
        @toggle-toc="tocOpen = !tocOpen"
        @cycle-theme="cycleTheme"
        @toggle-ai="aiPanelOpen = !aiPanelOpen; glossaryOpen = false; bilingualOpen = false; typographyOpen = false; searchOpen = false; bookmarksOpen = false"
        @toggle-glossary="glossaryOpen = !glossaryOpen; aiPanelOpen = false; bilingualOpen = false; typographyOpen = false; searchOpen = false; bookmarksOpen = false"
        @toggle-bilingual="bilingualOpen = !bilingualOpen; aiPanelOpen = false; glossaryOpen = false; typographyOpen = false; searchOpen = false; bookmarksOpen = false"
        @toggle-tts="toggleTts"
        @toggle-typography="typographyOpen = !typographyOpen; aiPanelOpen = false; glossaryOpen = false; bilingualOpen = false; searchOpen = false; bookmarksOpen = false"
        @toggle-search="searchOpen = !searchOpen; aiPanelOpen = false; glossaryOpen = false; bilingualOpen = false; typographyOpen = false; bookmarksOpen = false"
        @toggle-bookmark="toggleBookmark"
        @toggle-bookmarks="bookmarksOpen = !bookmarksOpen; aiPanelOpen = false; glossaryOpen = false; bilingualOpen = false; typographyOpen = false; searchOpen = false"
        @toggle-fullscreen="toggleFullscreen"
      />
    </Transition>

    <div
      class="flex min-h-0 w-full flex-1 transition-[padding] duration-200 ease-in-out"
      :class="toolbarVisible ? 'pt-12' : 'pt-0'"
    >
      <!-- 宽屏横屏：目录常驻侧栏（不覆盖正文），带平滑折叠动画 -->
      <Transition name="toc-sidebar" @after-enter="reflow" @after-leave="reflow">
        <aside
          v-if="layout.tocMode === 'sidebar' && tocOpen"
          data-testid="toc-sidebar"
          class="w-72 shrink-0 overflow-hidden border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 flex flex-col"
        >
          <ReaderDrawer
            v-model:tab="drawerTab"
            :toc="toc"
            :annotations="annotations.items.value"
            :engine="engine"
            :book-title="chapterLabel || t('reader.title')"
            :compact="layout.compact"
            :show-close="false"
            @jump-toc="openTocItem"
            @jump-annotation="(ann) => { void jumpTo(ann.cfi) }"
            @jump-cfi="(cfi) => { void jumpTo(cfi) }"
            @delete-annotation="(ann) => annotations.remove(ann.id)"
            @edit-note="handleEditNote"
          />
        </aside>
      </Transition>

      <!-- 阅读区：必须是有确定尺寸的容器，否则 paginator 算出 0 页 = 白屏 -->
      <div
        ref="hostRef"
        data-testid="reader-host"
        tabindex="-1"
        class="relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none [perspective:1200px]"
        :class="animClasses"
        @click.self="focusReadingArea"
      />
    </div>

    <!-- 窄屏 / 竖屏：目录遮罩层 + 抽屉动画 -->
    <Transition name="fade">
      <div
        v-if="tocOpen && layout.tocMode === 'overlay'"
        data-testid="toc-backdrop"
        class="fixed inset-0 z-20 bg-black/40 backdrop-blur-[1px]"
        @click="tocOpen = false"
      />
    </Transition>
    <Transition name="drawer-slide">
      <aside
        v-if="tocOpen && layout.tocMode === 'overlay'"
        data-testid="toc-overlay"
        class="absolute inset-y-0 left-0 z-30 w-[85vw] max-w-sm overflow-hidden border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-xl flex flex-col"
      >
        <ReaderDrawer
          v-model:tab="drawerTab"
          :toc="toc"
          :annotations="annotations.items.value"
          :engine="engine"
          :book-title="chapterLabel || t('reader.title')"
          :compact="layout.compact"
          :show-close="true"
          @close="tocOpen = false"
          @jump-toc="(target) => { openTocItem(target); tocOpen = false }"
          @jump-annotation="(ann) => { void jumpTo(ann.cfi); tocOpen = false }"
          @jump-cfi="(cfi) => { void jumpTo(cfi); tocOpen = false }"
          @delete-annotation="(ann) => annotations.remove(ann.id)"
          @edit-note="handleEditNote"
        />
      </aside>
    </Transition>

    <!-- 沉浸全屏阅读时的微型底角进度提示（极淡透明度，避免干扰阅读） -->
    <div
      v-if="!toolbarVisible && !loading"
      class="pointer-events-none absolute bottom-2 right-4 z-10 select-none text-[11px] tabular-nums tracking-wider text-[var(--color-text-secondary)] opacity-35"
    >
      {{ chapterLabel ? `${chapterLabel} · ` : '' }}{{ progress }}%
    </div>

    <p
      v-if="loading"
      data-testid="reader-loading"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[var(--reader-paper)] text-sm text-[var(--color-text-secondary)]"
    >
      {{ t('reader.loading') }}
    </p>

    <p
      v-if="failed"
      data-testid="reader-error"
      class="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ t('reader.failed') }}：{{ failed }}
    </p>

    <p
      v-if="resumedFrom && !loading"
      data-testid="reader-resumed"
      class="absolute bottom-3 left-3 z-20 rounded-full bg-[var(--color-surface-raised)]/90 px-3 py-1 text-xs text-[var(--color-text-secondary)] shadow"
    >
      <!-- ★ task-4：位置来自云端权威进度时明确告知（多设备用户的关键反馈）。 -->
      <span v-if="remoteResume" data-testid="reader-resumed-cloud" class="mr-1" aria-hidden="true">☁</span>
      {{ t('reader.resumed', { n: progress }) }}
    </p>

    <!-- 排版与翻页动画设置 Popover (Aa) -->
    <div
      v-if="typographyOpen"
      class="fixed inset-0 z-20"
      @click="typographyOpen = false"
    />
    <ReaderSettingsPopover
      :open="typographyOpen"
      @close="typographyOpen = false"
    />

    <!-- 双语对照面板 (⇄ 译) -->
    <BilingualView
      v-if="bilingualOpen"
      :book-id="bookId"
      :current-chapter-index="currentChapterIndex"
      @jump-to-chapter="(idx) => jumpTo(idx)"
      @close="bilingualOpen = false"
    />

    <!-- TTS 朗读播放条 (🔊) -->
    <TtsPlayer
      v-if="ttsOpen"
      :status="tts.status.value"
      :rate="tts.rate.value"
      :text="tts.currentText.value || getCurrentReadableText()"
      @play="startTts"
      @pause="tts.pause()"
      @resume="tts.resume()"
      @stop="tts.stop()"
      @update:rate="(r) => (tts.rate.value = r)"
      @close="tts.stop(); ttsOpen = false"
    />

    <!-- 搜索面板 (🔍) -->
    <div
      v-if="searchOpen"
      class="fixed inset-0 z-20"
      @click="searchOpen = false"
    />
    <div
      v-if="searchOpen"
      class="absolute left-2 sm:left-4 top-14 z-30 flex max-h-[calc(100vh-4.5rem)] w-[min(92vw,24rem)] flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl overflow-hidden"
    >
      <ReaderSearchPanel
        :open="searchOpen"
        :engine="engine"
        :compact="layout.compact"
        @jump="(cfi) => jumpTo(cfi)"
        @close="searchOpen = false"
      />
    </div>

    <!-- 书签查看与管理 Popover (★ / 🔖) -->
    <div
      v-if="bookmarksOpen"
      class="fixed inset-0 z-20"
      @click="bookmarksOpen = false"
    />
    <ReaderBookmarksPopover
      :open="bookmarksOpen"
      :bookmarks="bookmarkedItems"
      :current-cfi="currentCfi"
      :current-chapter="chapterLabel"
      :is-current-bookmarked="isBookmarked"
      @close="bookmarksOpen = false"
      @jump="(b) => { void jumpTo(b.cfi); bookmarksOpen = false }"
      @delete="(b) => void annotations.remove(b.id)"
      @toggle-current="toggleBookmark"
      @update-note="(b, note) => void annotations.update(b.id, { note })"
    />

    <!-- 整书翻译面板 -->
    <BookTranslatePanel
      v-if="aiPanelOpen"
      :book-id="bookId"
      :book-title="chapterLabel || t('reader.title')"
      @close="aiPanelOpen = false"
    />

    <!-- 术语表面板 -->
    <GlossaryPanel
      v-if="glossaryOpen"
      :book-id="bookId"
      :target-lang="targetLang"
      @close="glossaryOpen = false"
    />

    <!-- 划词操作条：选区存在时出现（竖屏也不挡正文） -->
    <div
      v-if="selectionText"
      data-testid="selection-bar"
      class="absolute bottom-3 right-3 z-20 flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs shadow"
    >
      <span class="max-w-[40ch] truncate">{{ t('reader.selected', { n: selectionText.length }) }}</span>
      <button
        type="button"
        data-testid="selection-translate"
        class="rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-white"
        @click="translateSelection"
      >
        {{ t('ai.translate') }}
      </button>
      <button type="button" class="rounded px-2 py-1 text-xs" @click="copySelection">
        {{ t('reader.copy') }}
      </button>
    </div>

    <!-- 划词翻译气泡（task-23）：跟随选区，流式显示译文 -->
    <TranslateBubble
      v-if="bubbleAnchor"
      :anchor="bubbleAnchor"
      :source="selectionText"
      :status="selectionTranslate.status.value"
      :text="selectionTranslate.text.value"
      :error-text="selectionTranslate.errorText.value"
      :quota-message="selectionTranslate.quotaMessage.value"
      @translate="translateSelection"
      @cancel="selectionTranslate.cancel()"
      @retry="translateSelection"
      @close="closeBubble"
    />
  </div>
</template>

<style scoped>
/* 宽屏侧边栏折叠/展开动画 */
.toc-sidebar-enter-active,
.toc-sidebar-leave-active {
  transition: width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease, padding 0.25s ease;
  overflow: hidden;
  white-space: nowrap;
}
.toc-sidebar-enter-from,
.toc-sidebar-leave-to {
  width: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  opacity: 0;
  border-right-width: 0 !important;
}

/* 窄屏抽屉滑入滑出动画 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* 顶部状态栏/工具栏滑入滑出动画 */
.toolbar-slide-enter-active,
.toolbar-slide-leave-active {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.toolbar-slide-enter-from,
.toolbar-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

/* 通用淡入淡出遮罩 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>