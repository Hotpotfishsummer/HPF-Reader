<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 阅读器工具栏。
 *
 * ★ 自适应（task-12 §3）：同一套按钮在窄屏竖屏下压缩成图标，在宽屏下显示文字标签。
 * 判断依据由 ReaderView 的 useReaderLayout 传来（`compact` / `orientation`），
 * 组件内**不**自己读 window —— 阈值只在一个地方维护。
 *
 * ★ 动效改造（本次）三件事：
 *   1. 去掉 `backdrop-blur`。工具栏下面就是 `pt-12` 的留白（正文永远不会滚到它
 *      后面），这层模糊每帧都在做一次全宽 backdrop-filter，纯属白烧 GPU。
 *   2. 进度从"只有个百分比数字"变成**工具栏底边的进度轨道**：
 *      `transform: scaleX()` 驱动，纯合成层，翻页时零重绘。
 *      用宽度百分比做进度会每帧重排 —— 这正是很多阅读器进度条发涩的原因。
 *   3. 按钮统一 `.hpf-press`：按下时 96% 缩放，用 transform 而不是换背景色。
 */
const props = defineProps<{
  chapter: string
  progress: number
  tocOpen: boolean
  sanitizeSummary: string
  compact: boolean
  orientation: 'portrait' | 'landscape'
  columns: 1 | 2
  themeLabel: string
  title: string
  /** 顶部状态栏是否常驻（pin）：true 时不再自动收起，按钮也显示"取消固定"。 */
  pinned: boolean
}>()

const emit = defineEmits<{
  back: []
  prev: []
  next: []
  'toggle-toc': []
  'cycle-theme': []
  'toggle-ai': []
  'toggle-glossary': []
  'toggle-pin': []
}>()

const { t } = useI18n()

/** 无障碍标签永远用完整文字，视觉上可以只放图标。 */
const backLabel = computed(() => t('reader.back'))
const prevLabel = computed(() => t('reader.prev'))
const nextLabel = computed(() => t('reader.next'))
const tocLabel = computed(() => t('reader.toc'))
/**
 * pin 的提示文案。
 * ★ pin 与非 pin 必须**不同**，否则用户看不出当前处于哪种状态 —— 这类开关最容易踩的坑：
 *   图标一样、标签一样，点了不知道到底有没有生效。
 */
const pinLabel = computed(() => (props.pinned ? t('reader.unpinBar') : t('reader.pinBar')))

/** 进度夹到 0~100：引擎在极少数中间态会给到 1.0000001 这类值。 */
const progressRatio = computed(() => Math.min(1, Math.max(0, props.progress / 100)))
</script>

<template>
  <header
    data-testid="reader-toolbar"
    :data-compact="props.compact ? 'true' : 'false'"
    :data-columns="String(props.columns)"
    class="absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 sm:gap-2 sm:px-3"
  >
    <button
      type="button"
      data-testid="back"
      :aria-label="backLabel"
      :title="backLabel"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('back')"
    >
      <span aria-hidden="true">←</span><span v-if="!props.compact" class="ml-1">{{ backLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="toggle-toc"
      :aria-label="tocLabel"
      :title="tocLabel"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      :class="props.tocOpen ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'"
      @click="emit('toggle-toc')"
    >
      <span aria-hidden="true">☰</span><span v-if="!props.compact" class="ml-1">{{ tocLabel }}</span>
    </button>

    <!--
      ★ pin（本次动线优化）：把"自动隐藏"与"常驻"两种状态显式分开。
      没有这个开关时，用户只能靠"把光标挪到顶部"来找回状态栏，很容易以为它坏了。
    -->
    <button
      type="button"
      data-testid="toggle-pin"
      :aria-label="pinLabel"
      :title="pinLabel"
      :aria-pressed="props.pinned ? 'true' : 'false'"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      :class="props.pinned ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'"
      @click="emit('toggle-pin')"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        class="h-4 w-4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 17.5V22" />
        <path d="M9 3h6l-.7 5.4a2.1 2.1 0 0 0 .5 1.6l1.6 1.5-3.4 3.4-1.5-1.4a2.1 2.1 0 0 0-1.6-.5L9 3Z" />
      </svg>
      <span v-if="!props.compact" class="ml-1">{{ pinLabel }}</span>
    </button>

    <span class="min-w-0 flex-1 truncate text-center text-sm text-[var(--color-text-secondary)]">
      <span class="text-[var(--color-text-primary)]">{{ props.chapter || props.title }}</span>
    </span>

    <span
      data-testid="progress"
      class="shrink-0 text-xs tabular-nums text-[var(--color-text-secondary)]"
      :title="props.sanitizeSummary"
    >
      {{ props.progress }}%
    </span>

    <span
      v-if="sanitizeSummary && !props.compact"
      class="hidden shrink-0 text-xs text-[var(--color-text-secondary)] lg:inline"
      :title="sanitizeSummary"
    >
      L2
    </span>

    <!-- ★ AI 入口（task-23）：整书翻译 + 术语表 -->
    <button
      type="button"
      data-testid="toggle-ai"
      :aria-label="t('ai.bookEntry')"
      :title="t('ai.bookEntry')"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('toggle-ai')"
    >
      <span aria-hidden="true">文</span><span v-if="!props.compact" class="ml-1">A</span>
    </button>

    <button
      type="button"
      data-testid="toggle-glossary"
      :aria-label="t('ai.glossaryEntry')"
      :title="t('ai.glossaryEntry')"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('toggle-glossary')"
    >
      <span aria-hidden="true">≡</span>
    </button>

    <button
      type="button"
      data-testid="cycle-theme"
      :aria-label="props.themeLabel"
      :title="props.themeLabel"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('cycle-theme')"
    >
      <span aria-hidden="true">◐</span><span v-if="!props.compact" class="ml-1">{{ props.themeLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="prev-page"
      :aria-label="prevLabel"
      :title="prevLabel"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('prev')"
    >
      <span aria-hidden="true">‹</span><span v-if="!props.compact" class="ml-1">{{ prevLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="next-page"
      :aria-label="nextLabel"
      :title="nextLabel"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('next')"
    >
      <span aria-hidden="true">›</span><span v-if="!props.compact" class="ml-1">{{ nextLabel }}</span>
    </button>

    <!--
      进度轨道：贴着工具栏底边，2px。
      ★ 用 scaleX 而不是 width —— width 每变一次都要重排整条工具栏。
      纯装饰，不参与无障碍树（进度已经由上面的百分比文字表达）。
    -->
    <div aria-hidden="true" class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-[var(--color-surface-sunken)]">
      <div
        data-testid="progress-rail"
        class="hpf-progress-rail h-full w-full bg-[var(--color-accent)]"
        :style="{ transform: `scaleX(${progressRatio})` }"
      />
    </div>
  </header>
</template>
