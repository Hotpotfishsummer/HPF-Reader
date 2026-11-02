<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, type AppLocale } from '@/i18n'
import { usePlatform, type AppInfo } from '@/platform'
import { useSettingsStore, type ReaderTheme, type UiTheme } from '@/stores/settings'
import { useSyncStatus } from '@/features/sync/composables/useSyncStatus'

const { t } = useI18n()
const platform = usePlatform()
const settings = useSettingsStore()
const sync = useSyncStatus()

const info = ref<AppInfo | null>(null)
onMounted(async () => {
  try {
    info.value = await platform.system.info()
  } catch {
    info.value = null
  }
})

const uiThemes: { value: UiTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
const readerThemes: { value: ReaderTheme; label: string }[] = [
  { value: 'light', label: 'Paper' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
  { value: 'ink', label: 'E-ink' },
]

const syncLabel = computed(() => t(`sync.${sync.state.value.phase}`))
</script>

<template>
  <section class="mx-auto max-w-3xl px-6 py-8">
    <h1 class="mb-6 text-xl font-semibold">{{ t('settings.title') }}</h1>

    <div class="space-y-8">
      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.appearance') }}
        </h2>
        <div class="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm">{{ t('settings.theme') }}</span>
            <button
              v-for="item in uiThemes"
              :key="item.value"
              type="button"
              class="rounded-md border px-3 py-1 text-sm"
              :class="settings.theme === item.value ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
              @click="settings.setTheme(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <span class="text-sm">{{ t('settings.readerTheme') }}</span>
            <button
              v-for="item in readerThemes"
              :key="item.value"
              type="button"
              class="rounded-md border px-3 py-1 text-sm"
              :class="settings.readerTheme === item.value ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
              @click="settings.setReaderTheme(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.typography') }}
        </h2>
        <div class="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.fontSize') }}</span>
            <input
              v-model.number="settings.fontSize"
              type="range"
              min="14"
              max="28"
              step="1"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.fontSize }}px</span>
          </label>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.lineHeight') }}</span>
            <input
              v-model.number="settings.lineHeight"
              type="range"
              min="1.3"
              max="2.2"
              step="0.05"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.lineHeight.toFixed(2) }}</span>
          </label>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.margin') }}</span>
            <input
              v-model.number="settings.marginInline"
              type="range"
              min="16"
              max="96"
              step="4"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.marginInline }}px</span>
          </label>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.language') }}
        </h2>
        <div class="flex gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <button
            v-for="locale in SUPPORTED_LOCALES"
            :key="locale"
            type="button"
            class="rounded-md border px-3 py-1 text-sm"
            :class="settings.locale === locale ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
            @click="settings.setLocale(locale as AppLocale)"
          >
            {{ locale }}
          </button>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.sync') }}
        </h2>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.syncPhase') }}</dt>
          <dd>{{ syncLabel }}</dd>
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.syncPending') }}</dt>
          <dd class="tabular-nums">{{ sync.state.value.pendingCount }}</dd>
        </dl>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.about') }}
        </h2>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.platform') }}</dt>
          <dd>{{ info?.platform ?? '—' }}（{{ platform.kind }}）</dd>
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.version') }}</dt>
          <dd>{{ info?.version ?? '—' }}</dd>
        </dl>
      </div>
    </div>
  </section>
</template>
