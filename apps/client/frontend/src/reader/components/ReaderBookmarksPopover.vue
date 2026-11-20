<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AnnotationItem } from '../annotationStore'

const props = defineProps<{
  open: boolean
  bookmarks: AnnotationItem[]
  currentCfi?: string
  currentChapter?: string
  isCurrentBookmarked?: boolean
}>()

const emit = defineEmits<{
  close: []
  jump: [bookmark: AnnotationItem]
  delete: [bookmark: AnnotationItem]
  toggleCurrent: []
  updateNote: [bookmark: AnnotationItem, note: string]
}>()

const { t } = useI18n()

const searchQuery = ref('')
const editingId = ref<string | null>(null)
const editingNoteText = ref('')
const noteInputRef = ref<HTMLInputElement | null>(null)
const copiedId = ref<string | null>(null)

const filteredBookmarks = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.bookmarks
  return props.bookmarks.filter((b) => {
    const title = (b.chapterTitle ?? '').toLowerCase()
    const text = (b.text ?? '').toLowerCase()
    const note = (b.note ?? '').toLowerCase()
    return title.includes(q) || text.includes(q) || note.includes(q)
  })
})

function startEditNote(b: AnnotationItem): void {
  editingId.value = b.id
  editingNoteText.value = b.note ?? ''
  void nextTick(() => {
    noteInputRef.value?.focus()
  })
}

function saveEditNote(b: AnnotationItem): void {
  emit('updateNote', b, editingNoteText.value.trim())
  editingId.value = null
  editingNoteText.value = ''
}

function cancelEditNote(): void {
  editingId.value = null
  editingNoteText.value = ''
}

async function copyExcerpt(b: AnnotationItem): Promise<void> {
  const content = b.text ? `“${b.text}” —— 《${b.chapterTitle || ''}》` : b.chapterTitle || ''
  if (!content) return
  try {
    await navigator.clipboard.writeText(content)
    copiedId.value = b.id
    setTimeout(() => {
      if (copiedId.value === b.id) copiedId.value = null
    }, 1500)
  } catch {
    // 忽略剪贴板错误
  }
}

function isCurrentPage(b: AnnotationItem): boolean {
  if (!props.currentCfi) return false
  return b.cfi === props.currentCfi
}
</script>

<template>
  <div
    v-if="props.open"
    data-testid="reader-bookmarks-popover"
    class="absolute left-2 sm:left-20 top-14 z-30 flex max-h-[calc(100vh-4.5rem)] w-[min(94vw,26rem)] flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl overflow-hidden transition-all text-xs"
  >
    <!-- 顶栏标题与统计 -->
    <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2.5 bg-[var(--color-surface)]">
      <div class="flex items-center gap-2">
        <span class="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/15 text-amber-500 font-bold text-sm">
          ★
        </span>
        <div class="flex flex-col">
          <div class="flex items-center gap-1.5 font-semibold text-[var(--color-text-primary)]">
            <span>{{ t('reader.bookmarksView') || '书签查看' }}</span>
            <span
              v-if="props.bookmarks.length > 0"
              class="rounded-full bg-amber-500/10 px-1.5 py-0.2 text-[10px] font-medium text-amber-600 dark:text-amber-400 tabular-nums"
            >
              {{ props.bookmarks.length }}
            </span>
          </div>
          <span class="text-[10px] text-[var(--color-text-tertiary)]">
            {{ t('reader.bookmarkCount', { n: props.bookmarks.length }) || `共 ${props.bookmarks.length} 条书签` }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1">
        <!-- 快捷标记/取消当前页 -->
        <button
          type="button"
          data-testid="popover-toggle-current"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition"
          :class="props.isCurrentBookmarked
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25'
            : 'bg-[var(--color-surface-sunken)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border-subtle)]'"
          :title="props.isCurrentBookmarked ? t('reader.unmarkCurrentPage') : t('reader.markCurrentPage')"
          @click="emit('toggleCurrent')"
        >
          <span>{{ props.isCurrentBookmarked ? '★' : '☆' }}</span>
          <span>{{ props.isCurrentBookmarked ? (t('reader.unmarkCurrentPage') || '取消本页标记') : (t('reader.markCurrentPage') || '标记本页') }}</span>
        </button>

        <button
          type="button"
          data-testid="close-bookmarks-popover"
          class="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
          :title="t('common.close') || '关闭'"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 搜索过滤条（当书签数 >= 2 时显示） -->
    <div v-if="props.bookmarks.length >= 2" class="border-b border-[var(--color-border-subtle)] p-2 bg-[var(--color-surface-sunken)]/50">
      <div class="relative flex items-center">
        <span class="absolute left-2.5 text-xs text-[var(--color-text-tertiary)] select-none">🔍</span>
        <input
          v-model="searchQuery"
          data-testid="bookmarks-search-input"
          type="text"
          class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] pl-7 pr-7 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-amber-400"
          :placeholder="t('reader.searchBookmarks') || '搜索章节、引文或备注…'"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="absolute right-2 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          @click="searchQuery = ''"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 书签卡片列表 -->
    <div class="flex-1 overflow-y-auto p-2.5 space-y-2">
      <!-- 空状态 -->
      <div
        v-if="filteredBookmarks.length === 0"
        data-testid="bookmarks-empty"
        class="flex flex-col items-center justify-center py-8 text-center text-[var(--color-text-tertiary)] px-4"
      >
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 text-lg">
          ★
        </div>
        <p class="font-semibold text-xs text-[var(--color-text-secondary)]">
          {{ props.bookmarks.length === 0 ? (t('reader.bookmarkEmpty') || '当前书籍暂无书签') : (t('reader.searchNoResults') || '未找到匹配书签') }}
        </p>
        <p v-if="props.bookmarks.length === 0" class="mt-1 text-[11px] leading-relaxed max-w-xs">
          阅读时按 <kbd class="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-1 py-0.5 font-mono text-[10px]">Ctrl+B</kbd> 或点击上方按钮即可收藏当前阅读位置。
        </p>
      </div>

      <!-- 书签列表项 -->
      <ul v-else class="space-y-2">
        <li
          v-for="b in filteredBookmarks"
          :key="b.id"
          data-testid="bookmark-item"
          class="group relative flex flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5 transition hover:border-amber-400/60 hover:shadow-sm cursor-pointer"
          :class="{ 'ring-1 ring-amber-400/80 bg-amber-500/5': isCurrentPage(b) }"
          @click="emit('jump', b)"
        >
          <!-- 头部：章节名、进度与操作 -->
          <div class="flex items-center justify-between text-[11px] mb-1.5">
            <div class="flex min-w-0 items-center gap-1.5 font-semibold text-[var(--color-text-primary)]">
              <span class="text-amber-500 shrink-0">★</span>
              <span class="truncate" :title="b.chapterTitle">{{ b.chapterTitle || t('reader.title') }}</span>
              <span v-if="b.progression != null" class="shrink-0 text-[10px] font-normal text-[var(--color-text-tertiary)]">
                ({{ b.progression }}%)
              </span>
              <span
                v-if="isCurrentPage(b)"
                class="shrink-0 rounded bg-amber-500 px-1 py-0.2 text-[9px] font-bold text-white shadow-xs"
              >
                {{ t('reader.currentPage') || '当前页' }}
              </span>
            </div>

            <div class="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition">
              <!-- 编辑备注 -->
              <button
                type="button"
                class="rounded p-0.5 text-[var(--color-text-tertiary)] hover:text-amber-500 hover:bg-[var(--color-surface-sunken)]"
                :title="t('reader.editBookmarkNote') || '编辑备注'"
                @click.stop="startEditNote(b)"
              >
                ✎
              </button>
              <!-- 复制引文 -->
              <button
                v-if="b.text"
                type="button"
                class="rounded p-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-sunken)]"
                :title="copiedId === b.id ? '已复制' : '复制引文'"
                @click.stop="copyExcerpt(b)"
              >
                {{ copiedId === b.id ? '✓' : '⧉' }}
              </button>
              <!-- 删除 -->
              <button
                type="button"
                class="rounded p-0.5 text-[var(--color-text-tertiary)] hover:text-red-600 hover:bg-[var(--color-surface-sunken)]"
                :title="t('common.delete') || '删除书签'"
                @click.stop="emit('delete', b)"
              >
                ✕
              </button>
            </div>
          </div>

          <!-- 段落摘要文本 (Excerpt) -->
          <p
            v-if="b.text"
            class="line-clamp-3 text-[11px] text-[var(--color-text-secondary)] italic border-l-2 border-amber-400/70 pl-2 py-0.5 bg-amber-500/5 rounded-r"
          >
            “{{ b.text }}”
          </p>

          <!-- 用户备注展示区 -->
          <div v-if="b.note && editingId !== b.id" class="mt-1.5 flex items-start gap-1 rounded bg-[var(--color-surface-sunken)] px-2 py-1 text-[11px] text-[var(--color-text-primary)]">
            <span class="text-amber-500 shrink-0 select-none">💭</span>
            <span class="break-words font-medium">{{ b.note }}</span>
          </div>

          <!-- 编辑备注表单 -->
          <div
            v-if="editingId === b.id"
            class="mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-400/80 bg-[var(--color-surface)] p-1.5"
            @click.stop
          >
            <input
              ref="noteInputRef"
              v-model="editingNoteText"
              type="text"
              class="flex-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-amber-400"
              :placeholder="t('reader.bookmarkNotePlaceholder') || '写点书签备注…'"
              @keydown.enter="saveEditNote(b)"
              @keydown.esc="cancelEditNote"
            />
            <button
              type="button"
              class="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-600"
              @click="saveEditNote(b)"
            >
              {{ t('reader.saveNote') || '保存' }}
            </button>
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-sunken)]"
              @click="cancelEditNote"
            >
              {{ t('common.cancel') || '取消' }}
            </button>
          </div>

          <!-- 底部时间戳与跳转提示 -->
          <div class="mt-1.5 flex items-center justify-between text-[10px] text-[var(--color-text-tertiary)]">
            <span>{{ b.createdAt ? b.createdAt.slice(0, 16).replace('T', ' ') : '' }}</span>
            <span class="font-medium text-amber-600 dark:text-amber-400 group-hover:underline">
              {{ t('reader.jumpToBookmark') || '跳转至此' }} →
            </span>
          </div>
        </li>
      </ul>
    </div>

    <!-- 底栏说明信息 -->
    <div class="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)]/60 px-3 py-1.5 text-[10px] text-[var(--color-text-tertiary)] flex items-center justify-between select-none">
      <span>💡 基于 EPUB 结构化定位，不受页面缩放影响</span>
      <span>快捷键 <kbd class="font-mono">Ctrl+B</kbd></span>
    </div>
  </div>
</template>
