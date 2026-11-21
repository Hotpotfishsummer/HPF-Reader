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
import { cancelPageTurnCue, pageTurnCue } from '@/app/motion'
import { SAMPLE_BOOK_ID, getRememberedBook, isLocalOnlyBook, rememberBook } from './bookSession'
import { useFoliateEngine, type RelocateDetail } from './useFoliateEngine'
import { COLUMN_GAP_PERCENT, MAX_INLINE_SIZE, maxMarginFor, useReaderLayout } from './useReaderLayout'
import { useReaderReflow, type ReflowGeometry } from './useReaderReflow'
import { bridgeSectionDocument, type TapInfo } from './bridge'
import { anchorFromRange } from './coords'
import { buildReaderStyles, resolveReaderTokens } from './readerStyles'
import { resolveProgress, rememberProgress } from './progressStore'
import ReaderToolbar from './components/ReaderToolbar.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const platform = usePlatform()
const settings = useSettingsStore()

/**
 * ★ 阅读面的实测尺寸（不是窗口尺寸）。
 *
 * 排版要按**正文实际能用的宽度**算：宽屏下目录侧栏常驻会吃掉 256px，
 * 窄屏下还有页边距。用 window.innerWidth 决定"两栏还是单栏"会把两条
 * 400px 的窄栏塞给人读（这是改造前真实存在的判断错误）。
 *
 * 尺寸由 useReaderReflow 的 ResizeObserver 观测后回填（见 onSize）。
 */
const surfaceSize = ref({ width: 0, height: 0 })
const layout = useReaderLayout(surfaceSize)

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
/**
 * 阅读器根盒：状态栏"光标靠近顶部"的监听挂在这里（工具栏收起后自身不可命中），
 * 也用它缓存根盒顶边（viewTop）。
 */
const rootRef = useTemplateRef<HTMLElement>('rootRef')
const loading = ref(true)
const failed = ref<string | null>(null)
const toc = shallowRef<{ label: string; target: string | number }[]>([])
const progress = ref(0)
const chapterLabel = ref('')
// ★ 目录现在**默认收起**：改造前宽屏（tocMode === 'sidebar'）会直接展开，
//   结果"一调整窗口就又弹出来"，小屏幕上尤其挡正文。现在开合完全由用户决定。
const tocOpen = ref(false)

/** AI 面板开关（互斥：同时只开一个，避免叠在一起看不清）。 */
const aiPanelOpen = ref(false)
const glossaryOpen = ref(false)
const sanitizeSummary = ref('')

/**
 * 顶部状态栏显隐（本次动线优化）。
 *
 * 三种展开方式：
 *   ① 桌面端：光标靠近阅读面顶部自动展开，离开后自动折叠；
 *   ② 移动端：双击正文显示区域切换；
 *   ③ pin（常驻）：不再自动折叠，由工具栏上的 pin 开关控制。
 * 默认**收起**，把整个阅读面完整交给正文。
 */
const barVisible = ref(false)
/** 状态栏常驻开关：从设置读写，由工具栏的 pin 按钮切换并持久化。 */
const barPinned = ref(settings.statusBarPinned)
/**
 * 状态栏的实际渲染条件：pin 时无视 barVisible —— 常驻就是常驻，
 * 光标怎么动都不许把它收掉。
 */
const barShown = computed(() => barPinned.value || barVisible.value)
/** 有浮层打开时栏不许自动收起（否则刚点开目录，栏一收就把入口挡了）。 */
const chromeLocked = computed(
  () =>
    (layout.value.tocMode === 'overlay' && tocOpen.value) || aiPanelOpen.value || glossaryOpen.value,
)
/** 续读提示：只在"确实从上次位置继续"时显示一次。 */
const resumedFrom = ref('')
/** 排版是否处于"拖动中冻结"状态（供 E2E / 调试观测）。 */
const frozen = ref(false)
/**
 * 续读提示是否已被自动收起。
 *
 * ★ 以前这个提示会一直挂在左下角不消失：小屏幕上正好压在正文上，而且它带
 *   `hpf-press cursor-default`，看着像能点、实际点了没反应。现在改成停留一段时间后
 *   自动消失，并加 `pointer-events-none`（它只做一次性告知，不承载交互，不该挡住正文）。
 */
const resumeHintDismissed = ref(false)
/** 续读提示停留时长：够看清，又不会长期占地方。 */
const RESUME_HINT_MS = 4_000

/**
 * ★ 当前章节文档：仅用于挂监听与算坐标（coords.ts 需要它）。
 * 它是 DOM 节点，**绝不**进响应式状态 —— 放闭包普通变量。
 */
let currentDoc: Document | null = null
let unbridge: (() => void) | null = null
let lastSaved = ''
/** 续读提示的自动收起计时器（出现时起、到点停）。 */
let resumeHintTimer: ReturnType<typeof setTimeout> | undefined
/** 状态栏自动收起的计时器（光标离开顶部后起、到点停）。 */
let barHideTimer: ReturnType<typeof setTimeout> | undefined
/**
 * 触屏单击的延迟计时器：等一个短间隔确认没有第二次点击（双击切状态栏）再执行。
 * @see handleTap
 */
let pendingTap: ReturnType<typeof setTimeout> | null = null
/** 阅读面根盒顶边的缓存（状态栏"光标靠近顶部"的判定基准），由 RO 刷新。 */
let viewTop = 0
/** 阅读面根盒的观察器：根盒尺寸变化时刷新顶边缓存。 */
let viewObserver: ResizeObserver | null = null

/** 最近一次 relocate 的 CFI：换屏/旋转后用它把阅读位置拉回来。 */
let lastCfi = ''
/** 已经真正写进章节文档的字号（用于把滑杆的中途值折算成"缩放预览"）。 */
let appliedFontSize = settings.fontSize

/** 划词结果：只把"值"交给 Vue（文本 + 可见矩形数），Range 本身留在闭包里。 */
const selectionText = ref('')
let selectionRange: Range | null = null
/** 选区锚点（主文档视口坐标）：划词操作条要贴着选区出现，而不是永远缩在右下角。 */
const selectionAnchorPoint = ref<{ left: number; top: number } | null>(null)

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

/** 墨水屏：翻页提示这类"动效"会在电子墨水屏上留残影，直接关掉。 */
const cueEnabled = computed(() => settings.readerTheme !== 'ink')

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
  selectionAnchorPoint.value = null
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
 * ★ 把"阅读面尺寸 + 用户偏好"翻译成 engine 的几何参数（task-12 §3）。
 *
 * 真实的页边距取 `min(用户设置, 当前可用宽度允许的最大值)`：用户偏好优先，
 * 但竖屏窄窗下不能让页边距把正文挤没。
 */
function currentGeometry(): ReflowGeometry {
  const { columns } = layout.value
  return {
    columns,
    maxInlineSize: MAX_INLINE_SIZE,
    marginInline: Math.min(settings.marginInline, maxMarginFor(surfaceSize.value.width)),
    columnGapPercent: COLUMN_GAP_PERCENT,
  }
}

/** 把几何写进 paginator（会触发一次重排）。**不要**在这里顺带重写样式表。 */
function applyGeometry(geometry: ReflowGeometry): void {
  engine.setLayout(geometry)
}

/** 重排后把阅读位置拉回（旋转 / 换屏 / 侧栏开合都不丢位置）。 */
function restorePosition(): void {
  if (!lastCfi) return
  void engine.goTo(lastCfi).catch(() => {
    // 位置在当前屏已经不存在（例如旋转后落在最后一页之外）：忽略，
    // paginator 自己的 #anchor 机制会把位置夹到最近的有效页。
  })
}

function applyStyles(): void {
  // 记录"已经落定的字号"，下次滑杆变化时用它折算缩放比例。
  appliedFontSize = settings.fontSize
  engine.setStyles(buildReaderStyles(readerStyleInput()))
}

/** 用阅读面当前的实际像素尺寸作为排版初值（首次测量前不能靠窗口宽度猜）。 */
function seedSurfaceSize(): void {
  const el = hostRef.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width > 0 && height > 0) surfaceSize.value = { width, height }
}

/**
 * ★ 图片占位：降低单章大文档初排时的布局反馈循环（profile 证据定位的根因）。
 *
 * 根因：foliate-js 的 Paginator 用 ResizeObserver 观察 **iframe 内的 doc.body**，
 * 图片加载过程中 doc.body 内容高度不断变化 → RO 触发 → `expand()` →
 * `getBoundingClientRect` 强制同步布局 → 单章大书时 expand 被调用上百次，
 * 累计数百毫秒（CPU profile 里 `expand` + `getBoundingClientRect` 占 JS 开销最大头）。
 *
 * 做法：给图片设置 `aspect-ratio`（宽高比占位），让图片在加载前后占据一致的
 * 空间，加载完成不再引起布局跳动，从而减少 RO→expand 的触发次数。
 *   - 已加载的图片直接读 natural 尺寸设宽高比；
 *   - 未加载的用 `decode()` 异步补设（decode 不阻塞主线程）；
 *   - `decoding="async"` 避免图片解码阻塞主线程长任务。
 *
 * 注意：这是**降低布局跳动次数**，不改变图片最终显示尺寸（仍由 foliate-js 的
 * setImageSize 的 max-height/max-width 约束）。
 */
function stabilizeImages(doc: Document): void {
  const imgs = doc.querySelectorAll('img')
  for (const img of imgs) {
    img.setAttribute('decoding', 'async')
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
      continue
    }
    // 未加载：异步解码后补设宽高比占位。失败（非图片资源等）就忽略。
    void img.decode().then(() => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
      }
    }).catch(() => {})
  }
}

const engine = useFoliateEngine(() => hostRef.value, {
  onReady(book) {
    loading.value = false
    toc.value = (book.toc ?? []).map((item) => ({ label: item.label, target: item.href }))
    seedSurfaceSize()
    applyStyles()
    applyGeometry(currentGeometry())
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
    unbridge = bridgeSectionDocument(
      doc,
      {
        onWheel: (delta) => {
          void turn(delta > 0 ? 'next' : 'prev')
        },
        onKey: (event) => handleKey(event),
        onSelection: (selection) => {
          // ★ 只把值交给 Vue；Range 是活对象，留在闭包变量里（§5.2 规则 3）。
          selectionRange = selection?.range ?? null
          selectionText.value = selection?.text ?? ''
          // 选区变化只更新操作条；气泡锚点在点击「翻译」时才算（见 translateSelection）。
          // 选区清空时**不清气泡**：用户正在读译文，清掉会闪。
          // selectionchange 在拖拽划词时每帧都会来，所以这里**只算一次**坐标
          // （改造前分别算了 getClientRects 与 anchorFromRange，等于两遍）。
          selectionAnchorPoint.value = selection ? selectionAnchor() : null
        },
        onTap: (tap) => handleTap(tap),
        // ★ 触屏双击正文：切换顶部状态栏。桌面端不响应（状态栏由光标靠近触发，
        //   不抢"双击选词"的语义）。
        onDoubleTap: (pointerType) => {
          if (pointerType !== 'mouse') toggleBar()
        },
        // ★ 光标在正文里移动时，由 bridge 把页面纵坐标报回来做"靠近顶部自动展开"
        //   （iframe 内的 pointermove 不会冒泡到主文档，主文档自己收不到）。
        onHover: (pageY) => onBarHover(pageY),
      },
      // ★ 热区按阅读面算：分栏排版下 iframe 视口是整章展开宽，不传它热区会整段错位。
      { surface: () => hostRef.value },
    )
    applyStyles()
    // ★ 图片占位：降低单章大文档初排的布局反馈循环（见 stabilizeImages 注释）。
    stabilizeImages(doc)
  },
  onExternalLink(href) {
    if (href) void platform.system.openExternal(href)
  },
  onSanitize(stats) {
    sanitizeSummary.value = `剥离 ${stats.removedElements} 元素 / ${stats.removedAttributes} 属性 / ${stats.removedCssUrls} 条 CSS 外链`
  },
})

/**
 * ★ 重排调度器：拖动窗口/侧栏开合/字号滑杆时**不再逐帧重排**。
 * 逐帧重排的实测成本是 7.5ms/步（吃满一整帧 120Hz 预算），
 * 具体机制与取舍见 useReaderReflow.ts 顶部注释。
 */
const reflow = useReaderReflow({
  surface: () => hostRef.value,
  geometry: () => currentGeometry(),
  applyLayout: (geometry) => applyGeometry(geometry),
  applyStyles: () => applyStyles(),
  restore: () => restorePosition(),
  onSize: (width, height) => {
    const previous = surfaceSize.value
    if (previous.width !== width || previous.height !== height) {
      surfaceSize.value = { width, height }
    }
  },
  onFreezeChange: (value) => {
    frozen.value = value
    // 开始冻结时把翻页提示停掉，避免两套 transform 叠在一起。
    if (value) cancelPageTurnCue(hostRef.value)
  },
  enabled: () => !loading.value && engine.ready.value,
  // 电子墨水屏不跟随缩放（拖影比"慢一点"更难接受）。
  allowFreeze: () => settings.readerTheme !== 'ink',
})

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

/**
 * ★ 翻页的唯一入口（工具栏 / 键盘 / 滚轮 / 点击热区共用）。
 *
 * 两件事必须集中做：
 *   1. 排版冻结期间不翻页 —— 那会儿分栏正在变，翻页会落在"错误的一页"上再被拉回；
 *   2. 翻完给一次方向提示（合成层动效），把 scrollLeft 的跳变"盖住"。
 */
async function turn(direction: 'next' | 'prev'): Promise<void> {
  // ★ 键位/滚轮/工具栏这类"明确"的翻页动作，要把触屏单击的延迟动作丢掉：
  //   否则用户已经明确要翻页，那个待定的点击还会在 220ms 后再执行一次。
  clearPendingTap()
  if (reflow.frozen()) return
  if (direction === 'next') await engine.next()
  else await engine.prev()
  if (cueEnabled.value) pageTurnCue(hostRef.value, direction)
}

/** 取消触屏单击的延迟动作（双击切状态栏、或已改为明确翻页时调用）。 */
function clearPendingTap(): void {
  if (pendingTap === null) return
  clearTimeout(pendingTap)
  pendingTap = null
}

function handleKey(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
      event.preventDefault()
      void turn('next')
      break
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      event.preventDefault()
      void turn('prev')
      break
    case 'Escape':
      event.preventDefault()
      // ★ 分层关闭：先收掉浮层，收无可收才退出阅读。
      //   改造前 Escape 直接返回书库 —— 目录开着的时候按 Esc 会连书一起关掉。
      if (!dismissTopLayer()) void goBack()
      break
    default:
      break
  }
}

/** 关掉"最上面一层"临时 UI。@returns 是否关掉了东西 */
function dismissTopLayer(): boolean {
  if (bubbleAnchor.value) {
    closeBubble()
    return true
  }
  if (aiPanelOpen.value) {
    aiPanelOpen.value = false
    return true
  }
  if (glossaryOpen.value) {
    glossaryOpen.value = false
    return true
  }
  if (tocOpen.value && layout.value.tocMode === 'overlay') {
    tocOpen.value = false
    return true
  }
  // ★ 状态栏也按"临时浮层"处理：点正文先收掉它，别让它挡着翻页热区。
  if (barVisible.value) {
    barVisible.value = false
    return true
  }
  return false
}

/**
 * ★ 章节正文里的单击（由 bridge 从 iframe 内转发过来）。
 *
 * 动线设计：**先收浮层，再翻页**。
 * 原来点正文既不能翻页也不能关面板 —— 想收起 AI 面板必须精准点到右上角那个 ✕。
 * 现在「点一下正文」= 关掉挡在正文上的东西；没有东西可关时按横向位置翻页。
 */
function handleTap(tap: TapInfo): void {
  // ★ 单击要做的两件事（收浮层 / 按位置翻页）合成**一个动作**。
  //   触屏时整个动作延后执行，这样双击的**第一次**点击不会先把浮层收掉、也不会先翻页 ——
  //   「想双击切状态栏，结果先把状态栏关了 / 先翻了一页」就是这么来的。
  //   鼠标不延后（桌面端没有"双击切状态栏"这条路），保持即时响应。
  const act = (): void => {
    if (dismissTopLayer()) return
    const direction = tap.ratioX < 0.28 ? 'prev' : tap.ratioX > 0.72 ? 'next' : null
    if (direction) void turn(direction)
  }

  if (tap.pointerType === 'touch' || tap.pointerType === 'pen') {
    clearPendingTap()
    pendingTap = setTimeout(() => {
      pendingTap = null
      act()
    }, DOUBLE_TAP_MS)
    return
  }
  act()
}

/**
 * ★ 阅读面**内边距**上的点击兜底（翻页热区补漏）。
 *
 * 探针实测：foliate-js 给分栏容器加了左右 `gap/2` 的内边距（paginator.js:322），
 * 于是阅读面最左/最右约 36px 落在 iframe **之外** —— 点那里不会冒泡进章节文档，
 * `bridge` 的 `onTap` 收不到，翻页热区就漏掉了边缘一窄条（而那恰恰是"点边角翻页"
 * 最常点的位置）。
 *
 * 点在 iframe 内时事件**不会**冒泡到宿主，所以这个监听只会收到"点在阅读面盒子上"
 * 的那部分，不会和 bridge 的 onTap 重复触发。
 */
function onSurfaceClick(event: MouseEvent): void {
  if (event.button !== 0) return
  // ★ 双击（触屏上双击内边距也算）：切换顶部状态栏，与 bridge 的 onDoubleTap 同一语义。
  if (event.detail > 1) {
    toggleBar()
    return
  }
  const el = hostRef.value
  if (!el) return
  const box = el.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return
  // Chromium 里 click 都是 PointerEvent，能拿到真实 pointerType。
  // ★ 触屏必须如实上报：handleTap 靠它决定"单击要不要延后"。若这里一律报 mouse，
  //   内边距上的双击第一次点击就会先把状态栏收掉，第二次再切回来 —— 看起来像没反应。
  const pointerType: TapInfo['pointerType'] =
    event instanceof PointerEvent && (event.pointerType === 'touch' || event.pointerType === 'pen')
      ? event.pointerType
      : 'mouse'
  handleTap({
    ratioX: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    ratioY: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    pointerType,
  })
}

/**
 * 顶部状态栏的动线控制（本次优化）。
 *
 * 为什么监听挂在**阅读器根盒**而不是工具栏上：工具栏默认是收起的，收起来之后
 * 它根本不在可点范围内，"光标靠近顶部"的信号只能由根盒来收。
 *
 * ★ iframe 是 DOM 里的"洞"：指针落在正文上时，宿主的 pointermove 收不到
 *   （事件不冒泡出 iframe）。所以正文内的靠近判定由 bridge 的 onHover 报回来
 *   （见 bridge.ts 的 pointerPageY），这里只处理工具栏 / 侧栏 / 内边距这些宿主区域。
 */

/** 触屏单击翻页前的等待窗口：给"双击切状态栏"留出第二次点击的机会。 */
const DOUBLE_TAP_MS = 220
/** 桌面端光标离阅读面顶边多近（px）时展开状态栏。 */
const NEAR_TOP_PX = 64
/** 光标离开顶部后，再等多久才折叠（ms）：短了容易闪。 */
const HIDE_DELAY_MS = 420

function clearBarHideTimer(): void {
  if (barHideTimer) clearTimeout(barHideTimer)
  barHideTimer = undefined
}

/** 展开状态栏，并取消"即将折叠"的计时（光标在顶部时不许它自己收）。 */
function showBar(): void {
  clearBarHideTimer()
  barVisible.value = true
}

/**
 * 安排一次折叠。
 *
 * ★ 用延迟而不是立刻收：光标从正文挪到工具栏按钮时会短暂跨过留白，
 *   立刻收会让按钮在指尖下消失。pin / 有浮层打开时直接不安排。
 */
function scheduleHideBar(): void {
  if (barPinned.value || chromeLocked.value) return
  clearBarHideTimer()
  barHideTimer = setTimeout(() => {
    barHideTimer = undefined
    if (barPinned.value || chromeLocked.value) return
    barVisible.value = false
  }, HIDE_DELAY_MS)
}

/**
 * 显式切换状态栏（移动端双击正文 / 宿主区域内边距双击）。
 *
 * pin 时直接返回：常驻就是常驻，双击不该把它收掉，否则"常驻"名不副实
 * （要取消常驻请点工具栏上的 pin 按钮）。
 */
function toggleBar(): void {
  clearPendingTap()
  if (barPinned.value) return
  clearBarHideTimer()
  barVisible.value = !barVisible.value
}

/**
 * 指针纵坐标的靠近判定（正文内的坐标由 bridge 转发，宿主的由根盒监听）。
 * @param pageY 页面坐标系下的指针 Y
 */
function onBarHover(pageY: number): void {
  if (barPinned.value) return
  // viewTop 有缓存但不常变：尺寸变化由 RO 刷新，滚动不会改变根盒顶边。
  if (pageY - viewTop <= NEAR_TOP_PX) showBar()
  else scheduleHideBar()
}

/** 根盒上的指针移动（只覆盖工具栏 / 侧栏 / 内边距这些宿主区域）。 */
function onRootPointerMove(event: PointerEvent): void {
  // 触屏没有"悬停"，靠近展开在触屏上没有意义（那条路由双击负责）。
  if (event.pointerType === 'touch') return
  onBarHover(event.clientY)
}

/** 指针离开阅读器：别让状态栏一直亮着。 */
function onRootPointerLeave(): void {
  scheduleHideBar()
}

/** pin 按钮：切换常驻并持久化。 */
function togglePinBar(): void {
  barPinned.value = !barPinned.value
  settings.setStatusBarPinned(barPinned.value)
  clearBarHideTimer()
  if (barPinned.value) barVisible.value = true
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

/**
 * 字号滑杆：**逐帧缩放预览**，松手才真正重排。
 *
 * 字号 18→20 时 `scale(20/18)` 的视觉效果和真实改字号一致，
 * 所以拖滑杆的过程可以完全走合成层（零重排），落定时再一次性把新字号写进章节文档。
 * 改造前是 150ms 防抖重排 —— 滑杆拖起来正文"一跳一跳"。
 */
watch(
  () => settings.fontSize,
  (next) => {
    if (loading.value) return
    const factor = appliedFontSize > 0 ? next / appliedFontSize : 1
    reflow.previewScale(factor, true)
  },
)

/**
 * 行高 / 页边距没法用缩放等价表达（行高是"行间距离"，页边距是"留白"，
 * 等比缩放会连字号一起改），所以走短防抖直接重排：90ms 一次，
 * 比改造前的 150ms 明显跟手，又不会每帧重排。
 */
const reflowForTypography = useDebounceFn(() => {
  if (loading.value) return
  reflow.reflowNow(true)
}, 90)

watch(() => [settings.lineHeight, settings.marginInline], reflowForTypography)

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
/**
 * 目录只做**单向**收敛：从常驻侧栏切到浮层时把它收起来，免得浮层盖住正文。
 *
 * ★ 反向（overlay → sidebar）**故意不自动展开**。改造前这里会自动 `tocOpen = true`，
 *   于是每次把窗口拖宽、旋转屏幕，目录都会"自己弹出来" —— 用户抱怨的正是这个
 *   「一调整窗口就又弹出来」。目录的开合现在只由用户点击决定。
 */
watch(() => layout.value.tocMode, (mode, previous) => {
  if (mode === 'overlay' && previous === 'sidebar') tocOpen.value = false
})

/**
 * 续读提示：出现后停留 RESUME_HINT_MS 自动消失（改造前会一直挂着）。
 *
 * ★ 之所以给到 4s：这条提示是"我从上次位置继续了"的唯一反馈，太短根本没人看见；
 *   但它只承担告知，不能长期占住正文（小屏幕上尤其挡字）。
 */
watch([resumedFrom, loading], ([value, isLoading]) => {
  if (resumeHintTimer) clearTimeout(resumeHintTimer)
  resumeHintTimer = undefined
  if (!value) return
  resumeHintDismissed.value = false
  // ★ 加载没结束之前不开始计时：否则冷启动慢一点，提示还没被人看见就已经到期了
  //   （E2E 里"重开必须看到续读提示"那句断言会因此变成假阴性）。
  if (isLoading) return
  resumeHintTimer = setTimeout(() => {
    resumeHintTimer = undefined
    resumeHintDismissed.value = true
  }, RESUME_HINT_MS)
})

onMounted(() => {
  // 先把观察器挂上：首次观测会回填阅读面尺寸，排版几何才能按真实可用宽度算。
  reflow.attach()
  // ★ 状态栏的"靠近顶部"判定要用根盒顶边：缓存起来，由 RO 刷新。
  //   不能每次 pointermove 都 getBoundingClientRect —— 那等于在指针事件里强制布局，
  //   而指针事件每秒能来上百次。
  const root = rootRef.value
  if (root) {
    viewTop = root.getBoundingClientRect().top
    viewObserver = new ResizeObserver(() => {
      viewTop = root.getBoundingClientRect().top
    })
    viewObserver.observe(root)
  }
  void loadBook()
  // 主文档也要挂键盘监听：iframe 被替换的瞬间焦点会丢。
  window.addEventListener('keydown', onWindowKey)
})

function onWindowKey(event: KeyboardEvent): void {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  // 焦点在章节文档里：bridge 已经在章节文档内处理过一次，这里让开，
  // 否则同一次按键会被处理两遍（第一下关浮层、第二下直接退出阅读器）。
  if (target instanceof HTMLIFrameElement) return
  // 输入框里的按键不抢（否则搜索框里没法敲方向键 / 空格）。
  if (isEditable(target)) return

  // ★ Esc 是全局的：焦点在工具栏按钮上也要能分层关闭。
  //   改造前只认 body/html，点完按钮再按 Esc 就"没反应"（踩过的坑）。
  if (event.key === 'Escape') {
    handleKey(event)
    return
  }
  // 翻页键只在焦点不在控件上时接管，否则会抢走工具栏按钮的空格 / 方向键，
  // 键盘用户就没法操作工具栏了。
  if (target === document.body || target === document.documentElement) handleKey(event)
}

/** 是否为可输入元素（这些元素里的按键不该被全局快捷键抢走）。 */
function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  unbridge?.()
  unbridge = null
  currentDoc = null
  reflow.dispose()
  viewObserver?.disconnect()
  viewObserver = null
  clearBarHideTimer()
  clearPendingTap()
  if (resumeHintTimer) clearTimeout(resumeHintTimer)
  resumeHintTimer = undefined
  void engine.close()
})

/**
 * 划词操作条的位置：贴着选区出现（而不是永远缩在右下角）。
 *
 * 锚点拿不到时（程序化选区的极端情况）退回右下角 —— 宁可位置不够聪明，
 * 也不能"选区有了但操作条不见了"。
 */
const selectionBarStyle = computed<Record<string, string>>(() => {
  const anchor = selectionAnchorPoint.value
  if (!anchor) return { left: 'auto', right: '12px', bottom: '12px', top: 'auto' }
  // 操作条估计宽度：只用来做水平钳制，宁窄勿溢出。
  const estimated = 260
  const margin = 12
  const viewportWidth = window.innerWidth
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - estimated - margin))
  // 选区上方放得下就放上方（不挡正在读的那一行），放不下就放下方。
  const above = anchor.top > 64
  return {
    left: `${left}px`,
    top: `${above ? Math.round(anchor.top - 46) : Math.round(anchor.top + 26)}px`,
    right: 'auto',
    bottom: 'auto',
  }
})
</script>

<template>
  <div
    ref="rootRef"
    data-testid="reader-view"
    class="relative flex h-full w-full overflow-hidden"
    :data-orientation="layout.orientation"
    :data-frozen="frozen ? 'true' : 'false'"
    :data-bar="barShown ? 'visible' : 'hidden'"
    :data-bar-pinned="barPinned ? 'true' : 'false'"
    @pointermove="onRootPointerMove"
    @pointerleave="onRootPointerLeave"
  >
    <!--
      顶部状态栏：**默认收起**（见 barShown）。
      ★ 进出都用 .t-bar 过渡，只动 opacity / translateY —— 纯合成，
        不会因为"展开一个 48px 的条"而触发布局。
      ★ 高度让位靠下面那层的 padding（pt-12 ↔ pt-0）配合 useReaderReflow：
        栏收起来时正文要真的往上吃到那 48px。否则只是"透明了"，
        小屏幕上该挡的还是挡 —— 那就不算修好。
    -->
    <Transition name="t-bar">
      <ReaderToolbar
        v-if="barShown"
        :chapter="chapterLabel"
        :progress="progress"
        :toc-open="tocOpen"
        :sanitize-summary="sanitizeSummary"
        :compact="layout.compact"
        :orientation="layout.orientation"
        :columns="layout.columns"
        :theme-label="themeLabel"
        :title="t('reader.title')"
        :pinned="barPinned"
        @back="goBack"
        @prev="turn('prev')"
        @next="turn('next')"
        @toggle-toc="tocOpen = !tocOpen"
        @cycle-theme="cycleTheme"
        @toggle-ai="aiPanelOpen = !aiPanelOpen; glossaryOpen = false"
        @toggle-glossary="glossaryOpen = !glossaryOpen; aiPanelOpen = false"
        @toggle-pin="togglePinBar"
      />
    </Transition>

    <!--
      ★ pt-12 / pt-0 跟着状态栏走：栏在就给它让出 48px，收起来就还给正文。
      这一步会改阅读面高度，由 useReaderReflow 的调度器合并成一次**离散**重排
      （不是每帧重排，所以不会把"阻滞感"带回来）。
    -->
    <div class="flex min-h-0 w-full flex-1" :class="barShown ? 'pt-12' : 'pt-0'">
      <!--
        宽屏横屏：目录常驻侧栏（不覆盖正文），可折叠。
        ★ 刻意**不给侧栏做宽度过渡**：侧栏是布局参与者，宽度一动正文宽度就跟着动，
        每帧都会触发重排 —— 那正好是我们要消灭的"阻滞感"。
        这里改成"盒子瞬时到位 + 内容淡入"（.hpf-rise-in）。
      -->
      <aside
        v-if="layout.tocMode === 'sidebar' && tocOpen"
        data-testid="toc-sidebar"
        class="hpf-rise-in w-64 shrink-0 overflow-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3"
      >
        <h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('reader.toc') }}
        </h2>
        <ul class="space-y-0.5">
          <li v-for="item in toc" :key="item.label + String(item.target)">
            <button
              type="button"
              class="hpf-press hpf-focus w-full rounded px-2 py-1 text-left text-sm leading-snug text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
              @click="openTocItem(item.target)"
            >
              {{ item.label }}
            </button>
          </li>
        </ul>
      </aside>

      <!--
        阅读区：必须是有确定尺寸的容器，否则 paginator 算出 0 页 = 白屏。
        ★ hpf-reader-surface 提供 overflow:hidden + contain:paint：
          拖动期间内容按旧尺寸渲染再由 transform 缩放贴合新尺寸，需要裁剪。
      -->
      <div
        ref="hostRef"
        data-testid="reader-host"
        class="hpf-reader-surface relative min-h-0 min-w-0 flex-1"
        @click="onSurfaceClick"
      />
    </div>

    <!-- 窄屏 / 竖屏：目录走覆盖层，不挤压正文宽度 -->
    <Transition name="t-fade">
      <div
        v-if="tocOpen && layout.tocMode === 'overlay'"
        class="absolute inset-x-0 bottom-0 z-[15] bg-black/25"
        :class="barShown ? 'top-12' : 'top-0'"
        data-testid="toc-scrim"
        @click="tocOpen = false"
      />
    </Transition>
    <!--
      ★ 抽屉从状态栏下沿开始（栏在 → top-12，栏收起 → top-0），不要 `inset-y-0`：
        盖住工具栏会让"再点一次 ☰ 关掉目录"变成点不到（点到的其实是抽屉本身）。
        目录打开期间 chromeLocked 会拦住自动收起，所以正常情况下栏一定还在；
        但 pin 关闭 + 显式折叠这类路径也可能让栏不在，两种情形都要对得上。
    -->
    <Transition name="t-slide-left">
      <aside
        v-if="tocOpen && layout.tocMode === 'overlay'"
        data-testid="toc-overlay"
        class="absolute bottom-0 left-0 z-20 w-[80vw] max-w-xs overflow-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-xl"
        :class="barShown ? 'top-12' : 'top-0'"
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold">{{ t('reader.toc') }}</h2>
          <button type="button" class="hpf-press hpf-focus rounded px-2 py-1 text-sm" @click="tocOpen = false">✕</button>
        </div>
        <ul class="space-y-1">
          <li v-for="item in toc" :key="item.label + String(item.target)">
            <button
              type="button"
              class="hpf-press hpf-focus w-full rounded px-2 py-1 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
              @click="openTocItem(item.target)"
            >
              {{ item.label }}
            </button>
          </li>
        </ul>
      </aside>
    </Transition>

    <Transition name="t-fade">
      <p
        v-if="loading"
        data-testid="reader-loading"
        class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-[var(--reader-paper)] text-sm text-[var(--color-text-secondary)]"
      >
        {{ t('reader.loading') }}
      </p>
    </Transition>

    <Transition name="t-fade">
      <p
        v-if="failed"
        data-testid="reader-error"
        class="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
      >
        {{ t('reader.failed') }}：{{ failed }}
      </p>
    </Transition>

    <!--
      续读提示：只做一次性告知。
      ★ pointer-events-none：它压在正文左下角，会吃掉那里的翻页点击 ——
        改造前带 hpf-press / cursor-default，看着能点、点了没反应，还挡住热区。
      ★ 到点自动消失（RESUME_HINT_MS），不再常驻；Transition 保留淡出。
    -->
    <Transition name="t-rise">
      <p
        v-if="resumedFrom && !loading && !resumeHintDismissed"
        data-testid="reader-resumed"
        class="pointer-events-none absolute bottom-3 left-3 z-20 rounded-full bg-[var(--color-surface-raised)]/90 px-3 py-1 text-xs text-[var(--color-text-secondary)] shadow"
      >
        {{ t('reader.resumed', { n: progress }) }}
      </p>
    </Transition>

    <!-- 整书翻译面板 -->
    <Transition name="t-pop">
      <BookTranslatePanel
        v-if="aiPanelOpen"
        :book-id="bookId"
        :book-title="chapterLabel || t('reader.title')"
        @close="aiPanelOpen = false"
      />
    </Transition>

    <!-- 术语表面板 -->
    <Transition name="t-pop">
      <GlossaryPanel
        v-if="glossaryOpen"
        :book-id="bookId"
        :target-lang="targetLang"
        @close="glossaryOpen = false"
      />
    </Transition>

    <!--
      划词操作条：贴着选区出现（竖屏也不挡正文）。
      ★ 气泡打开后收起操作条：两套浮层挤在同一处既挡字也抢点击。
    -->
    <Transition name="t-rise">
      <div
        v-if="selectionText && !bubbleAnchor"
        data-testid="selection-bar"
        class="fixed z-20 flex items-center gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs shadow"
        :style="selectionBarStyle"
      >
        <span class="max-w-[40ch] truncate">{{ t('reader.selected', { n: selectionText.length }) }}</span>
        <button
          type="button"
          data-testid="selection-translate"
          class="hpf-press hpf-focus rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-[var(--color-accent-contrast)]"
          @click="translateSelection"
        >
          {{ t('ai.translate') }}
        </button>
        <button type="button" class="hpf-press hpf-focus rounded px-2 py-1 text-xs" @click="copySelection">
          {{ t('reader.copy') }}
        </button>
      </div>
    </Transition>

    <!-- 划词翻译气泡（task-23）：跟随选区，流式显示译文 -->
    <Transition name="t-pop">
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
    </Transition>
  </div>
</template>
