<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BookCard from './components/BookCard.vue'
import { useLibraryStore } from './stores/libraryStore'

const { t } = useI18n()
const library = useLibraryStore()

onMounted(() => {
  void library.refresh()
})

async function onImport(): Promise<void> {
  await library.importBook()
}
</script>

<template>
  <section class="mx-auto max-w-5xl px-6 py-8">
    <div class="mb-6 flex items-baseline justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{{ t('library.title') }}</h1>
        <p v-if="!library.isEmpty" class="mt-1 text-sm text-[var(--color-text-secondary)]">
          {{ t('library.count', { n: library.count }) }}
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
        :disabled="library.loading"
        @click="onImport"
      >
        {{ library.loading ? t('library.importing') : t('library.import') }}
      </button>
    </div>

    <p
      v-if="library.error"
      class="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      {{ library.error }}
    </p>

    <!-- 空态 -->
    <div
      v-if="library.isEmpty"
      class="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-6 py-16 text-center"
    >
      <p class="text-base font-medium">{{ t('library.empty') }}</p>
      <p class="mt-2 max-w-sm text-sm text-[var(--color-text-secondary)]">
        {{ t('library.emptyHint') }}
      </p>
      <RouterLink
        to="/reader/sample"
        class="mt-6 rounded-lg border border-[var(--color-border-subtle)] px-4 py-2 text-sm"
      >
        {{ t('library.openSample') }}
      </RouterLink>
    </div>

    <!-- 书库网格 -->
    <div v-else class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      <BookCard
        v-for="book in library.books"
        :key="book.id"
        :book="book"
        @remove="library.removeBook(book.id)"
      />
    </div>
  </section>
</template>
