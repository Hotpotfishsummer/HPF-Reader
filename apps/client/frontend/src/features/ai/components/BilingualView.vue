<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/api'
import type { TranslationChunk } from '@/api/contract'

const props = defineProps<{
  bookId: string
  currentChapterIndex: number
  jobId?: string | null
}>()

const emit = defineEmits<{
  close: []
  'jump-to-chapter': [index: number]
}>()

const { t } = useI18n()
const api = useApi()

const loading = ref(false)
const error = ref<string | null>(null)
const chunks = ref<TranslationChunk[]>([])
const activeJobId = ref<string | null>(props.jobId ?? null)
const viewMode = ref<'bilingual' | 'targetOnly'>('bilingual')
const filterCurrentChapter = ref(false)

async function loadChunks(): Promise<void> {
  if (!api) return
  loading.value = true
  error.value = null
  try {
    let jid = activeJobId.value
    if (!jid) {
      // 自动查找该书最新的整书翻译任务
      const jobs = await api.ai.listJobs({ bookId: props.bookId, limit: 10 })
      const translateJob = jobs.find((j: { kind: string; id: string }) => j.kind === 'book_translate')
      if (translateJob) {
        jid = translateJob.id
        activeJobId.value = jid
      }
    }
    if (!jid) {
      chunks.value = []
      return
    }
    const res = await api.ai.getJobChunks(jid)
    chunks.value = res.chunks.filter((c: TranslationChunk) => c.status === 'done' && c.outputText)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadChunks()
})

watch(() => [props.bookId, props.jobId], () => {
  activeJobId.value = props.jobId ?? null
  void loadChunks()
})

const displayedChunks = computed(() => {
  if (filterCurrentChapter.value) {
    return chunks.value.filter((c) => c.chapterIndex === props.currentChapterIndex)
  }
  return chunks.value
})

const hasChunks = computed(() => chunks.value.length > 0)

function exportTranslation(): void {
  if (chunks.value.length === 0) return
  const lines: string[] = []
  let lastChapter = -1
  for (const c of chunks.value) {
    if (c.chapterIndex !== lastChapter) {
      lastChapter = c.chapterIndex
      lines.push(`\n\n# Chapter ${lastChapter + 1}\n`)
    }
    lines.push(c.outputText || '')
  }
  const content = lines.join('\n\n')
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `translation-${props.bookId}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 忽略剪贴板错误
  }
}
</script>

<template>
  <div
    data-testid="bilingual-panel"
    class="absolute right-0 top-12 z-30 flex h-[calc(100%-3rem)] w-[min(94vw,36rem)] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl backdrop-blur"
  >
    <!-- 头部工具栏 -->
    <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2.5">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-[var(--color-text-primary)]">{{ t('reader.bilingual') }}</h2>
        <span v-if="chunks.length > 0" class="rounded bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
          {{ chunks.length }} 块已译
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="hasChunks"
          type="button"
          class="rounded px-2 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-surface-sunken)]"
          :title="t('reader.exportTranslation')"
          @click="exportTranslation"
        >
          {{ t('reader.exportTranslation') }}
        </button>
        <button
          type="button"
          class="rounded p-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 筛选与模式控制 -->
    <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-2 text-xs">
      <div class="flex items-center gap-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-0.5">
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] transition"
          :class="viewMode === 'bilingual' ? 'bg-[var(--color-accent)] text-white font-medium' : 'text-[var(--color-text-secondary)]'"
          @click="viewMode = 'bilingual'"
        >
          双语对照
        </button>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] transition"
          :class="viewMode === 'targetOnly' ? 'bg-[var(--color-accent)] text-white font-medium' : 'text-[var(--color-text-secondary)]'"
          @click="viewMode = 'targetOnly'"
        >
          仅看译文
        </button>
      </div>

      <label class="flex items-center gap-1.5 cursor-pointer text-[11px] text-[var(--color-text-secondary)]">
        <input
          v-model="filterCurrentChapter"
          type="checkbox"
          class="h-3.5 w-3.5 rounded border-gray-300 accent-[var(--color-accent)]"
        />
        <span>仅看当前章</span>
      </label>
    </div>

    <!-- 内容列表 -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <div v-if="loading" class="flex items-center justify-center py-12 text-xs text-[var(--color-text-secondary)]">
        正在读取译文分块…
      </div>

      <div v-else-if="error" class="rounded-lg bg-red-50 p-3 text-xs text-red-700">
        {{ error }}
      </div>

      <div v-else-if="!hasChunks" class="py-16 text-center text-xs text-[var(--color-text-secondary)]">
        {{ t('reader.bilingualEmpty') }}
      </div>

      <div
        v-for="chunk in displayedChunks"
        v-else
        :key="chunk.chunkIndex"
        class="group rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 text-xs shadow-sm space-y-2 hover:border-[var(--color-accent)]/50 transition"
      >
        <div class="flex items-center justify-between text-[10px] text-[var(--color-text-tertiary)]">
          <span>第 {{ chunk.chapterIndex + 1 }} 章 · 块 #{{ chunk.chunkIndex + 1 }}</span>
          <div class="flex items-center gap-2">
            <button
              v-if="chunk.chapterIndex !== props.currentChapterIndex"
              type="button"
              class="text-[var(--color-accent)] hover:underline"
              @click="emit('jump-to-chapter', chunk.chapterIndex)"
            >
              跳转至本章
            </button>
            <button
              type="button"
              class="opacity-0 group-hover:opacity-100 hover:text-[var(--color-text-primary)] transition"
              @click="copyText(chunk.outputText || '')"
            >
              复制
            </button>
          </div>
        </div>

        <!-- 双语展示模式 -->
        <div v-if="viewMode === 'bilingual'" class="space-y-2">
          <p class="leading-relaxed text-[var(--color-text-secondary)] border-b border-[var(--color-border-subtle)] pb-2 font-serif select-text">
            {{ chunk.sourceText }}
          </p>
          <p class="leading-relaxed text-[var(--color-text-primary)] font-medium select-text">
            {{ chunk.outputText }}
          </p>
        </div>

        <!-- 纯译文模式 -->
        <div v-else>
          <p class="leading-relaxed text-[var(--color-text-primary)] select-text">
            {{ chunk.outputText }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
