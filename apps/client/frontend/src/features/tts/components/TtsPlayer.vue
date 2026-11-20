<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TtsStatus } from '../useTts'

const props = defineProps<{
  status: TtsStatus
  rate: number
  text: string
}>()

const emit = defineEmits<{
  play: []
  pause: []
  resume: []
  stop: []
  'update:rate': [rate: number]
  close: []
}>()

const { t } = useI18n()
const SPEEDS = [0.8, 1.0, 1.25, 1.5]
</script>

<template>
  <div
    data-testid="tts-player"
    class="fixed bottom-12 left-1/2 z-40 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/95 px-4 py-2.5 shadow-2xl backdrop-blur-md text-xs"
  >
    <!-- 播放 / 暂停切换 -->
    <button
      v-if="status === 'playing'"
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow hover:opacity-90 transition"
      :title="t('reader.ttsPause')"
      @click="emit('pause')"
    >
      ⏸
    </button>
    <button
      v-else-if="status === 'paused'"
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow hover:opacity-90 transition"
      :title="t('reader.ttsPlay')"
      @click="emit('resume')"
    >
      ▶
    </button>
    <button
      v-else
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow hover:opacity-90 transition"
      :title="t('reader.ttsPlay')"
      @click="emit('play')"
    >
      ▶
    </button>

    <!-- 停止 -->
    <button
      type="button"
      class="rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] transition"
      :title="t('reader.ttsStop')"
      @click="emit('stop')"
    >
      ⏹
    </button>

    <!-- 文本摘录预览 -->
    <div class="max-w-[180px] sm:max-w-xs truncate text-[var(--color-text-secondary)]">
      {{ text || t('reader.tts') }}
    </div>

    <!-- 语速调节 -->
    <div class="flex items-center gap-1 border-l border-[var(--color-border-subtle)] pl-2">
      <button
        v-for="s in SPEEDS"
        :key="s"
        type="button"
        class="rounded px-1.5 py-0.5 text-[10px] transition"
        :class="props.rate === s ? 'bg-[var(--color-accent)] text-white font-bold' : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]'"
        @click="emit('update:rate', s)"
      >
        {{ s }}x
      </button>
    </div>

    <!-- 关闭条 -->
    <button
      type="button"
      class="border-l border-[var(--color-border-subtle)] pl-2 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
      @click="emit('close')"
    >
      ✕
    </button>
  </div>
</template>
