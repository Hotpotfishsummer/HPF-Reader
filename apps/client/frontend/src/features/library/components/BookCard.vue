<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { BookRecord } from '@/platform'

defineProps<{ book: BookRecord }>()
const emit = defineEmits<{ remove: [] }>()

const { t } = useI18n()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <article
    class="group relative flex flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 transition-shadow hover:shadow-md"
  >
    <div class="mb-3 flex aspect-[3/4] items-center justify-center rounded-lg bg-[var(--color-surface-sunken)]">
      <span class="text-2xl font-semibold opacity-40">{{ book.title.slice(0, 1) }}</span>
    </div>
    <h2 class="line-clamp-2 text-sm font-medium" :title="book.title">{{ book.title }}</h2>
    <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
      {{ book.author || '—' }} · {{ book.format.toUpperCase() }} · {{ formatSize(book.sizeBytes) }}
    </p>
    <div class="mt-3 flex items-center justify-between">
      <RouterLink
        :to="`/reader/${book.id}`"
        class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-contrast)]"
      >
        {{ t('library.read') }}
      </RouterLink>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-red-600"
        @click="emit('remove')"
      >
        {{ t('library.delete') }}
      </button>
    </div>
  </article>
</template>
