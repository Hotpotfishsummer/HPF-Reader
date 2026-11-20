<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePlatform, type BookRecord } from '@/platform'
import { useViewport } from '@/app/useViewport'
import { contentId, rememberLocalFile } from '@/reader/bookSession'
import { txtToEpub } from '@/reader/txtParser'
import { progressSnapshot } from '@/reader/progressStore'
import BookCard from './components/BookCard.vue'
import CloudSyncPanel from './components/CloudSyncPanel.vue'
import { hasCloudFile, normalizeContentHash, useLibraryStore } from './stores/libraryStore'
import { useAuthStore } from '@/stores/auth'
import { openAuthModal } from '@/features/auth/useAuthModal'

const { t } = useI18n()
const router = useRouter()
const platform = usePlatform()
const viewport = useViewport()
const library = useLibraryStore()
const auth = useAuthStore()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const fileInputRef = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
const localError = ref<string | null>(null)
/** 本地缓存里的阅读百分比，用来在卡片上显示"读到哪了"。 */
const localProgress = ref<Record<string, number>>({})
/** 批量上传进行中（禁用按钮，防重复点击）。 */
const bulkUploading = ref(false)

/**
 * ★ 批量上传的实时文案（按钮上直接显示"传到第几本 + 百分之多少"）。
 *
 * 之前只有 `:disabled="bulkUploading"`：按钮变灰、没有文字变化、
 * 没有百分比 —— 用户完全无法判断是在传、在卡住，还是已经失败。
 */
const bulkProgress = computed(() => {
  if (!library.uploadRunning) return null
  const tasks = library.uploadTasks
  const active = tasks.find((t) => t.state === 'uploading' || t.state === 'preparing')
  const index = tasks.filter((t) => t.state !== 'pending').length
  const percent =
    active && active.total > 0 ? Math.min(100, Math.round((active.loaded / active.total) * 100)) : 0
  return { index, total: tasks.length, percent }
})

/** 桌面端才有原生文件对话框（Go 侧 Dialog）。Web 只有 <input type=file>。 */
const canUseNativeDialog = computed(() => platform.capabilities.includes('files.dialog'))
/** 有没有"本机书库"（Go 侧持久化）。Web 模式没有，所以不显示"导入到书库"。 */
const hasLocalLibrary = computed(() => platform.capabilities.includes('library.local'))
/** 能力位探测：没有本地书库时**隐藏下载入口**（只读展示云端列表）。 */
const canDownloadToLocal = computed(() => hasLocalLibrary.value)

/** 本地书是否已在云端（按归一化 contentHash 匹配，因为两边 id 空间不同）。 */
const cloudHashSet = computed(() => new Set(library.cloudBooks.map((b) => normalizeContentHash(b.contentHash))))

/** 本次会话刚下载成功的云端条目 id（用于显示"已下载并入库"）。 */
const cloudDownloadedIds = ref<Set<string>>(new Set())

/** 云端书的展示状态：刚下载 / 本地已有 / 仅云端。 */
function cloudStatusOf(cloudBook: BookRecord): 'downloaded' | 'local' | 'remote' {
  if (cloudDownloadedIds.value.has(cloudBook.id)) return 'downloaded'
  return library.localHasHash(cloudBook.contentHash) ? 'local' : 'remote'
}

function localBookInCloud(book: BookRecord): boolean {
  return cloudHashSet.value.has(normalizeContentHash(book.contentHash))
}

/** 云端条目对应的本地书（用于"补传"：云端有元数据但没文件）。 */
function localBookForCloud(cloudBook: BookRecord): BookRecord | null {
  return library.localBookByHash(cloudBook.contentHash)
}

/** 下载进度百分比（字节）。 */
function downloadPercent(cloudBook: BookRecord): number {
  const p = library.downloadProgress
  if (!p || p.bookId !== cloudBook.id) return 0
  const total = p.total > 0 ? p.total : cloudBook.sizeBytes
  if (!total) return 0
  return Math.min(100, Math.round((p.loaded / total) * 100))
}

/** 某本书的上传进度百分比（卡片按钮上的小进度）。 */
function uploadPercentOf(bookId: string): number | null {
  const task = library.uploadTasks.find((t) => t.bookId === bookId)
  if (!task) return null
  if (task.state === 'done' || task.state === 'skipped') return 100
  if (task.total <= 0) return null
  return Math.min(100, Math.round((task.loaded / task.total) * 100))
}

/**
 * ★ 还有多少本地书没在云端（工具栏"上传到云端"按钮上的计数）。
 *
 * 判据与 store 一致：**云端条目必须真的有文件**才算上传完成，
 * 否则失败的上传会被算成"已完成"，用户永远看不到重传入口。
 */
const pendingUploadCount = computed(() => {
  const done = new Set(
    library.cloudBooks.filter((b) => hasCloudFile(b)).map((b) => normalizeContentHash(b.contentHash)),
  )
  return library.displayBooks.filter((b) => !done.has(normalizeContentHash(b.contentHash))).length
})

/** 云端错误用结构化 code -> i18n 文案（store 不依赖 i18n）。 */
const cloudErrorText = computed<string | null>(() => {
  const err = library.cloudError
  if (!err) return null
  if (err.code === 'hash-mismatch') return t('library.cloudHashMismatch')
  if (err.code === 'need-login') return t('library.cloudNeedLogin')
  if (err.code === 'no-file') return t('library.cloudNoFile')
  return t('library.cloudFailed', { msg: err.message ?? '' })
})

async function handleUpload(book: BookRecord): Promise<void> {
  localError.value = null
  // 未登录：把用户送到登录弹窗，而不是静默失败（入口必须一直看得见）。
  if (!auth.isAuthenticated) {
    openAuthModal()
    return
  }
  // 失败原因由 store 写进 cloudError，并在云端区块就地展示。
  await library.uploadToCloud(book)
}

/** 工具栏的批量上传：把本地书一本本传到云端。 */
async function handleUploadAll(): Promise<void> {
  if (!auth.isAuthenticated) {
    openAuthModal()
    return
  }
  bulkUploading.value = true
  try {
    await library.uploadAllToCloud()
  } finally {
    bulkUploading.value = false
  }
}

async function onDownloadCloud(cloudBook: BookRecord): Promise<void> {
  const record = await library.downloadCloud(cloudBook.id)
  if (!record) return
  cloudDownloadedIds.value = new Set([...cloudDownloadedIds.value, cloudBook.id])
  refreshLocalProgress()
}

function refreshLocalProgress(): void {
  localProgress.value = progressSnapshot()
}

onMounted(() => {
  void library.refresh()
  refreshLocalProgress()
  // 未登录时 store 内部直接返回，零请求（UI 显示 cloudNeedLogin）。
  void library.refreshCloud()
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
 *
 * ★ 这条路径上的书**也要出现在书库网格里**：否则用户在这条路径上
 *   完全看不到"上传到云端"的入口（这正是"客户端找不到书籍上传 UI"的一半原因）。
 */
async function openFile(file: File): Promise<void> {
  localError.value = null
  try {
    let finalFile = file
    let bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('文件是空的')
    if (file.name.toLowerCase().endsWith('.txt')) {
      finalFile = txtToEpub(file.name, bytes)
      bytes = new Uint8Array(await finalFile.arrayBuffer())
    }
    const id = await contentId(bytes)
    const payload = rememberLocalFile({ id, name: finalFile.name, bytes, sizeBytes: bytes.byteLength })
    library.registerSessionBook(payload.book)
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
        <!--
          ★ 显式的"上传到云端"入口。
          原来上传只能靠书卡上那个 ☁️ emoji，用户根本找不到；
          这里给出带文字、带待传数量的主入口。
        -->
        <button
          v-if="library.displayBooks.length > 0"
          data-testid="cloud-upload-all"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-accent)] px-3 py-2 text-sm text-[var(--color-accent)] transition hover:bg-[var(--color-surface-sunken)] disabled:opacity-70"
          :disabled="bulkUploading"
          :title="auth.isAuthenticated ? t('library.cloudUpload') : t('library.cloudNeedLogin')"
          @click="handleUploadAll"
        >
          <span
            v-if="bulkUploading"
            data-testid="cloud-upload-spinner"
            aria-hidden="true"
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span v-else aria-hidden="true">☁️</span>
          <span v-if="bulkProgress" data-testid="cloud-upload-progress">
            {{ t('library.cloudUploadingProgress', { index: bulkProgress.index, total: bulkProgress.total, percent: bulkProgress.percent }) }}
          </span>
          <span v-else>{{ t('library.cloudUpload') }}</span>
          <span
            v-if="pendingUploadCount > 0 && !bulkProgress"
            data-testid="cloud-upload-pending"
            class="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-contrast)]"
          >
            {{ pendingUploadCount }}
          </span>
        </button>
      </div>
    </div>

    <!--
      ★ 云端同步面板：上传队列（进度 / 速度 / 剩余时间 / 取消 / 重试 / 失败原因）。
      放在工具栏正下方 ⇒ 进度与错误**不用滚到页面底部**就能看到。
    -->
    <CloudSyncPanel />

    <!--
      ★ 云端同步说明 + 登录入口。
      未登录时**不隐藏**云端功能，只提示需要登录（入口可见才可能被使用）。
    -->
    <div
      data-testid="cloud-entry-hint"
      class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-3 text-sm text-[var(--color-text-secondary)]"
    >
      <span>{{ t('library.cloudEntryHint') }}</span>
      <button
        v-if="!auth.isAuthenticated"
        data-testid="cloud-entry-login"
        type="button"
        class="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-sunken)]"
        @click="openAuthModal"
      >
        {{ t('auth.login') }}
      </button>
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
      v-if="library.displayBooks.length === 0"
      data-testid="library-empty"
      class="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-5 py-12 text-center sm:py-16"
      :class="dragActive ? 'ring-2 ring-[var(--color-accent)]' : ''"
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
      <BookCard
        v-for="book in library.displayBooks"
        :key="book.id"
        :book="book"
        :progress="readingProgress(book)"
        :can-upload="true"
        :need-login="!auth.isAuthenticated"
        :in-cloud="localBookInCloud(book)"
        :uploading="library.uploadingId === book.id"
        :upload-percent="uploadPercentOf(book.id)"
        :removable="library.books.some((b) => b.id === book.id)"
        :session-only="!library.books.some((b) => b.id === book.id)"
        @remove="library.removeBook(book.id)"
        @upload="handleUpload(book)"
      />
    </div>

    <!-- ===== 云端书库（书籍文件同步，task-5）===== -->
    <section data-testid="cloud-library" class="mt-10 border-t border-[var(--color-border-subtle)] pt-6">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">{{ t('library.cloudTitle') }}</h2>
          <p class="mt-1 text-sm text-[var(--color-text-secondary)]">{{ t('library.cloudDesc') }}</p>
          <p
            v-if="auth.isAuthenticated"
            data-testid="cloud-summary"
            class="mt-1 text-xs text-[var(--color-text-secondary)]"
          >
            {{ t('library.cloudSummary', { cloud: library.cloudCount, local: library.count }) }}
          </p>
        </div>
        <button
          v-if="auth.isAuthenticated"
          data-testid="cloud-refresh"
          type="button"
          class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-2 text-sm hover:bg-[var(--color-surface-sunken)] disabled:opacity-50"
          :disabled="library.cloudLoading"
          @click="library.refreshCloud"
        >
          {{ t('library.cloudRefresh') }}
        </button>
      </div>

      <p
        v-if="!auth.isAuthenticated"
        data-testid="cloud-need-login"
        class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-3 text-sm text-[var(--color-text-secondary)]"
      >
        {{ t('library.cloudNeedLogin') }}
      </p>
      <template v-else>
        <p
          v-if="cloudErrorText"
          data-testid="cloud-error"
          class="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {{ cloudErrorText }}
        </p>

        <p
          v-if="library.cloudBooks.length === 0"
          data-testid="cloud-empty"
          class="rounded-lg border border-dashed border-[var(--color-border-subtle)] px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]"
        >
          {{ t('library.cloudEmpty') }}
        </p>

        <ul
          v-else
          class="divide-y divide-[var(--color-border-subtle)] rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]"
        >
          <li
            v-for="cloudBook in library.cloudBooks"
            :key="cloudBook.id"
            data-testid="cloud-book"
            :data-book-id="cloudBook.id"
            class="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-medium" :title="cloudBook.title">{{ cloudBook.title }}</p>
              <p class="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                {{ cloudBook.author || '—' }} · {{ (cloudBook.format || 'epub').toUpperCase() }} ·
                {{ formatSize(cloudBook.sizeBytes) }}
              </p>
              <!--
                ★ 下载进度（就地显示）：下载大书时不再只有一个转圈的按钮。
              -->
              <p
                v-if="library.downloadingId === cloudBook.id && library.downloadProgress"
                data-testid="cloud-download-progress"
                class="mt-1 text-xs text-[var(--color-accent)]"
              >
                {{ t('library.cloudDownloadPercent', { percent: downloadPercent(cloudBook) }) }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <span
                v-if="cloudStatusOf(cloudBook) === 'downloaded'"
                data-testid="cloud-status-downloaded"
                class="text-xs text-[var(--color-accent)]"
              >
                {{ t('library.cloudDownloaded') }}
              </span>
              <span
                v-else-if="cloudStatusOf(cloudBook) === 'local'"
                data-testid="cloud-status-local"
                class="text-xs text-[var(--color-text-secondary)]"
              >
                {{ t('library.cloudInLocal') }}
              </span>
              <!--
                ★ 云端条目没有文件（只建了元数据 / 上传失败）时**不给下载按钮**：
                点了必然撞 404 "book file has not been uploaded yet"，
                与其让用户撞一堵墙，不如如实告诉他这条还没传完。
                ★ 但如果本地正好有同一份文件，就给一个"补传"入口 ——
                否则这条会永远卡在"文件未上传"状态。
              -->
              <template v-else-if="!hasCloudFile(cloudBook)">
                <span
                  data-testid="cloud-status-nofile"
                  class="text-xs text-amber-600"
                >
                  {{ t('library.cloudNoFile') }}
                </span>
                <button
                  v-if="localBookForCloud(cloudBook)"
                  data-testid="cloud-reupload"
                  type="button"
                  class="rounded-md border border-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-surface-sunken)] disabled:opacity-50"
                  :disabled="library.uploadingId !== null"
                  @click="handleUpload(localBookForCloud(cloudBook)!)"
                >
                  {{ t('library.cloudReupload') }}
                </button>
              </template>
              <button
                v-else-if="canDownloadToLocal"
                data-testid="cloud-download"
                type="button"
                class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)] disabled:opacity-50"
                :disabled="library.downloadingId === cloudBook.id"
                @click="onDownloadCloud(cloudBook)"
              >
                {{ library.downloadingId === cloudBook.id ? t('library.cloudDownloading') : t('library.cloudDownload') }}
              </button>
              <!-- ★ 下载大书同样可能卡住：给一个明确的取消出口。 -->
              <button
                v-if="library.downloadingId === cloudBook.id"
                data-testid="cloud-download-cancel"
                type="button"
                class="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs hover:bg-[var(--color-surface-sunken)]"
                @click="library.cancelDownload"
              >
                {{ t('library.cloudDownloadCancel') }}
              </button>
            </div>
          </li>
        </ul>
      </template>
    </section>

    <p class="mt-6 text-xs text-[var(--color-text-secondary)]">
      {{ canUseNativeDialog && hasLocalLibrary ? t('library.importHint') : t('library.localOpenHint') }}
    </p>
  </section>
</template>
