<script setup lang="ts">
import { computed } from 'vue'
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

/**
 * 上传按钮的无障碍名 / 悬停提示。
 *
 * ★ 图标按钮必须有无障碍名：视觉上没有文字，读屏用户和自动化测试都靠它。
 *   用户要求"不用文字描述"指的是**视觉**上不显示文字，不是把它变成无标签按钮。
 */
const uploadLabel = computed<string>(() => {
  if (props.uploading) {
    // ★ 进度不占视觉空间（用户要求图标化），但放进 title 里不丢信息：
    //   想确认"到底传了多少"时，悬停就能看到。
    return props.uploadPercent === null
      ? t('library.cloudUploading')
      : `${t('library.cloudUploading')} ${t('library.cloudUploadPercent', { percent: props.uploadPercent })}`
  }
  if (props.needLogin) return t('library.cloudNeedLogin')
  return t('library.cloudUpload')
})

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

    <!--
      ★ 底部操作区：一行、等高、不换行。

      之前的问题（用户截图）：`justify-between` + 一堆 `flex-wrap` 让「阅读」在左、
      其余在右，窗口一窄就整体折行；再加上「已上传到云端」是一段长中文、
      「上传」按钮里还塞了文字，结果一行里既有横排又有竖排，非常乱。

      现在：
        - 左边只有「阅读」（主操作，唯一带文字的按钮）；
        - 右边是**纯图标**的次级操作，统一 8×8 的方形点击区，永远不折行；
        - 上传状态用**图标本身**表达（未传=云上传图标，已传=对勾），不再写"已上传到云端"。
    -->
    <div class="mt-3 flex items-center justify-between gap-2">
      <RouterLink
        :to="`/reader/${props.book.id}`"
        class="hpf-press hpf-focus inline-flex h-8 shrink-0 items-center rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-contrast)]"
      >
        {{ t('library.read') }}
      </RouterLink>
      <div class="flex shrink-0 items-center gap-1">
        <!--
          ★ 上传按钮：图标即状态，不再有文字。
            未上传 → 云上传图标；已上传 → 对勾（且不再显示上传按钮）。
            用户原话："未上传的时候显示一个上传图标，上传完成后就显示一个完成图标就可以了，
            不用文字描述"。
        -->
        <button
          v-if="props.canUpload && !props.inCloud"
          type="button"
          data-testid="book-upload"
          class="hpf-press hpf-focus inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-70"
          :aria-label="uploadLabel"
          :title="uploadLabel"
          :disabled="props.uploading"
          @click="emit('upload')"
        >
          <!-- 上传中：转圈取代图标（唯一需要"动"的状态） -->
          <span
            v-if="props.uploading"
            data-testid="book-upload-spinner"
            aria-hidden="true"
            class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <!-- 未上传：云 + 上箭头 -->
          <svg
            v-else
            data-testid="book-upload-icon"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-4 w-4"
          >
            <path d="M17 17h1.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 8.2 8.6 3.9 3.9 0 0 0 7 16.3" />
            <path d="M12 20v-6" />
            <path d="m9.5 16.5 2.5-2.5 2.5 2.5" />
          </svg>
        </button>
        <!-- 已上传：对勾（不可点，纯状态展示） -->
        <span
          v-else-if="props.canUpload && props.inCloud"
          data-testid="book-in-cloud"
          class="inline-flex h-8 w-8 items-center justify-center text-emerald-600 dark:text-emerald-400"
          :aria-label="t('library.cloudUploaded')"
          :title="t('library.cloudUploaded')"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-4 w-4"
          >
            <path d="m4 12.5 5 5L20 6.5" />
          </svg>
        </span>
        <!-- 删除：图标按钮，同样不折行 -->
        <button
          v-if="props.removable"
          type="button"
          data-testid="book-remove"
          class="hpf-press hpf-focus inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition hover:text-red-600"
          :aria-label="t('library.delete')"
          :title="t('library.delete')"
          @click="emit('remove')"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-4 w-4"
          >
            <path d="M4 7h16" />
            <path d="M9 7V5h6v2" />
            <path d="M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
            <path d="M10 11v6M14 11v6" />
          </svg>
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
