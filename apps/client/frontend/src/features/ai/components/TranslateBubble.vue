<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 划词翻译气泡（task-23）。
 *
 * 定位：**fixed**，坐标由 coords.ts 从 iframe 视口换算到主文档视口
 * （见 src/reader/coords.ts §5.5）。这里只接收算好的 anchor，不自己碰 iframe。
 *
 * ★ 为什么不用 Popover 组件库：foliate 的选区在 iframe 里，浮层必须在
 * **主文档**里才能显示在正文之上；而且气泡要跟着选区走、不能抢焦点
 * （抢焦点会清掉 iframe 里的选区，浮层刚出现选区就没了）。
 */

const props = defineProps<{
  /** 锚点（主文档视口坐标，通常是选区最后一行的左下角）。 */
  anchor: { left: number; top: number } | null
  /** 原文（用于显示"正在翻译 N 字"）。 */
  source: string
  status: 'idle' | 'streaming' | 'done' | 'error' | 'canceled' | 'quota'
  text: string
  errorText: string
  quotaMessage: string
}>()

const emit = defineEmits<{
  translate: []
  cancel: []
  close: []
  copy: []
  retry: []
}>()

const { t } = useI18n()

/**
 * 气泡宽度：窄屏（竖屏手机）必须收窄，否则会溢出屏幕。
 * 用 vw 而不是固定 px，横竖屏都合适。
 */
const bubbleRef = ref<HTMLElement | null>(null)
const MAX_WIDTH = 420

/**
 * ★ 位置钳制：气泡不能跑出屏幕。
 * 只做"锚点在哪就放哪"是不够的 —— 选区在屏幕右下角时气泡会整个飞出可视区。
 */
const position = computed(() => {
  if (!props.anchor) return { left: '0px', top: '0px', placement: 'below' as const }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(MAX_WIDTH, vw - 24)
  // 默认放在选区下方；下方空间不够就翻到上方。
  const belowTop = props.anchor.top + 8
  const placement: 'below' | 'above' = belowTop + 180 > vh ? 'above' : 'below'
  const rawLeft = props.anchor.left
  // 水平方向钳到 [12, vw - width - 12]
  const left = Math.max(12, Math.min(rawLeft, vw - width - 12))
  const top = placement === 'below' ? belowTop : Math.max(12, props.anchor.top - 8)
  return {
    left: left + 'px',
    // above 时用 transform 把气泡整体翻上去（高度未知，用 translateY(-100%) 更稳）
    top: top + 'px',
    placement,
  }
})

const style = computed(() => ({
  left: position.value.left,
  top: position.value.top,
  maxWidth: 'min(' + MAX_WIDTH + 'px, calc(100vw - 24px))',
  transform: position.value.placement === 'above' ? 'translateY(-100%)' : 'none',
}))

const isStreaming = computed(() => props.status === 'streaming')
const showResult = computed(() => props.text !== '' || props.status === 'streaming')
const charCount = computed(() => props.source.length)

/** 复制译文：用 navigator.clipboard，失败时静默（老 WebView 可能没有权限）。 */
async function copyResult(): Promise<void> {
  if (props.text === '') return
  try {
    await navigator.clipboard.writeText(props.text)
  } catch {
    // 无剪贴板权限：不阻断，用户仍可手动选择文本
  }
  emit('copy')
}

/**
 * 点击外部关闭。用 capture + 判断是否点在气泡内。
 * ⚠️ 不监听 iframe 内的点击 —— 那个由 ReaderView 的 selection 变化驱动。
 */
function onPointerDown(event: PointerEvent): void {
  const el = bubbleRef.value
  if (!el) return
  const target = event.target
  if (target instanceof Node && el.contains(target)) return
  emit('close')
}

watch(
  () => props.anchor,
  (anchor) => {
    if (anchor) window.addEventListener('pointerdown', onPointerDown, true)
    else window.removeEventListener('pointerdown', onPointerDown, true)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true)
})

/** 状态文案：429 与网络错误走**完全不同**的分支（这是本任务的核心要求）。 */
const statusLabel = computed(() => {
  switch (props.status) {
    case 'streaming':
      return t('ai.translating')
    case 'canceled':
      return t('ai.canceled')
    case 'quota':
      return t('ai.quotaTitle')
    case 'error':
      return t('ai.errorTitle')
    default:
      return ''
  }
})
</script>

<template>
  <div
    ref="bubbleRef"
    data-testid="translate-bubble"
    :data-status="status"
    :data-placement="position.placement"
    class="fixed z-40 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
    :style="style"
    role="dialog"
    :aria-label="t('ai.bubbleLabel')"
  >
    <!-- 头部：状态 + 关闭 -->
    <div class="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <span class="text-xs font-medium text-[var(--color-text-secondary)]">
        {{ statusLabel || t('ai.title') }}
      </span>
      <span v-if="isStreaming" data-testid="translate-streaming-dot" class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
      <span class="ml-auto text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{{ charCount }} 字</span>
      <button
        type="button"
        data-testid="translate-close"
        class="rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        :aria-label="t('ai.close')"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- 结果区 -->
    <div class="max-h-[46vh] overflow-auto px-3 py-2">
      <!-- ★ 429：配额耗尽（不是网络错误！） -->
      <p
        v-if="status === 'quota'"
        data-testid="translate-quota"
        class="rounded-md bg-amber-50 px-2 py-1.5 text-sm leading-relaxed text-amber-900"
      >
        {{ quotaMessage }}
      </p>

      <!-- 网络/服务错误：这里才是"重试"的场景 -->
      <p
        v-else-if="status === 'error'"
        data-testid="translate-error"
        class="rounded-md bg-red-50 px-2 py-1.5 text-sm leading-relaxed text-red-700"
      >
        {{ errorText || t('ai.errorTitle') }}
      </p>

      <!-- 译文（流式累积） -->
      <p
        v-else-if="showResult"
        data-testid="translate-result"
        class="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text-primary)]"
      >
        {{ text }}<span v-if="isStreaming" class="animate-pulse">▍</span>
      </p>

      <p v-else class="text-sm text-[var(--color-text-tertiary)]">{{ t('ai.ready') }}</p>
    </div>

    <!-- 操作区 -->
    <div class="flex flex-wrap items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-3 py-2">
      <button
        v-if="status === 'idle' || status === 'canceled' || status === 'error'"
        type="button"
        data-testid="translate-start"
        class="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
        @click="status === 'error' ? emit('retry') : emit('translate')"
      >
        {{ status === 'error' ? t('ai.retry') : t('ai.translate') }}
      </button>

      <button
        v-if="isStreaming"
        type="button"
        data-testid="translate-cancel"
        class="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-sunken)]"
        @click="emit('cancel')"
      >
        {{ t('ai.stop') }}
      </button>

      <button
        v-if="text !== '' && !isStreaming"
        type="button"
        data-testid="translate-copy"
        class="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-sunken)]"
        @click="copyResult"
      >
        {{ t('ai.copy') }}
      </button>

      <span v-if="isStreaming" class="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
        {{ t('ai.cancelHint') }}
      </span>
    </div>
  </div>
</template>
