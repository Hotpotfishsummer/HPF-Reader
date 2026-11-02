<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { usePlatform } from '@/platform'
import { getRememberedBook, rememberBook } from './bookSession'
import { useFoliateEngine, type RelocateDetail } from './useFoliateEngine'
import { bridgeSectionDocument } from './bridge'
import { anchorFromRange } from './coords'
import { buildReaderStyles } from './readerStyles'
import ReaderToolbar from './components/ReaderToolbar.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const platform = usePlatform()
const settings = useSettingsStore()

const bookId = computed(() => String(route.params['bookId'] ?? ''))
const isSample = computed(() => bookId.value === 'sample')

const hostRef = useTemplateRef<HTMLElement>('hostRef')
const loading = ref(true)
const failed = ref<string | null>(null)
const toc = shallowRef<{ label: string; target: string | number }[]>([])
const progress = ref(0)
const chapterLabel = ref('')
const tocOpen = ref(false)
const sanitizeSummary = ref('')
const selectionRectCount = ref(0)

/**
 * ★ 当前章节文档：仅用于挂监听与算坐标（coords.ts 需要它）。
 * 它是 DOM 节点，**绝不**进响应式状态 —— 放闭包普通变量。
 */
let currentDoc: Document | null = null
let unbridge: (() => void) | null = null
let lastSaved = ''

/** 划词结果：只把"值"交给 Vue（文本 + 可见矩形数），Range 本身留在闭包里。 */
const selectionText = ref('')
let selectionRange: Range | null = null

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
}

function readerStyleInput() {
  return {
    fontFamily: 'var(--reader-font-family)',
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: 0.01,
    marginInline: settings.marginInline,
    marginBlock: 32,
    columnGap: 7,
    maxInlineSize: 720,
    maxColumnCount: 1,
    paper: 'var(--reader-paper)',
    ink: 'var(--reader-ink)',
  }
}

const engine = useFoliateEngine(() => hostRef.value, {
  onReady(book) {
    loading.value = false
    toc.value = (book.toc ?? []).map((item) => ({ label: item.label, target: item.href }))
    applyStyles()
  },
  onError(error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  },
  onRelocate(location: RelocateDetail) {
    progress.value = Math.round(location.fraction * 100)
    chapterLabel.value = location.tocLabel
    void persistProgress(location)
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
          // 几何信息留在这里，M2 的浮层直接用 coords.ts 换算（见 §5.5）。
          const visible = Array.from(selection.range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          )
          selectionRectCount.value = visible.length
        } else {
          selectionRectCount.value = 0
        }
        // 立刻换算一次，确保坐标系在真实 DOM 上被跑通（值本身留给 M2 的浮层用）。
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


async function persistProgress(location: RelocateDetail): Promise<void> {
  if (!location.cfi || location.cfi === lastSaved) return
  lastSaved = location.cfi
  try {
    await platform.library.saveProgress(bookId.value, location.cfi)
  } catch (error) {
    console.warn('[reader] save progress failed', error)
  }
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
  tocOpen.value = false
  await engine.goTo(target)
}

async function loadBook(): Promise<void> {
  loading.value = true
  failed.value = null
  try {
    if (isSample.value) {
      // 示例书走 URL：fetch 后转成 File 交给 foliate-js。
      const res = await fetch('/sample/sample.epub')
      if (!res.ok) throw new Error(`sample.epub: ${res.status}`)
      const blob = await res.blob()
      await engine.open(new File([blob], 'sample.epub', { type: 'application/epub+zip' }))
      return
    }

    let payload = getRememberedBook(bookId.value)
    if (!payload) {
      payload = await platform.library.openBook(bookId.value)
      rememberBook(payload)
    }
    // 用 ArrayBuffer 构造 Blob：Uint8Array<ArrayBufferLike> 不满足 BlobPart 的类型要求
    // （它可能是 SharedArrayBuffer 视图），复制成确定的 ArrayBuffer 最稳妥。
    const bytes = new Uint8Array(payload.bytes)
    const file = new File([bytes.buffer as ArrayBuffer], `${payload.book.id}.${payload.book.format || 'epub'}`, {
      type: 'application/epub+zip',
    })
    await engine.open(file)
  } catch (error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : String(error)
  }
}

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
  <div class="relative h-full w-full">
    <!-- 排版容器：绝对定位 + 明确尺寸（高度为 0 会让 paginator 算出 0 页） -->
    <div ref="hostRef" class="absolute inset-0" />

    <p
      v-if="loading"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-secondary)]"
    >
      {{ t('reader.loading') }}
    </p>

    <div
      v-if="failed"
      class="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <p class="text-sm text-red-600">{{ failed }}</p>
      <button type="button" class="rounded-lg border px-4 py-2 text-sm" @click="goBack">
        {{ t('reader.back') }}
      </button>
    </div>

    <ReaderToolbar
      :chapter="chapterLabel"
      :progress="progress"
      :toc-open="tocOpen"
      :sanitize-summary="sanitizeSummary"
      @back="goBack"
      @prev="engine.prev()"
      @next="engine.next()"
      @toggle-toc="tocOpen = !tocOpen"
    />

    <!-- 划词提示条（M1 骨架：证明选区能跨帧进来；完整浮层在 M2） -->
    <div
      v-if="selectionText"
      class="absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit max-w-[80%] items-center gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 shadow-lg"
    >
      <span class="truncate text-xs text-[var(--color-text-secondary)]">
        {{ selectionText.slice(0, 40) }}（{{ selectionRectCount }} 段）
      </span>
      <button type="button" class="rounded px-2 py-1 text-xs" @click="copySelection">
        copy
      </button>
    </div>

    <aside
      v-if="tocOpen"
      class="absolute inset-y-0 left-0 z-10 w-72 overflow-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-lg"
    >
      <h2 class="mb-3 text-sm font-semibold">{{ t('reader.toc') }}</h2>
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
  </div>
</template>
