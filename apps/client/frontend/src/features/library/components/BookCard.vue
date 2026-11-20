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
    /** 是否可同步至云端。 */
    canUpload?: boolean
    /** 云端是否已有同内容哈希的条目（有则显示"已上传到云端"）。 */
    inCloud?: boolean
    /** 正在上传（禁用按钮，防重复点击）。 */
    uploading?: boolean
    /** 上传进度百分比（0-100）；null 表示还拿不到进度。 */
    uploadPercent?: number | null
    /** 未登录时上传按钮仍然可见，但提示需要登录（而不是把入口藏起来）。 */
    needLogin?: boolean
    /** 这本书只在本次会话里打开过（没进本地书库索引）。 */
    sessionOnly?: boolean
  }>(),
  {
    progress: 0,
    removable: true,
    canUpload: false,
    inCloud: false,
    uploading: false,
    uploadPercent: null,
    needLogin: false,
    sessionOnly: false,
  },
)
const emit = defineEmits<{ remove: []; upload: [] }>()

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
    class="group relative flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 transition-shadow hover:shadow-md"
  >
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
        <div class="h-full rounded-full bg-[var(--color-accent)]" :style="{ width: `${props.progress}%` }" />
      </div>
      <p data-testid="book-progress" class="mt-1 text-[11px] text-[var(--color-text-secondary)]">
        {{ t('library.progress', { n: props.progress }) }}
      </p>
    </div>

    <div class="mt-3 flex items-center justify-between">
      <RouterLink
        :to="`/reader/${props.book.id}`"
        class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)]"
      >
        {{ t('library.read') }}
      </RouterLink>
      <div class="flex items-center gap-1">
        <span
          v-if="props.inCloud"
          data-testid="book-in-cloud"
          class="rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)]"
        >
          {{ t('library.cloudUploaded') }}
        </span>
        <!--
          ★ 上传入口必须是**带文字的按钮**：原来只有一个 ☁️ emoji，
          用户根本找不到（"客户端没有书籍的上传 UI"）。
          未登录时不隐藏入口，改为提示需要登录 —— 藏起来等于功能不存在。
        -->
        <button
          v-if="props.canUpload"
          type="button"
          data-testid="book-upload"
          class="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-70"
          :title="props.needLogin ? t('library.cloudNeedLogin') : (props.uploading ? t('library.cloudUploading') : t('library.cloudUpload'))"
          :disabled="props.uploading"
          @click="emit('upload')"
        >
          <!-- ★ 上传中：转圈 + 百分比，别再是一个"只变灰"的按钮。 -->
          <span
            v-if="props.uploading"
            data-testid="book-upload-spinner"
            aria-hidden="true"
            class="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span v-else aria-hidden="true">☁️</span>
          <span v-if="props.uploading && props.uploadPercent !== null">
            {{ t('library.cloudUploadPercent', { percent: props.uploadPercent }) }}
          </span>
          <span v-else>{{ props.needLogin ? t('library.cloudUploadNeedLogin') : t('library.cloudUploadShort') }}</span>
        </button>
        <button
          v-if="props.removable"
          type="button"
          class="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-red-600 transition"
          @click="emit('remove')"
        >
          {{ t('library.delete') }}
        </button>
      </div>
    </div>
    <p
      v-if="props.sessionOnly"
      data-testid="book-session-only"
      class="mt-2 text-[11px] text-[var(--color-text-secondary)]"
    >
      {{ t('library.sessionOnlyHint') }}
    </p>
  </article>
</template>
