<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, type ReaderTheme, type PageTurnAnimation } from '@/stores/settings'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const settings = useSettingsStore()

const THEMES: { id: ReaderTheme; label: string; bg: string; border: string; text: string }[] = [
  { id: 'light', label: '纸白', bg: '#fbf8f2', border: '#e5e0d8', text: '#23201c' },
  { id: 'sepia', label: '护眼', bg: '#f4ecd8', border: '#dfd4bc', text: '#3c3224' },
  { id: 'dark', label: '夜间', bg: '#14161a', border: '#2d333b', text: '#d8dce3' },
  { id: 'ink', label: '水墨', bg: '#ffffff', border: '#000000', text: '#000000' },
]

const FONTS: { id: 'serif' | 'sans' | 'kaiti' | 'system'; label: string }[] = [
  { id: 'serif', label: t('reader.fontSerif') },
  { id: 'sans', label: t('reader.fontSans') },
  { id: 'kaiti', label: t('reader.fontKaiti') },
  { id: 'system', label: t('reader.fontSystem') },
]

const LINE_HEIGHTS = [
  { value: 1.4, label: '紧凑' },
  { value: 1.65, label: '适中' },
  { value: 1.9, label: '宽松' },
]

const MARGINS = [
  { value: 24, label: '窄' },
  { value: 48, label: '适中' },
  { value: 72, label: '宽' },
]

const ANIMATION_OPTIONS = computed<Array<{ id: PageTurnAnimation; label: string; hint: string }>>(() => [
  { id: 'slide', label: t('reader.animSlide'), hint: t('reader.animSlideHint') },
  { id: 'fade', label: t('reader.animFade'), hint: t('reader.animFadeHint') },
  { id: 'curl', label: t('reader.animCurl'), hint: t('reader.animCurlHint') },
  { id: 'eink', label: t('reader.animEink'), hint: t('reader.animEinkHint') },
  { id: 'none', label: t('reader.animNone'), hint: t('reader.animNoneHint') },
])

const currentAnimHint = computed(() => {
  const current = ANIMATION_OPTIONS.value.find((opt) => opt.id === settings.pageTurnAnimation)
  return current ? current.hint : ''
})

function changeFontSize(delta: number): void {
  const next = Math.max(12, Math.min(36, settings.fontSize + delta))
  settings.fontSize = next
}
</script>

<template>
  <div
    v-if="open"
    data-testid="reader-settings-popover"
    class="absolute right-2 top-14 z-30 w-72 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-2xl space-y-4"
  >
    <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-2">
      <h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
        {{ t('reader.typography') }}
      </h3>
      <button
        type="button"
        class="rounded p-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- 配色主题 -->
    <div class="space-y-1.5">
      <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">正文主题</label>
      <div class="grid grid-cols-4 gap-2">
        <button
          v-for="thm in THEMES"
          :key="thm.id"
          type="button"
          class="flex flex-col items-center justify-center rounded-lg p-2 transition border"
          :style="{
            backgroundColor: thm.bg,
            borderColor: settings.readerTheme === thm.id ? 'var(--color-accent)' : thm.border,
            color: thm.text,
          }"
          :class="settings.readerTheme === thm.id ? 'ring-2 ring-[var(--color-accent)] ring-offset-1' : ''"
          @click="settings.setReaderTheme(thm.id)"
        >
          <span class="text-xs font-semibold">Aa</span>
          <span class="text-[10px] mt-0.5 opacity-80">{{ thm.label }}</span>
        </button>
      </div>
    </div>

    <!-- 字号调节 -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-[11px] font-medium text-[var(--color-text-secondary)]">
        <span>{{ t('reader.fontSize') }}</span>
        <span class="tabular-nums font-mono">{{ settings.fontSize }}px</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-1 text-xs font-bold hover:bg-[var(--color-surface-sunken)]"
          @click="changeFontSize(-1)"
        >
          A-
        </button>
        <input
          v-model.number="settings.fontSize"
          type="range"
          min="12"
          max="36"
          step="1"
          class="w-full flex-1 accent-[var(--color-accent)] cursor-pointer"
        />
        <button
          type="button"
          class="flex-1 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-1 text-sm font-bold hover:bg-[var(--color-surface-sunken)]"
          @click="changeFontSize(1)"
        >
          A+
        </button>
      </div>
    </div>

    <!-- 字体族 -->
    <div class="space-y-1.5">
      <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">{{ t('reader.fontFamily') }}</label>
      <div class="grid grid-cols-2 gap-1.5">
        <button
          v-for="f in FONTS"
          :key="f.id"
          type="button"
          class="rounded border px-2 py-1 text-xs text-left transition"
          :class="settings.fontFamily === f.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white font-medium'
            : 'border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          @click="settings.fontFamily = f.id"
        >
          {{ f.label }}
        </button>
      </div>
    </div>

    <!-- 行高与边距 -->
    <div class="grid grid-cols-2 gap-3 pt-1">
      <div class="space-y-1.5">
        <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">{{ t('reader.lineHeight') }}</label>
        <div class="flex rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-0.5">
          <button
            v-for="lh in LINE_HEIGHTS"
            :key="lh.value"
            type="button"
            class="flex-1 rounded py-0.5 text-[10px] transition text-center"
            :class="settings.lineHeight === lh.value
              ? 'bg-[var(--color-accent)] text-white font-medium'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
            @click="settings.lineHeight = lh.value"
          >
            {{ lh.label }}
          </button>
        </div>
      </div>

      <div class="space-y-1.5">
        <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">{{ t('reader.margin') }}</label>
        <div class="flex rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-0.5">
          <button
            v-for="mg in MARGINS"
            :key="mg.value"
            type="button"
            class="flex-1 rounded py-0.5 text-[10px] transition text-center"
            :class="settings.marginInline === mg.value
              ? 'bg-[var(--color-accent)] text-white font-medium'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
            @click="settings.marginInline = mg.value"
          >
            {{ mg.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- 首行缩进 -->
    <div class="flex items-center justify-between pt-1 border-t border-[var(--color-border-subtle)]">
      <span class="text-xs text-[var(--color-text-primary)]">{{ t('reader.indent') }}</span>
      <input
        v-model="settings.textIndent"
        type="checkbox"
        class="h-4 w-4 rounded border-gray-300 accent-[var(--color-accent)] cursor-pointer"
      />
    </div>

    <!-- 翻页动画 (None / Slide / Fade / Curl / E-ink) -->
    <div class="space-y-1.5 pt-1 border-t border-[var(--color-border-subtle)]">
      <div class="flex items-center justify-between">
        <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">{{ t('reader.pageTurnAnimation') }}</label>
        <span class="text-[10px] text-[var(--color-text-tertiary)] max-w-[15ch] truncate" :title="currentAnimHint">{{ currentAnimHint }}</span>
      </div>
      <div class="grid grid-cols-5 gap-1">
        <button
          v-for="anim in ANIMATION_OPTIONS"
          :key="anim.id"
          type="button"
          :data-testid="`anim-btn-${anim.id}`"
          class="rounded border py-1 text-[11px] text-center transition"
          :class="settings.pageTurnAnimation === anim.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white font-medium shadow-sm'
            : 'border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
          :title="anim.hint"
          @click="settings.setPageTurnAnimation(anim.id)"
        >
          {{ anim.label }}
        </button>
      </div>
    </div>

    <!-- 墨水屏刷新优化 -->
    <div class="flex items-center justify-between pt-1 border-t border-[var(--color-border-subtle)]">
      <div class="flex flex-col pr-2">
        <span class="text-xs text-[var(--color-text-primary)]">{{ t('reader.einkMode') }}</span>
        <span class="text-[9px] text-[var(--color-text-tertiary)] leading-tight">{{ t('reader.einkModeHint') }}</span>
      </div>
      <input
        v-model="settings.einkMode"
        type="checkbox"
        class="h-4 w-4 rounded border-gray-300 accent-[var(--color-accent)] cursor-pointer"
      />
    </div>
  </div>
</template>
