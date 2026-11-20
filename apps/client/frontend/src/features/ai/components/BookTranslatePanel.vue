<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBookTranslateJob } from '../composables/useBookTranslateJob'
import QuotaBadge from './QuotaBadge.vue'

/**
 * 整书翻译面板（task-23 第二项）。
 *
 * ★ 本组件存在的**核心理由**是把 `paused` 与 `failed` 说清楚：
 *
 *   - paused：额度不足，已完成的部分全部保留，下个周期自动继续。
 *     文案要让人**安心**（不是坏了，也不会重复花钱）。
 *   - failed：真失败，需要重新发起。
 *
 * 两者在视觉与文案上都必须明显不同 —— 混用会吓到用户，
 * 还会让他以为要重花一次钱（已完成块级译文其实还在库里）。
 */

const props = defineProps<{
  bookId: string
  /** 当前书籍标题（面板标题用）。 */
  bookTitle: string
}>()

const emit = defineEmits<{
  close: []
  'open-bilingual': [jobId?: string]
}>()

const { t } = useI18n()
const job = useBookTranslateJob()

const targetLang = ref('zh-CN')
const LANG_OPTIONS = computed(() => [
  { value: 'zh-CN', label: t('ai.langZh') },
  { value: 'en', label: t('ai.langEn') },
  { value: 'ja', label: t('ai.langJa') },
])

const canStart = computed(() => {
  const s = job.phase.value
  return s === 'idle' || s === 'succeeded' || s === 'failed' || s === 'canceled'
})

const statusLabel = computed(() => {
  switch (job.phase.value) {
    case 'submitting':
      return t('ai.submit')
    case 'queued':
      return t('ai.statusQueued')
    case 'running':
      return t('ai.statusRunning')
    case 'paused':
      return t('ai.statusPaused')
    case 'succeeded':
      return t('ai.statusSucceeded')
    case 'failed':
      return t('ai.statusFailed')
    case 'canceled':
      return t('ai.statusCanceled')
    default:
      return ''
  }
})

/** ★ 进度条颜色按状态区分：paused 用琥珀色（"等一下会继续"），failed 用红色。 */
const barClass = computed(() => {
  switch (job.phase.value) {
    case 'paused':
      return 'bg-amber-500'
    case 'failed':
      return 'bg-red-500'
    case 'succeeded':
      return 'bg-green-500'
    default:
      return 'bg-[var(--color-accent)]'
  }
})

function start(): void {
  void job.start(props.bookId, targetLang.value)
}
</script>

<template>
  <div
    data-testid="book-translate-panel"
    class="absolute right-2 top-14 z-30 w-[min(92vw,26rem)] rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
  >
    <div class="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <h2 class="text-sm font-semibold">{{ t('ai.bookTitle') }}</h2>
      <span class="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{{ props.bookTitle }}</span>
      <button
        type="button"
        data-testid="book-translate-close"
        class="rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <div class="space-y-3 px-3 py-3">
      <!-- ★ 配额：让用户在开始整书翻译前就知道还剩多少（整书翻译很贵） -->
      <QuotaBadge :refresh-ms="120000" />

      <!-- 语言选择 -->
      <label class="flex items-center gap-2 text-xs">
        <span class="shrink-0 text-[var(--color-text-secondary)]">{{ t('ai.targetLang') }}</span>
        <select
          v-model="targetLang"
          data-testid="book-translate-lang"
          class="min-w-0 flex-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs"
          :disabled="!canStart"
        >
          <option v-for="opt in LANG_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </label>

      <button
        v-if="canStart"
        type="button"
        data-testid="book-translate-start"
        class="w-full rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        @click="start"
      >
        {{ job.phase.value === 'idle' ? t('ai.startBook') : t('ai.startBook') }}
      </button>

      <button
        v-if="job.phase.value === 'succeeded' || (job.result.value?.doneChunks ?? 0) > 0"
        type="button"
        data-testid="open-bilingual-btn"
        class="w-full rounded-md border border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white transition"
        @click="emit('open-bilingual', job.job.value?.id)"
      >
        {{ t('reader.readTranslation') }} (双语对照)
      </button>

      <!-- ★ 状态 + 真实进度（来自服务端 progress，不是假动画） -->
      <div v-if="job.phase.value !== 'idle'" class="space-y-1.5">
        <div class="flex items-center justify-between text-xs">
          <span
            data-testid="book-translate-status"
            :data-phase="job.phase.value"
            class="font-medium"
            :class="{
              'text-amber-700': job.phase.value === 'paused',
              'text-red-700': job.phase.value === 'failed',
              'text-green-700': job.phase.value === 'succeeded',
              'text-[var(--color-text-primary)]': job.phase.value === 'running' || job.phase.value === 'queued' || job.phase.value === 'submitting',
            }"
          >
            {{ statusLabel }}
          </span>
          <span data-testid="book-translate-percent" class="tabular-nums text-[var(--color-text-secondary)]">
            {{ job.progressPercent.value }}%
          </span>
        </div>

        <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
          <div
            data-testid="book-translate-bar"
            class="h-full rounded-full transition-[width] duration-500"
            :class="barClass"
            :style="{ width: job.progressPercent.value + '%' }"
          />
        </div>

        <!-- ★ paused 专属提示：明确"会自动继续、不重复计费" -->
        <p
          v-if="job.isPaused.value"
          data-testid="book-translate-paused"
          class="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900"
        >
          {{ job.quotaMessage.value || t('ai.pausedHint') }}
          <br >
          <span class="opacity-80">{{ t('ai.pausedHint') }}</span>
        </p>

        <!-- failed 才是真的失败 -->
        <p
          v-else-if="job.isFailed.value"
          data-testid="book-translate-failed"
          class="rounded-md bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-700"
        >
          {{ job.errorText.value || t('ai.failedHint') }}
        </p>

        <!-- 块级进度明细 -->
        <p v-if="job.result.value" data-testid="book-translate-chunks" class="text-[11px] text-[var(--color-text-secondary)]">
          {{ t('ai.progressChunks', { done: job.result.value.doneChunks, total: job.result.value.totalChunks }) }}
          <span v-if="(job.result.value.reusedChunks ?? 0) > 0">
            · {{ t('ai.progressReused', { n: job.result.value.reusedChunks ?? 0 }) }}
          </span>
          <span v-if="(job.result.value.translatedChars ?? 0) > 0">
            · {{ t('ai.progressChars', { n: job.result.value.translatedChars }) }}
          </span>
        </p>

        <!-- 一致性扫描：把"祈祷模型听话"变成可验证断言 -->
        <div
          v-if="job.result.value?.consistency"
          data-testid="book-translate-consistency"
          class="rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5 text-[11px]"
        >
          <span class="font-medium">{{ t('ai.consistencyTitle') }}</span>
          <p
            class="mt-0.5"
            :class="job.result.value.consistency.violatingChunks > 0 ? 'text-amber-800' : 'text-green-700'"
          >
            {{
              job.result.value.consistency.violatingChunks > 0
                ? t('ai.consistencyBad', {
                    chunks: job.result.value.consistency.violatingChunks,
                    terms: job.result.value.consistency.checkedTerms,
                  })
                : t('ai.consistencyOk')
            }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>