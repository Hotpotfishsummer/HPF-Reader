<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePlatform, type BookRecord } from '@/platform'
import { useViewport } from '@/app/useViewport'
import { contentId, rememberLocalFile } from '@/reader/bookSession'
import { progressSnapshot } from '@/reader/progressStore'
import BookCard from './components/BookCard.vue'
import { useLibraryStore } from './stores/libraryStore'

const { t } = useI18n()
const router = useRouter()
const platform = usePlatform()
const viewport = useViewport()
const library = useLibraryStore()

const fileInputRef = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
const localError = ref<string | null>(null)
/** 本地缓存里的阅读百分比，用来在卡片上显示"读到哪了"。 */
const localProgress = ref<Record<string, number>>({})

/** 桌面端才有原生文件对话框（Go 侧 Dialog）。Web 只有 <input type=file>。 */
const canUseNativeDialog = computed(() => platform.capabilities.includes('files.dialog'))
/** 有没有"本机书库"（Go 侧持久化）。Web 模式没有，所以不显示"导入到书库"。 */
const hasLocalLibrary = computed(() => platform.capabilities.includes('library.local'))

function refreshLocalProgress(): void {
  localProgress.value = progressSnapshot()
}

onMounted(() => {
  void library.refresh()
  refreshLocalProgress()
})

async function onImport(): Promise<void> {
  await library.importBook()
  refreshLocalProgress()
}

function pickLocalFile(): void {
  localError.value = null
  fileInputRef.value?.click()
}

/**
 * ★ 打开本地文件（本地优先的关键路径）。
 *
 * 字节只留在内存里（bookSession），**不需要任何后端**就能开始阅读。
 * id 用与 Go 侧一致的 content id，所以进度 key 和"导入书库后"完全一样：
 * 先直接打开读过、之后再导入，仍然能续读。
 */
async function openFile(file: File): Promise<void> {
  localError.value = null
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('文件是空的')
    const id = await contentId(bytes)
    rememberLocalFile({ id, name: file.name, bytes, sizeBytes: bytes.byteLength })
    await router.push(`/reader/${id}`)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  }
}

async function onFileInput(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 先清空 value：否则连续选同一个文件不会再触发 change。
  input.value = ''
  if (file) await openFile(file)
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) await openFile(file)
}

function readingProgress(book: BookRecord): number {
  return localProgress.value[book.id] ?? 0
}

/** 错误提示不阻塞 UI：书库为空时仍然要显示空态，而不是白屏或红屏。 */
const notice = computed(() => library.error ?? localError.value)
</script>

<template>
  <section
    data-testid="library"
    :data-orientation="viewport.orientation"
    class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8"
    @dragover.prevent="dragActive = true"
    @dragleave.prevent="dragActive = false"
    @drop.prevent="onDrop"
  >
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold sm:text-xl">{{ t('library.title') }}</h1>
        <p v-if="!library.isEmpty" class="mt-1 text-sm text-[var(--color-text-secondary)]">
          {{ t('library.count', { n: library.count }) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          data-testid="open-local"
          type="button"
          class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm hover:bg-[var(--color-surface-sunken)]"
          @click="pickLocalFile"
        >
          {{ t('library.localOpen') }}
        </button>
        <button
          v-if="canUseNativeDialog && hasLocalLibrary"
          data-testid="import-book"
          type="button"
          class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
          :disabled="library.loading"
          @click="onImport"
        >
          {{ library.loading ? t('library.importing') : t('library.import') }}
        </button>
      </div>
    </div>

    <!-- 隐藏的原生文件选择器：所有平台都能用，不依赖 Wails 桥 -->
    <input
      ref="fileInputRef"
      data-testid="local-file-input"
      type="file"
      accept=".epub,.mobi,.azw3,.fb2,.cbz,.pdf,.txt,application/epub+zip"
      class="hidden"
      @change="onFileInput"
    >

    <p
      v-if="notice"
      data-testid="library-notice"
      class="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      {{ notice }}
    </p>

    <p
      v-if="!hasLocalLibrary"
      data-testid="library-local-mode"
      class="mb-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-3 text-sm text-[var(--color-text-secondary)]"
    >
      {{ t('library.noBackend') }}
    </p>

    <!-- 空态：无后端时这里仍然是"可用的空书库"，不是错误页 -->
    <div
      v-if="library.isEmpty"
      data-testid="library-empty"
      class="hpf-rise-in flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-5 py-12 text-center sm:py-16"
      :class="dragActive ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : ''"
    >
      <p class="text-base font-medium">{{ t('library.empty') }}</p>
      <p class="mt-2 max-w-sm text-sm text-[var(--color-text-secondary)]">
        {{ t('library.emptyHint') }}
      </p>
      <p class="mt-1 text-xs text-[var(--color-text-secondary)]">{{ t('library.dropHint') }}</p>
      <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)]"
          @click="pickLocalFile"
        >
          {{ t('library.localOpen') }}
        </button>
        <RouterLink
          to="/reader/sample"
          class="rounded-lg border border-[var(--color-border-subtle)] px-4 py-2 text-sm"
        >
          {{ t('library.openSample') }}
        </RouterLink>
      </div>
    </div>

    <!-- 书库网格：窄屏 2 列，宽屏最多 5 列 -->
    <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
      <!--
        ★ 入场错峰：每张卡按索引给一个 `--stagger`，用 CSS 变量算 animation-delay。
          用 CSS 变量而不是给每张卡写死 delay —— 列表长度是动态的，
          写死的话新导入的书会"没有动画"或者"延迟好几秒才出现"。
          错峰上限 12 档：再多就不是错峰，是一片糊。
      -->
      <BookCard
        v-for="(book, index) in library.books"
        :key="book.id"
        class="hpf-rise-in"
        :style="{ '--stagger': String(Math.min(index, 12)) }"
        :book="book"
        :progress="readingProgress(book)"
        @remove="library.removeBook(book.id)"
      />
    </div>

    <p class="mt-6 text-xs text-[var(--color-text-secondary)]">
      {{ canUseNativeDialog && hasLocalLibrary ? t('library.importHint') : t('library.localOpenHint') }}
    </p>
  </section>
</template>
