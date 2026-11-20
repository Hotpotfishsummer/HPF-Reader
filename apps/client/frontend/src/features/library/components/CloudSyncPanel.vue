<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLibraryStore, type UploadTask } from '../stores/libraryStore'

/**
 * ★ 云端同步面板（上传队列）。
 *
 * 存在的理由：上传是"长耗时 + 会失败 + 需要取消/重试"的操作。
 * 只有一个 loading 布尔值的话，用户点下"上传到云端"之后只能盯着一个
 * 变灰的按钮猜进度 —— 这正是之前"卡了很久也不知道状况怎么样"的来源。
 *
 * 面板放在书库**顶部**（工具栏正下方），所以：
 *   - 进度随时可见（不用滚到页面底部的云端区块去找）；
 *   - 失败原因就地显示（同样不用滚）。
 */
const { t } = useI18n()
const library = useLibraryStore()

const tasks = computed<UploadTask[]>(() => library.uploadTasks)
const visible = computed(() => tasks.value.length > 0)
const running = computed(() => library.uploadRunning)

/** 正在进行的那一本（面板顶部的大进度条用它）。 */
const activeTask = computed(
  () => tasks.value.find((t) => t.state === 'uploading' || t.state === 'preparing') ?? null,
)

function percentOf(task: UploadTask): number {
  if (task.total <= 0) return 0
  return Math.min(100, Math.round((task.loaded / task.total) * 100))
}

const activePercent = computed(() => (activeTask.value ? percentOf(activeTask.value) : 0))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function speedText(task: UploadTask): string {
  if (!task.bytesPerSecond || task.bytesPerSecond <= 0) return ''
  return `${formatSize(task.bytesPerSecond)}/s`
}

function etaText(task: UploadTask): string {
  if (task.total <= 0 || !task.bytesPerSecond || task.bytesPerSecond <= 0) return ''
  const remain = Math.max(0, task.total - task.loaded)
  const seconds = Math.round(remain / task.bytesPerSecond)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return t('library.cloudUploadEta', { seconds })
}

/** 任务状态文案（视图层负责翻译，store 不依赖 i18n）。 */
function stateText(task: UploadTask): string {
  switch (task.state) {
    case 'pending':
      return t('library.cloudUploadQueued')
    case 'preparing':
      return t('library.cloudUploadPreparing')
    case 'uploading':
      return t('library.cloudUploadSending')
    case 'done':
      return t('library.cloudUploadDone')
    case 'skipped':
      return t('library.cloudUploadSkipped')
    case 'canceled':
      return t('library.cloudUploadCanceled')
    case 'failed':
      return t('library.cloudUploadFailed', { reason: task.error ?? '' })
    default:
      return ''
  }
}

function stateTone(task: UploadTask): string {
  switch (task.state) {
    case 'failed':
      return 'text-amber-700'
    case 'done':
    case 'skipped':
      return 'text-[var(--color-accent)]'
    case 'canceled':
      return 'text-[var(--color-text-secondary)]'
    default:
      return 'text-[var(--color-text-secondary)]'
  }
}

/** 失败原因的可读化：把内部 code 映射成用户看得懂的话。 */
function errorText(task: UploadTask): string {
  switch (task.errorCode) {
    case 'stall_timeout':
      return t('library.cloudUploadStall')
    case 'response_timeout':
      return t('library.cloudUploadResponseTimeout')
    case 'network_error':
      return t('library.cloudUploadNetwork')
    case 'need-login':
      return t('library.cloudNeedLogin')
    case 'canceled':
      return t('library.cloudUploadCanceled')
    case 'quota_exceeded':
      return t('library.cloudUploadQuota')
    default:
      return task.error ?? ''
  }
}

function retry(task: UploadTask): void {
  void library.retryUpload(task.bookId)
}
</script>

<template>
  <section
    v-if="visible"
    data-testid="cloud-sync-panel"
    class="mb-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-3"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold">{{ t('library.cloudSyncTitle') }}</h3>
        <p class="mt-0.5 text-xs text-[var(--color-text-secondary)]">
          {{ t('library.cloudSyncSummary', { done: library.uploadSummary.done, total: library.uploadSummary.total }) }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="running"
          data-testid="cloud-sync-cancel"
          type="button"
          class="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs font-medium hover:bg-[var(--color-surface-sunken)]"
          @click="library.cancelUpload"
        >
          {{ t('library.cloudUploadCancel') }}
        </button>
        <button
          v-else
          data-testid="cloud-sync-dismiss"
          type="button"
          class="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs hover:bg-[var(--color-surface-sunken)]"
          @click="library.clearFinishedUploads"
        >
          {{ t('library.cloudUploadDismiss') }}
        </button>
      </div>
    </div>

    <!-- 总体进度条（只在正在传的时候显示） -->
    <div v-if="running" class="mt-3">
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
        <div
          data-testid="cloud-sync-progress-bar"
          class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200"
          :style="{ width: activePercent + '%' }"
        />
      </div>
      <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
        {{ t('library.cloudUploadPercent', { percent: activePercent }) }}
      </p>
    </div>

    <ul class="mt-3 space-y-2">
      <li
        v-for="task in tasks"
        :key="task.bookId"
        data-testid="cloud-sync-task"
        :data-state="task.state"
        class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-2"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="min-w-0 flex-1 truncate text-sm" :title="task.title">{{ task.title }}</p>
          <p class="text-xs" :class="stateTone(task)">{{ stateText(task) }}</p>
        </div>

        <!-- 单本进度 -->
        <div v-if="task.state === 'uploading'" class="mt-1.5">
          <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
            <div
              data-testid="cloud-sync-task-bar"
              class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200"
              :style="{ width: percentOf(task) + '%' }"
            />
          </div>
          <p class="mt-1 text-[11px] text-[var(--color-text-secondary)]">
            {{ percentOf(task) }}% · {{ formatSize(task.loaded) }} / {{ formatSize(task.total) }}
            <span v-if="speedText(task)"> · {{ speedText(task) }}</span>
            <span v-if="etaText(task)"> · {{ etaText(task) }}</span>
          </p>
        </div>

        <!-- 失败原因就地可见 + 可重试 -->
        <div v-if="task.state === 'failed'" class="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <p data-testid="cloud-sync-task-error" class="text-xs text-amber-700">
            {{ errorText(task) }}
          </p>
          <button
            data-testid="cloud-sync-task-retry"
            type="button"
            class="rounded-md border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-surface-sunken)]"
            @click="retry(task)"
          >
            {{ t('library.cloudUploadRetry') }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
