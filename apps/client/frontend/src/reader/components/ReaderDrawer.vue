<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnnotationItem } from '../annotationStore'
import type { FoliateEngine } from '../useFoliateEngine'
import ReaderSearchPanel from './ReaderSearchPanel.vue'

export type DrawerTab = 'toc' | 'annotations' | 'bookmarks' | 'search'

const props = defineProps<{
  tab: DrawerTab
  toc: Array<{ label: string; target: string | number }>
  annotations: AnnotationItem[]
  engine: FoliateEngine
  bookTitle: string
  compact?: boolean
  showClose?: boolean
}>()

const emit = defineEmits<{
  'update:tab': [tab: DrawerTab]
  jumpToc: [target: string | number]
  jumpAnnotation: [ann: AnnotationItem]
  jumpCfi: [cfi: string]
  deleteAnnotation: [ann: AnnotationItem]
  editNote: [ann: AnnotationItem]
  close: []
}>()

const { t } = useI18n()

// 标注子筛选：全部 / 高亮 / 划线 / 想法
type FilterKind = 'all' | 'highlight' | 'underline' | 'note'
const filterKind = ref<FilterKind>('all')
const annotationSearch = ref('')
const exportCopied = ref(false)

const highlightsAndNotes = computed(() => {
  return props.annotations.filter((a) => a.type !== 'bookmark')
})

const bookmarks = computed(() => {
  return props.annotations.filter((a) => a.type === 'bookmark')
})

const bookmarkSearch = ref('')
const filteredBookmarks = computed(() => {
  const q = bookmarkSearch.value.trim().toLowerCase()
  if (!q) return bookmarks.value
  return bookmarks.value.filter((b) => {
    const title = (b.chapterTitle ?? '').toLowerCase()
    const text = (b.text ?? '').toLowerCase()
    const note = (b.note ?? '').toLowerCase()
    return title.includes(q) || text.includes(q) || note.includes(q)
  })
})

const filteredAnnotations = computed(() => {
  const query = annotationSearch.value.trim().toLowerCase()
  return highlightsAndNotes.value.filter((ann) => {
    if (filterKind.value === 'highlight' && (ann.type !== 'highlight' || ann.note)) return false
    if (filterKind.value === 'underline' && ann.type !== 'underline') return false
    if (filterKind.value === 'note' && !ann.note) return false
    if (query) {
      const matchText = ann.text?.toLowerCase().includes(query) ?? false
      const matchNote = ann.note?.toLowerCase().includes(query) ?? false
      if (!matchText && !matchNote) return false
    }
    return true
  })
})

async function copyMarkdownExport(): Promise<void> {
  const lines: string[] = [
    `# 《${props.bookTitle || t('reader.title')}》读书笔记`,
    `> 导出时间：${new Date().toLocaleString()}`,
    '',
  ]

  const grouped = new Map<string, AnnotationItem[]>()
  for (const ann of highlightsAndNotes.value) {
    const chap = ann.chapterTitle || t('reader.title')
    if (!grouped.has(chap)) grouped.set(chap, [])
    grouped.get(chap)!.push(ann)
  }

  for (const [chap, items] of grouped.entries()) {
    lines.push(`## ${chap}`)
    for (const it of items) {
      const kindLabel = it.note ? '想法' : it.type === 'underline' ? '划线' : '高亮'
      const timeStr = it.createdAt ? it.createdAt.slice(0, 10) : ''
      if (it.text) {
        lines.push(`- ❝ ${it.text} ❞ *(${kindLabel} · ${timeStr})*`)
      }
      if (it.note) {
        lines.push(`  > 想法：${it.note}`)
      }
    }
    lines.push('')
  }

  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    exportCopied.value = true
    setTimeout(() => {
      exportCopied.value = false
    }, 2000)
  } catch (err) {
    console.warn('[drawer] clipboard write failed', err)
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 抽屉顶部 Tab 切换 -->
    <div class="mb-2 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-2">
      <div class="flex items-center gap-1 overflow-x-auto text-xs font-semibold">
        <button
          type="button"
          data-testid="drawer-tab-toc"
          class="shrink-0 rounded px-2.5 py-1 transition"
          :class="props.tab === 'toc' ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          @click="emit('update:tab', 'toc')"
        >
          {{ t('reader.toc') }}
        </button>

        <button
          type="button"
          data-testid="drawer-tab-annotations"
          class="flex shrink-0 items-center gap-1 rounded px-2.5 py-1 transition"
          :class="props.tab === 'annotations' ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          @click="emit('update:tab', 'annotations')"
        >
          <span>{{ t('reader.annotations') }}</span>
          <span v-if="highlightsAndNotes.length > 0" class="rounded-full bg-black/10 dark:bg-white/10 px-1.5 py-0.2 text-[10px] tabular-nums">
            {{ highlightsAndNotes.length }}
          </span>
        </button>

        <button
          type="button"
          data-testid="drawer-tab-bookmarks"
          class="flex shrink-0 items-center gap-1 rounded px-2.5 py-1 transition"
          :class="props.tab === 'bookmarks' ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          @click="emit('update:tab', 'bookmarks')"
        >
          <span>{{ t('reader.bookmark') }}</span>
          <span v-if="bookmarks.length > 0" class="rounded-full bg-black/10 dark:bg-white/10 px-1.5 py-0.2 text-[10px] tabular-nums">
            {{ bookmarks.length }}
          </span>
        </button>

        <button
          type="button"
          data-testid="drawer-tab-search"
          class="shrink-0 rounded px-2.5 py-1 transition"
          :class="props.tab === 'search' ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          @click="emit('update:tab', 'search')"
        >
          {{ t('reader.search') }}
        </button>
      </div>

      <button
        v-if="props.showClose"
        type="button"
        class="rounded p-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- 1. 目录视图 -->
    <div v-if="props.tab === 'toc'" class="flex-1 overflow-y-auto">
      <ul class="space-y-0.5">
        <li v-for="item in props.toc" :key="item.label + String(item.target)">
          <button
            type="button"
            class="w-full rounded px-2 py-1.5 text-left text-sm leading-snug text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
            @click="emit('jumpToc', item.target)"
          >
            {{ item.label }}
          </button>
        </li>
      </ul>
    </div>

    <!-- 2. 标注与笔记视图 -->
    <div v-else-if="props.tab === 'annotations'" class="flex flex-1 flex-col overflow-hidden space-y-2">
      <!-- 过滤与搜索栏 -->
      <div class="space-y-1.5 shrink-0">
        <div class="flex items-center justify-between gap-1 text-[11px]">
          <div class="flex items-center gap-1">
            <button
              v-for="k in (['all', 'highlight', 'underline', 'note'] as const)"
              :key="k"
              type="button"
              class="rounded px-2 py-0.5 font-medium transition"
              :class="filterKind === k ? 'bg-[var(--color-surface-sunken)] text-[var(--color-text-primary)] font-semibold shadow-xs' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'"
              @click="filterKind = k"
            >
              {{ t(`reader.filter${k.charAt(0).toUpperCase() + k.slice(1)}s`) || k }}
            </button>
          </div>

          <button
            v-if="highlightsAndNotes.length > 0"
            type="button"
            class="shrink-0 text-[10px] text-[var(--color-accent)] hover:underline"
            :title="t('reader.exportNotes')"
            @click="copyMarkdownExport"
          >
            {{ exportCopied ? t('reader.exportCopied') : t('reader.exportNotes') }}
          </button>
        </div>

        <input
          v-model="annotationSearch"
          type="text"
          class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)]"
          :placeholder="t('reader.searchNotes')"
        />
      </div>

      <!-- 标注列表 -->
      <div class="flex-1 overflow-y-auto space-y-2 pr-0.5">
        <div v-if="filteredAnnotations.length === 0" class="py-8 text-center text-xs text-[var(--color-text-tertiary)]">
          {{ t('reader.annotationEmpty') }}
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="ann in filteredAnnotations"
            :key="ann.id"
            class="group rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5 text-xs hover:border-[var(--color-accent)]/50 transition cursor-pointer shadow-xs"
            @click="emit('jumpAnnotation', ann)"
          >
            <div class="flex items-center justify-between text-[10px] text-[var(--color-text-tertiary)] mb-1.5">
              <span class="flex items-center gap-1.5 font-medium">
                <span
                  class="h-2 w-2 rounded-full border border-black/10"
                  :style="{ backgroundColor: (ann.color || '#fef08a').replace(/^(squiggly|strikethrough):/, '') }"
                />
                <span>
                  {{ ann.note ? t('reader.addNote') : ann.type === 'underline' ? t('reader.underline') : t('reader.addHighlight') }}
                </span>
                <span v-if="ann.progression != null" class="opacity-70">
                  · {{ ann.progression }}%
                </span>
              </span>

              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                <button
                  type="button"
                  class="rounded px-1 text-[10px] hover:text-[var(--color-accent)]"
                  :title="t('reader.editNote')"
                  @click.stop="emit('editNote', ann)"
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="rounded px-1 text-[10px] hover:text-red-600"
                  :title="t('common.delete')"
                  @click.stop="emit('deleteAnnotation', ann)"
                >
                  ✕
                </button>
              </div>
            </div>

            <p v-if="ann.text" class="line-clamp-2 text-[11px] text-[var(--color-text-secondary)] italic border-l-2 pl-2 border-[var(--color-accent)]">
              “{{ ann.text }}”
            </p>
            <p v-if="ann.note" class="mt-1.5 font-medium text-[var(--color-text-primary)]">
              {{ ann.note }}
            </p>
          </li>
        </ul>
      </div>
    </div>

    <!-- 3. 书签视图 -->
    <div v-else-if="props.tab === 'bookmarks'" class="flex flex-1 flex-col overflow-hidden space-y-2">
      <!-- 搜索栏 if >= 2 bookmarks -->
      <div v-if="bookmarks.length >= 2" class="shrink-0">
        <input
          v-model="bookmarkSearch"
          type="text"
          class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-amber-400"
          :placeholder="t('reader.searchBookmarks') || '搜索书签…'"
        />
      </div>

      <div class="flex-1 overflow-y-auto space-y-2 pr-0.5">
        <div v-if="filteredBookmarks.length === 0" class="py-8 text-center text-xs text-[var(--color-text-tertiary)] px-4 leading-relaxed">
          {{ bookmarks.length === 0 ? t('reader.bookmarkEmpty') : (t('reader.searchNoResults') || '未找到匹配书签') }}
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="b in filteredBookmarks"
            :key="b.id"
            class="group rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5 text-xs hover:border-amber-400/50 transition cursor-pointer shadow-xs"
            @click="emit('jumpAnnotation', b)"
          >
            <div class="flex items-center justify-between text-[10px] text-[var(--color-text-tertiary)] mb-1">
              <span class="flex items-center gap-1.5 font-semibold text-amber-500">
                <span>★</span>
                <span>{{ b.chapterTitle || t('reader.title') }}</span>
                <span v-if="b.progression != null" class="text-[var(--color-text-tertiary)] font-normal">
                  ({{ b.progression }}%)
                </span>
              </span>

              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                <button
                  type="button"
                  class="rounded px-1 text-[10px] hover:text-amber-500"
                  :title="t('reader.editNote')"
                  @click.stop="emit('editNote', b)"
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="rounded px-1 text-[10px] hover:text-red-600"
                  :title="t('common.delete')"
                  @click.stop="emit('deleteAnnotation', b)"
                >
                  ✕
                </button>
              </div>
            </div>

            <p v-if="b.text" class="line-clamp-2 text-[11px] text-[var(--color-text-secondary)] italic border-l-2 pl-2 border-amber-400 bg-amber-500/5 py-0.5 rounded-r">
              “{{ b.text }}”
            </p>
            <p v-if="b.note" class="mt-1 text-[11px] text-[var(--color-text-primary)] bg-[var(--color-surface-sunken)] p-1 rounded font-medium">
              💭 {{ b.note }}
            </p>
            <p class="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
              {{ b.createdAt.slice(0, 16).replace('T', ' ') }}
            </p>
          </li>
        </ul>
      </div>
    </div>

    <!-- 4. 全文搜索视图 -->
    <div v-else-if="props.tab === 'search'" class="flex-1 overflow-hidden">
      <ReaderSearchPanel
        :open="true"
        :engine="props.engine"
        :compact="props.compact"
        @jump="(cfi) => emit('jumpCfi', cfi)"
        @close="emit('update:tab', 'toc')"
      />
    </div>
  </div>
</template>
