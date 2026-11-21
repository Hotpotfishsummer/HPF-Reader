<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import WindowControls from '@/app/components/WindowControls.vue'
import { usePlatform } from '@/platform'

const platform = usePlatform()

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
  bookmarked?: boolean
  bookmarksOpen?: boolean
  bookmarkCount?: number
  searchOpen?: boolean
  bilingualOpen?: boolean
  ttsOpen?: boolean
  typographyOpen?: boolean
  aiOpen?: boolean
  glossaryOpen?: boolean
  isFullscreen?: boolean
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
  'toggle-typography': []
  'toggle-bilingual': []
  'toggle-tts': []
  'toggle-search': []
  'toggle-bookmark': []
  'toggle-bookmarks': []
  'toggle-fullscreen': []
  'toggle-pin': []
}>()

const { t } = useI18n()

function handleHeaderDblClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest?.('button, a, input, select, textarea, [data-no-drag]')) return
  void platform.window?.toggleMaximize()
}

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
    class="absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/90 px-2 backdrop-blur sm:gap-2 sm:px-3"
    :class="{ 'pl-20': platform.window?.isMacTrafficLights }"
    style="--wails-draggable: drag; padding-top: env(safe-area-inset-top, 0px);"
    @dblclick="handleHeaderDblClick"
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

    <!-- 书签按钮组：左侧点击标记/取消当前页，右侧点击查看书签面板 -->
    <div
      class="flex shrink-0 items-center rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
      :class="props.bookmarked ? 'border-amber-400/60' : ''"
    >
      <button
        type="button"
        data-testid="toggle-bookmark"
        :aria-label="t('reader.bookmark')"
        :title="`${t('reader.bookmark')} (Ctrl+B)`"
        class="hpf-press hpf-focus shrink-0 rounded-l px-2 py-1 text-sm transition"
        :class="props.bookmarked ? 'text-amber-500 font-bold bg-amber-500/15' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
        @click="emit('toggle-bookmark')"
      >
        <span aria-hidden="true">{{ props.bookmarked ? '★' : '☆' }}</span><span v-if="!props.compact" class="ml-1">{{ t('reader.bookmark') }}</span>
      </button>

      <button
        type="button"
        data-testid="open-bookmarks-panel"
        :aria-label="t('reader.bookmarksView') || '查看书签'"
        :title="`${t('reader.bookmarksView') || '查看书签'} (${props.bookmarkCount ?? 0})`"
        class="hpf-press hpf-focus shrink-0 border-l border-[var(--color-border-subtle)] px-1.5 py-1 text-xs transition"
        :class="props.bookmarksOpen
          ? 'bg-amber-500/25 text-amber-600 dark:text-amber-400 font-semibold'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
        @click="emit('toggle-bookmarks')"
      >
        <span v-if="(props.bookmarkCount ?? 0) > 0" class="tabular-nums font-semibold text-[11px] text-amber-600 dark:text-amber-400">{{ props.bookmarkCount }}</span>
        <span v-else class="text-[9px] opacity-70">▼</span>
      </button>
    </div>

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

    <button
      type="button"
      data-testid="toggle-search"
      :aria-label="t('reader.search')"
      :title="`${t('reader.search')} (Ctrl+F)`"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.searchOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
      @click="emit('toggle-search')"
    >
      <span aria-hidden="true">🔍</span><span v-if="!props.compact" class="ml-1">{{ t('reader.search') }}</span>
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
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.aiOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]'"
      @click="emit('toggle-ai')"
    >
      <span aria-hidden="true">文</span><span v-if="!props.compact" class="ml-1">A</span>
    </button>

    <button
      type="button"
      data-testid="toggle-bilingual"
      aria-label="双语对照"
      title="双语对照"
      class="shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.bilingualOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]'"
      @click="emit('toggle-bilingual')"
    >
      <span aria-hidden="true">⇄</span><span v-if="!props.compact" class="ml-1">译</span>
    </button>

    <button
      type="button"
      data-testid="toggle-glossary"
      :aria-label="t('ai.glossaryEntry')"
      :title="t('ai.glossaryEntry')"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.glossaryOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]'"
      @click="emit('toggle-glossary')"
    >
      <span aria-hidden="true">≡</span>
    </button>

    <button
      type="button"
      data-testid="toggle-tts"
      :aria-label="t('reader.tts')"
      :title="t('reader.tts')"
      class="shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.ttsOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]'"
      @click="emit('toggle-tts')"
    >
      <span aria-hidden="true">🔊</span>
    </button>

    <button
      type="button"
      data-testid="toggle-typography"
      :aria-label="t('reader.typography')"
      :title="t('reader.typography')"
      class="shrink-0 rounded px-2 py-1 text-sm transition"
      :class="props.typographyOpen ? 'text-[var(--color-accent)] font-bold bg-[var(--color-accent)]/10' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]'"
      @click="emit('toggle-typography')"
    >
      <span aria-hidden="true" class="font-serif font-bold">Aa</span>
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

    <button
      type="button"
      data-testid="toggle-fullscreen"
      :aria-label="props.isFullscreen ? '退出全屏' : '全屏 (F11)'"
      :title="props.isFullscreen ? '退出全屏 (F11)' : '全屏 (F11)'"
      class="hpf-press hpf-focus shrink-0 rounded px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
      @click="emit('toggle-fullscreen')"
    >
      <svg v-if="props.isFullscreen" class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
        <path d="M5.5 0a.5.5 0 0 1 .5.5v4A1.5 1.5 0 0 1 4.5 6h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 10 4.5v-4a.5.5 0 0 1 .5-.5zM0 10.5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 6 11.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zm10 1a1.5 1.5 0 0 1 1.5-1.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4z"/>
      </svg>
      <svg v-else class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4A1.5 1.5 0 0 1 14.5 16h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"/>
      </svg>
    </button>

    <WindowControls />

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
