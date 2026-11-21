<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { BookRecord } from '@/platform'

const props = withDefaults(
  defineProps<{
    book: BookRecord
    /** 本地缓存的阅读百分比（0-100）。0 或未传表示没读过。 */
    progress?: number
    /** 无后端时隐藏"移除"（不是书库条目就不能删）。 */
    removable?: boolean
  }>(),
  { progress: 0, removable: true },
)
const emit = defineEmits<{ remove: [] }>()

const { t } = useI18n()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <article
    data-testid="book-card"
    :data-book-id="props.book.id"
    class="group hpf-press relative flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 hover:-translate-y-0.5"
  >
    <!--
      悬停阴影：原来写的是 `transition-shadow hover:shadow-md`。
      box-shadow 是**绘制**属性，过渡它意味着每帧重绘整张卡片（4K/高刷下明显掉帧）。
      改成"一层已经画好的阴影 + 只过渡它的 opacity"：阴影会随 opacity 进入合成层，
      之后每帧只是 alpha 混合，完全不用重绘。
    -->
    <span
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 rounded-xl opacity-0 shadow-lg transition-opacity duration-200 ease-out group-hover:opacity-100"
    />
    <div class="mb-3 flex aspect-[3/4] items-center justify-center rounded-lg bg-[var(--color-surface-sunken)]">
      <span class="text-2xl font-semibold opacity-40">{{ props.book.title.slice(0, 1) }}</span>
    </div>
    <h2 class="line-clamp-2 text-sm font-medium" :title="props.book.title">{{ props.book.title }}</h2>
    <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
      {{ props.book.author || '—' }} · {{ props.book.format.toUpperCase() }} · {{ formatSize(props.book.sizeBytes) }}
    </p>

    <!-- 本地阅读进度：来自 localStorage 缓存，不需要任何后端 -->
    <div v-if="props.progress > 0" class="mt-2">
      <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
        <!-- ★ scaleX 而不是 width：宽度百分比会触发重排，scaleX 走合成层 -->
        <div
          class="hpf-meter h-full w-full rounded-full bg-[var(--color-accent)]"
          :style="{ transform: `scaleX(${Math.min(100, Math.max(0, props.progress)) / 100})` }"
        />
      </div>
      <p data-testid="book-progress" class="mt-1 text-[11px] text-[var(--color-text-secondary)]">
        {{ t('library.progress', { n: props.progress }) }}
      </p>
    </div>

    <div class="mt-3 flex items-center justify-between">
      <RouterLink
        :to="`/reader/${props.book.id}`"
        class="hpf-press hpf-focus rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)]"
      >
        {{ t('library.read') }}
      </RouterLink>
      <button
        v-if="props.removable"
        type="button"
        class="hpf-press hpf-focus rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-red-600"
        @click="emit('remove')"
      >
        {{ t('library.delete') }}
      </button>
    </div>
  </article>
</template>
