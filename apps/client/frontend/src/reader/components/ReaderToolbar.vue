<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 阅读器工具栏。
 *
 * ★ 自适应（task-12 §3）：同一套按钮在窄屏竖屏下压缩成图标，在宽屏下显示文字标签。
 * 判断依据由 ReaderView 的 useReaderLayout 传来（`compact` / `orientation`），
 * 组件内**不**自己读 window —— 阈值只在一个地方维护。
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
}>()

const emit = defineEmits<{
  back: []
  prev: []
  next: []
  'toggle-toc': []
  'cycle-theme': []
  'toggle-ai': []
  'toggle-glossary': []
}>()

const { t } = useI18n()

/** 无障碍标签永远用完整文字，视觉上可以只放图标。 */
const backLabel = computed(() => t('reader.back'))
const prevLabel = computed(() => t('reader.prev'))
const nextLabel = computed(() => t('reader.next'))
const tocLabel = computed(() => t('reader.toc'))
</script>

<template>
  <header
    data-testid="reader-toolbar"
    :data-compact="props.compact ? 'true' : 'false'"
    :data-columns="String(props.columns)"
    class="absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/90 px-2 backdrop-blur sm:gap-2 sm:px-3"
  >
    <button
      type="button"
      data-testid="back"
      :aria-label="backLabel"
      :title="backLabel"
      class="shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('back')"
    >
      <span aria-hidden="true">←</span><span v-if="!props.compact" class="ml-1">{{ backLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="toggle-toc"
      :aria-label="tocLabel"
      :title="tocLabel"
      class="shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      :class="props.tocOpen ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'"
      @click="emit('toggle-toc')"
    >
      <span aria-hidden="true">☰</span><span v-if="!props.compact" class="ml-1">{{ tocLabel }}</span>
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
      class="shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('toggle-ai')"
    >
      <span aria-hidden="true">文</span><span v-if="!props.compact" class="ml-1">A</span>
    </button>

    <button
      type="button"
      data-testid="toggle-glossary"
      :aria-label="t('ai.glossaryEntry')"
      :title="t('ai.glossaryEntry')"
      class="shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('toggle-glossary')"
    >
      <span aria-hidden="true">≡</span>
    </button>

    <button
      type="button"
      data-testid="cycle-theme"
      :aria-label="props.themeLabel"
      :title="props.themeLabel"
      class="shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('cycle-theme')"
    >
      <span aria-hidden="true">◐</span><span v-if="!props.compact" class="ml-1">{{ props.themeLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="prev-page"
      :aria-label="prevLabel"
      :title="prevLabel"
      class="shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('prev')"
    >
      <span aria-hidden="true">‹</span><span v-if="!props.compact" class="ml-1">{{ prevLabel }}</span>
    </button>

    <button
      type="button"
      data-testid="next-page"
      :aria-label="nextLabel"
      :title="nextLabel"
      class="shrink-0 rounded px-2 py-1 text-sm hover:bg-[var(--color-surface-sunken)]"
      @click="emit('next')"
    >
      <span aria-hidden="true">›</span><span v-if="!props.compact" class="ml-1">{{ nextLabel }}</span>
    </button>
  </header>
</template>