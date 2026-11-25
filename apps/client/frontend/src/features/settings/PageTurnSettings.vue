<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type MousePageTurnMode } from '@/stores/settings'
import {
  displayKey,
  findConflict,
  normalizeKey,
  type PageTurnDirection,
} from '@/reader/pageTurnInput'

/**
 * 设置页的「翻页」区块：键盘翻页 + 鼠标翻页。
 *
 * ★ 两个设计要点（都是实际会踩的坑）：
 *   1. **键位录制用全局 keydown 捕获**，而不是让用户手打字符串。
 *      手打 `ArrowRight` 这种名字既反直觉又容易拼错，还无法表达组合键。
 *   2. **跨方向冲突在录入时就拦下**，并且提示具体是哪个方向占用了它。
 *      允许"一个操作绑多个键"，但同一个键绑到两个方向会让一次按键翻两页 ——
 *      那是配置事故，不是功能。
 */

const { t } = useI18n()
const settings = useSettingsStore()

const MOUSE_MODES = computed<Array<{ id: MousePageTurnMode; label: string; hint: string }>>(() => [
  { id: 'off', label: t('settings.mouseOff'), hint: t('settings.mouseOffHint') },
  { id: 'single', label: t('settings.mouseSingle'), hint: t('settings.mouseSingleHint') },
  { id: 'double', label: t('settings.mouseDouble'), hint: t('settings.mouseDoubleHint') },
])

const currentMouseHint = computed(
  () => MOUSE_MODES.value.find((m) => m.id === settings.mousePageTurn)?.hint ?? '',
)

/** 正在录制键位的方向；null 表示没在录制。 */
const recording = ref<PageTurnDirection | null>(null)
/** 录入失败提示（冲突）。 */
const conflict = ref<{ direction: PageTurnDirection; token: string } | null>(null)

const nextTokens = computed(() => settings.effectiveNextKeys)
const prevTokens = computed(() => settings.effectivePrevKeys)

/**
 * 开始录制。
 *
 * ★ 用 window 捕获阶段监听：设置页里可能有输入框，冒泡阶段可能被 stopPropagation 吞掉；
 *   捕获阶段能保证"用户按下什么就录到什么"。
 */
function startRecording(direction: PageTurnDirection): void {
  conflict.value = null
  recording.value = direction
  window.addEventListener('keydown', onRecordKey, { capture: true })
}

function stopRecording(): void {
  recording.value = null
  window.removeEventListener('keydown', onRecordKey, { capture: true })
}

function onRecordKey(event: KeyboardEvent): void {
  const direction = recording.value
  if (direction === null) return
  // 录制期间吞掉所有按键：否则方向键会同时滚动设置页。
  event.preventDefault()
  event.stopPropagation()

  // Esc 取消录制（不能把 Esc 自己绑成翻页键 —— 它是"关浮层/退出"的语义）。
  if (event.key === 'Escape') {
    stopRecording()
    return
  }

  const token = normalizeKey(event)
  if (token === null) return // 纯修饰键：等真正的按键

  const occupied = findConflict(
    token,
    { next: nextTokens.value, prev: prevTokens.value },
    direction,
  )
  if (occupied !== null) {
    conflict.value = { direction: occupied, token }
    stopRecording()
    return
  }

  if (direction === 'next') settings.addNextKey(token)
  else settings.addPrevKey(token)
  conflict.value = null
  stopRecording()
}

function removeToken(direction: PageTurnDirection, token: string): void {
  if (direction === 'next') settings.removeNextKey(token)
  else settings.removePrevKey(token)
  // 移除后冲突提示可能已经不成立，清掉避免误导。
  conflict.value = null
}

function resetKeys(): void {
  settings.resetPageTurnKeys()
  conflict.value = null
}

onBeforeUnmount(stopRecording)
</script>

<template>
  <section data-testid="settings-pageturn">
    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
      {{ t('settings.pageTurn') }}
    </h2>
    <div class="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
      <p class="text-xs text-[var(--color-text-secondary)]">{{ t('settings.pageTurnDesc') }}</p>

      <!-- ---------------- 键盘翻页 ---------------- -->
      <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm">{{ t('settings.keyboardPageTurn') }}</span>
            <span class="text-[11px] leading-tight text-[var(--color-text-secondary)]">
              {{ t('settings.keyboardPageTurnHint') }}
            </span>
          </span>
          <input
            v-model="settings.keyboardPageTurn"
            data-testid="keyboard-pageturn-toggle"
            type="checkbox"
            class="h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--color-accent)] cursor-pointer"
          />
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <div
            v-for="side in ([
              { id: 'next' as const, label: t('settings.nextPageKeys'), tokens: nextTokens, testid: 'next-keys' },
              { id: 'prev' as const, label: t('settings.prevPageKeys'), tokens: prevTokens, testid: 'prev-keys' },
            ])"
            :key="side.id"
            class="space-y-1.5"
          >
            <div class="text-[11px] font-medium text-[var(--color-text-secondary)]">{{ side.label }}</div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="token in side.tokens"
                :key="token"
                :data-testid="`${side.testid}-chip`"
                class="inline-flex items-center gap-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[11px]"
              >
                {{ displayKey(token) }}
                <button
                  type="button"
                  :data-testid="`${side.testid}-remove-${token}`"
                  :aria-label="`${t('settings.resetKeys')} ${displayKey(token)}`"
                  class="text-[var(--color-text-secondary)] hover:text-rose-500"
                  @click="removeToken(side.id, token)"
                >
                  ✕
                </button>
              </span>
              <button
                v-if="recording === side.id"
                type="button"
                :data-testid="`${side.testid}-recording`"
                class="rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-2 py-0.5 text-[11px] text-[var(--color-accent)] animate-pulse"
                @click="stopRecording"
              >
                {{ t('settings.pressKeyHint') }}
              </button>
              <button
                v-else
                type="button"
                :data-testid="`${side.testid}-add`"
                class="rounded border border-dashed border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                @click="startRecording(side.id)"
              >
                + {{ t('settings.addKey') }}
              </button>
            </div>
          </div>
        </div>

        <p v-if="conflict" data-testid="key-conflict" class="text-[11px] text-rose-600">
          {{ t('settings.keyConflict', {
            direction: conflict.direction === 'next' ? t('settings.nextDirection') : t('settings.prevDirection'),
          }) }}
        </p>

        <button
          type="button"
          data-testid="reset-page-keys"
          class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition"
          @click="resetKeys"
        >
          {{ t('settings.resetKeys') }}
        </button>
      </div>

      <!-- ---------------- 鼠标翻页 ---------------- -->
      <div class="space-y-1.5 border-t border-[var(--color-border-subtle)] pt-3">
        <div class="flex items-center justify-between">
          <span class="text-sm">{{ t('settings.mousePageTurn') }}</span>
          <span class="max-w-[26ch] text-right text-[10px] leading-tight text-[var(--color-text-secondary)]">
            {{ currentMouseHint }}
          </span>
        </div>
        <div class="flex rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-0.5">
          <button
            v-for="mode in MOUSE_MODES"
            :key="mode.id"
            type="button"
            :data-testid="`mouse-pageturn-${mode.id}`"
            class="flex-1 rounded py-1 text-[11px] transition"
            :class="settings.mousePageTurn === mode.id
              ? 'bg-[var(--color-accent)] text-white font-medium'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
            @click="settings.setMousePageTurn(mode.id)"
          >
            {{ mode.label }}
          </button>
        </div>
        <p class="text-[10px] leading-tight text-[var(--color-text-secondary)]">
          {{ t('settings.mousePageTurnHint') }}
        </p>
      </div>
    </div>
  </section>
</template>
