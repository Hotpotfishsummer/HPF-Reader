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
import { usePlatform } from '@/platform'
import { SAMPLE_BOOK_ID, getRememberedBook, isLocalOnlyBook, rememberBook } from './bookSession'
import { useFoliateEngine, type RelocateDetail } from './useFoliateEngine'
import { useReaderLayout, COLUMN_GAP_PERCENT } from './useReaderLayout'
import { bridgeSectionDocument } from './bridge'
import { anchorFromRange } from './coords'
import { buildReaderStyles, resolveReaderTokens } from './readerStyles'
import { resolveProgress, rememberProgress } from './progressStore'
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
/** AI 面板开关（互斥：同时只开一个，避免叠在一起看不清）。 */
const aiPanelOpen = ref(false)
const glossaryOpen = ref(false)
const sanitizeSummary = ref('')
const selectionRectCount = ref(0)
/** 续读提示：只在"确实从上次位置继续"时显示一次。 */
const resumedFrom = ref('')

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

function readerStyleInput() {
  // ★ 必须解析成具体值：CSS 变量不跨文档继承，直接写 var(...) 进 iframe 会静默失效。
  const tokens = resolveReaderTokens()
  return {
    fontFamily: tokens.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: 0.01,
    marginBlock: 32,
    paper: tokens.paper,
    ink: tokens.ink,
    textIndent: false,
  }
}

/**
 * ★ 把"窗口尺寸"翻译成 engine 的几何参数（task-12 §3）。
 *
 * 真实的页边距取 `min(用户设置, 当前窗口允许的最大值)`：用户偏好优先，
 * 但竖屏窄窗下不能让页边距把正文挤没。
 */
function applyLayout(): void {
  const state = layout.value
  engine.setLayout({
    columns: state.columns,
    maxInlineSize: state.maxInlineSize,
    marginInline: Math.min(settings.marginInline, state.maxMarginInline),
    columnGapPercent: COLUMN_GAP_PERCENT,
  })
  // 分栏数与单栏宽度都变了，重排后把阅读位置拉回去（不丢位置）。
  if (lastCfi) {
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
  },
  onError(error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  },
  onRelocate(location: RelocateDetail) {
    progress.value = Math.round(location.fraction * 100)
    chapterLabel.value = location.tocLabel
    if (location.cfi) lastCfi = location.cfi
    persistProgress(location)
  },
  onLoad(doc) {
    // 每次换页 / 换章节都会来一次：先清掉旧监听，再挂新的。
    unbridge?.()
    currentDoc = doc
    unbridge = bridgeSectionDocument(doc, {
      onWheel: (delta) => {
        if (delta > 0) void engine.next()
        else void engine.prev()
      },
      onKey: (event) => handleKey(event),
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
  },
  onExternalLink(href) {
    if (href) void platform.system.openExternal(href)
  },
  onSanitize(stats) {
    sanitizeSummary.value = `剥离 ${stats.removedElements} 元素 / ${stats.removedAttributes} 属性 / ${stats.removedCssUrls} 条 CSS 外链`
  },
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
  rememberProgress(bookId.value, location.cfi, location.fraction, progressBackend.value)
}

function cycleTheme(): void {
  const index = themeOrder.indexOf(settings.readerTheme)
  settings.setReaderTheme(themeOrder[(index + 1) % themeOrder.length] as ReaderTheme)
}

function handleKey(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      event.preventDefault()
      void engine.next()
      break
    case 'ArrowLeft':
    case 'PageUp':
      event.preventDefault()
      void engine.prev()
      break
    case 'Escape':
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

async function loadBook(): Promise<void> {
  loading.value = true
  failed.value = null
  try {
    // ★ 先解析进度，再打开 —— 顺序不能反：foliate 的 init() 只在 open 时接受 lastLocation。
    const saved = await resolveProgress(bookId.value, progressBackend.value)

    if (isSample.value) {
      // 示例书走 URL：fetch 后转成 File 交给 foliate-js。
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
    // 用 ArrayBuffer 构造 Blob：Uint8Array<ArrayBufferLike> 不满足 BlobPart 的类型要求
    // （它可能是 SharedArrayBuffer 视图），复制成确定的 ArrayBuffer 最稳妥。
    const bytes = new Uint8Array(payload.bytes)
    const file = new File([bytes.buffer as ArrayBuffer], `${payload.book.id}.${payload.book.format || 'epub'}`, {
      type: 'application/epub+zip',
    })
    if (saved) resumedFrom.value = saved
    await openBytes(file, saved)
  } catch (error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  }
}

// ★ 横竖屏 / 宽窄屏切换 → 触发引擎重排（防抖）。
watch(() => [layout.value.columns, layout.value.maxMarginInline], reflow)
// 用户在设置里改了字号/页边距：样式与几何都要重算。
watch(() => [settings.fontSize, settings.lineHeight, settings.marginInline], () => {
  applyStyles()
  reflow()
})
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

onMounted(() => {
  void loadBook()
  // 主文档也要挂键盘监听：iframe 被替换的瞬间焦点会丢。
  window.addEventListener('keydown', onWindowKey)
})

function onWindowKey(event: KeyboardEvent): void {
  // 焦点在 iframe 里时由 bridge 处理；这里是兜底，避免"快捷键偶尔失灵"。
  if (event.target === document.body || event.target === document.documentElement) {
    handleKey(event)
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  unbridge?.()
  unbridge = null
  currentDoc = null
  void engine.close()
})
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden" :data-orientation="layout.orientation">
    <ReaderToolbar
      :chapter="chapterLabel"
      :progress="progress"
      :toc-open="tocOpen"
      :sanitize-summary="sanitizeSummary"
      :compact="layout.compact"
      :orientation="layout.orientation"
      :columns="layout.columns"
      :theme-label="themeLabel"
      :title="t('reader.title')"
      @back="goBack"
      @prev="engine.prev()"
      @next="engine.next()"
      @toggle-toc="tocOpen = !tocOpen"
      @cycle-theme="cycleTheme"
      @toggle-ai="aiPanelOpen = !aiPanelOpen; glossaryOpen = false"
      @toggle-glossary="glossaryOpen = !glossaryOpen; aiPanelOpen = false"
    />

    <div class="flex min-h-0 w-full flex-1 pt-12">
      <!-- 宽屏横屏：目录常驻侧栏（不覆盖正文），可折叠 -->
      <aside
        v-if="layout.tocMode === 'sidebar' && tocOpen"
        data-testid="toc-sidebar"
        class="w-64 shrink-0 overflow-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
      >
        <h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('reader.toc') }}
        </h2>
        <ul class="space-y-0.5">
          <li v-for="item in toc" :key="item.label + String(item.target)">
            <button
              type="button"
              class="w-full rounded px-2 py-1 text-left text-sm leading-snug text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
              @click="openTocItem(item.target)"
            >
              {{ item.label }}
            </button>
          </li>
        </ul>
      </aside>

      <!-- 阅读区：必须是有确定尺寸的容器，否则 paginator 算出 0 页 = 白屏 -->
      <div ref="hostRef" data-testid="reader-host" class="relative min-h-0 min-w-0 flex-1" />
    </div>

    <!-- 窄屏 / 竖屏：目录走覆盖层，不挤压正文宽度 -->
    <aside
      v-if="tocOpen && layout.tocMode === 'overlay'"
      data-testid="toc-overlay"
      class="absolute inset-y-0 left-0 z-20 w-[80vw] max-w-xs overflow-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-xl"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold">{{ t('reader.toc') }}</h2>
        <button type="button" class="rounded px-2 py-1 text-sm" @click="tocOpen = false">✕</button>
      </div>
      <ul class="space-y-1">
        <li v-for="item in toc" :key="item.label + String(item.target)">
          <button
            type="button"
            class="w-full rounded px-2 py-1 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
            @click="openTocItem(item.target)"
          >
            {{ item.label }}
          </button>
        </li>
      </ul>
    </aside>

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
      {{ t('reader.resumed', { n: progress }) }}
    </p>

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