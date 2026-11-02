<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiUsage } from '../../../api'
import { getAiApi } from '../runtime'
import { formatCount, formatResetTime, formatCountdown, isExhausted, usedPercent } from '../quota'

/**
 * 配额显示（task-23 第四项）。
 *
 * ★ 显示"剩余多少 + 什么时候重置"，而不是只显示已用量 ——
 * 用户真正关心的是"我还能不能用、什么时候恢复"。
 *
 * 数据不可用时（未登录 / 无服务器）**明确说不可用**，不显示假数字。
 */

const props = defineProps<{
  /** 刷新间隔（ms）。默认 60s：配额不是高频变化的数据。 */
  refreshMs?: number
}>()

const { t } = useI18n()
const usage = ref<AiUsage | null>(null)
const unavailable = ref(false)
const loading = ref(false)

let timer: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    usage.value = await getAiApi().usage()
    unavailable.value = false
  } catch {
    // 未登录 / 无服务器 / 404：都当作"不可用"，不显示假数据。
    usage.value = null
    unavailable.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
  const interval = props.refreshMs ?? 60_000
  timer = setInterval(() => void refresh(), interval)
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

const exhausted = computed(() => (usage.value ? isExhausted(usage.value) : false))
const resetLabel = computed(() => {
  if (!usage.value) return ''
  return formatCountdown(usage.value.resetAt)
})
const resetExact = computed(() => (usage.value ? formatResetTime(usage.value.resetAt) : ''))

const callsPercent = computed(() => (usage.value ? usedPercent(usage.value.calls) : 0))
const tokensPercent = computed(() => (usage.value ? usedPercent(usage.value.tokens) : 0))
</script>

<template>
  <div data-testid="quota-badge" class="text-[11px] leading-tight">
    <!-- 不可用：明确说不可用 -->
    <p v-if="unavailable" data-testid="quota-unavailable" class="text-[var(--color-text-tertiary)]">
      {{ t('ai.quotaUnavailable') }}
    </p>

    <div v-else-if="usage" class="space-y-1.5">
      <div class="flex items-center gap-2">
        <span class="font-medium text-[var(--color-text-secondary)]">{{ t('ai.quotaTitleShort') }}</span>
        <span
          v-if="exhausted"
          data-testid="quota-exhausted"
          class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
        >
          {{ t('ai.quotaExhausted') }}
        </span>
      </div>

      <!-- 两个维度都显示：只按次数计费会严重失真（契约里明确写了原因） -->
      <div data-testid="quota-calls" class="space-y-0.5">
        <div class="flex items-center justify-between">
          <span class="text-[var(--color-text-tertiary)]">{{ t('ai.quotaCallsLabel') }}</span>
          <span class="tabular-nums text-[var(--color-text-secondary)]">
            {{ formatCount(usage.calls.used) }} / {{ formatCount(usage.calls.quota) }}
            <span class="text-[var(--color-text-tertiary)]">（剩 {{ formatCount(usage.calls.remaining) }}）</span>
          </span>
        </div>
        <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
          <div
            class="h-full rounded-full"
            :class="callsPercent >= 100 ? 'bg-amber-500' : 'bg-[var(--color-accent)]'"
            :style="{ width: callsPercent + '%' }"
          />
        </div>
      </div>

      <div data-testid="quota-tokens" class="space-y-0.5">
        <div class="flex items-center justify-between">
          <span class="text-[var(--color-text-tertiary)]">{{ t('ai.quotaTokensLabel') }}</span>
          <span class="tabular-nums text-[var(--color-text-secondary)]">
            {{ formatCount(usage.tokens.used) }} / {{ formatCount(usage.tokens.quota) }}
            <span class="text-[var(--color-text-tertiary)]">（剩 {{ formatCount(usage.tokens.remaining) }}）</span>
          </span>
        </div>
        <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
          <div
            class="h-full rounded-full"
            :class="tokensPercent >= 100 ? 'bg-amber-500' : 'bg-[var(--color-accent)]'"
            :style="{ width: tokensPercent + '%' }"
          />
        </div>
      </div>

      <p data-testid="quota-reset" class="text-[10px] text-[var(--color-text-tertiary)]">
        {{ t('ai.quotaReset', { when: resetLabel, reset: resetExact }) }}
      </p>
    </div>

    <p v-else class="text-[var(--color-text-tertiary)]">…</p>
  </div>
</template>
