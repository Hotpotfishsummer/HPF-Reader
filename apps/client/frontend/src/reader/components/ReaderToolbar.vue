<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  chapter: string
  progress: number
  tocOpen: boolean
  sanitizeSummary: string
}>()

const emit = defineEmits<{
  back: []
  prev: []
  next: []
  'toggle-toc': []
}>()

const { t } = useI18n()
</script>

<template>
  <header
    class="absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/90 px-4 py-2 backdrop-blur"
  >
    <button type="button" class="rounded px-2 py-1 text-sm" @click="emit('back')">
      {{ t('reader.back') }}
    </button>
    <button type="button" class="rounded px-2 py-1 text-sm" @click="emit('toggle-toc')">
      {{ t('reader.toc') }}
    </button>
    <span class="min-w-0 flex-1 truncate text-center text-sm text-[var(--color-text-secondary)]">
      {{ chapter }}
    </span>
    <span
      v-if="sanitizeSummary"
      class="hidden shrink-0 text-xs text-[var(--color-text-secondary)] lg:inline"
      :title="sanitizeSummary"
    >
      L2 · {{ progress }}%
    </span>
    <button type="button" class="rounded px-2 py-1 text-sm" @click="emit('prev')">
      {{ t('reader.prev') }}
    </button>
    <button type="button" class="rounded px-2 py-1 text-sm" @click="emit('next')">
      {{ t('reader.next') }}
    </button>
  </header>
</template>
