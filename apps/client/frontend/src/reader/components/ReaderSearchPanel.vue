<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FoliateEngine, SearchResultGroup, SearchResultItem } from '../useFoliateEngine'

const props = defineProps<{
  open: boolean
  engine: FoliateEngine
  compact?: boolean
}>()

const emit = defineEmits<{
  close: []
  jump: [cfi: string]
}>()

const { t } = useI18n()

const query = ref('')
const matchCase = ref(false)
const searching = ref(false)
const searchProgress = ref(0)
const results = ref<SearchResultGroup[]>([])
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

let searchId = 0

interface FlatResult {
  groupLabel: string
  item: SearchResultItem
}

const flatResults = computed<FlatResult[]>(() => {
  const list: FlatResult[] = []
  for (const group of results.value) {
    for (const item of group.subitems) {
      list.push({ groupLabel: group.label, item })
    }
  }
  return list
})

const totalCount = computed(() => flatResults.value.length)

async function startSearch(): Promise<void> {
  const text = query.value.trim()
  if (!text) {
    clearSearch()
    return
  }

  const currentId = ++searchId
  searching.value = true
  searchProgress.value = 0
  results.value = []
  activeIndex.value = 0

  try {
    const iter = props.engine.search(text, { matchCase: matchCase.value })
    for await (const yieldVal of iter) {
      if (currentId !== searchId) return // 已被新搜索打断

      if (yieldVal === 'done') {
        break
      } else if ('progress' in yieldVal) {
        searchProgress.value = Math.round(yieldVal.progress * 100)
      } else if ('subitems' in yieldVal && yieldVal.subitems.length > 0) {
        results.value.push(yieldVal)
      }
    }
  } catch (error) {
    console.warn('[search] failed', error)
  } finally {
    if (currentId === searchId) {
      searching.value = false
      searchProgress.value = 100
      if (flatResults.value.length > 0) {
        emit('jump', flatResults.value[0]!.item.cfi)
      }
    }
  }
}

function clearSearch(): void {
  searchId += 1
  query.value = ''
  results.value = []
  searching.value = false
  searchProgress.value = 0
  activeIndex.value = 0
  props.engine.clearSearch()
}

function jumpToIndex(idx: number): void {
  if (idx < 0 || idx >= flatResults.value.length) return
  activeIndex.value = idx
  emit('jump', flatResults.value[idx]!.item.cfi)
}

function prevMatch(): void {
  if (flatResults.value.length === 0) return
  const next = (activeIndex.value - 1 + flatResults.value.length) % flatResults.value.length
  jumpToIndex(next)
}

function nextMatch(): void {
  if (flatResults.value.length === 0) return
  const next = (activeIndex.value + 1) % flatResults.value.length
  jumpToIndex(next)
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      nextTick(() => {
        inputRef.value?.focus()
        inputRef.value?.select()
      })
    } else {
      clearSearch()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearSearch()
})
</script>

<template>
  <div
    data-testid="search-panel"
    class="flex h-full w-full flex-col bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]"
  >
    <!-- 搜索顶部控制栏 -->
    <div class="border-b border-[var(--color-border-subtle)] p-3 space-y-2">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-semibold text-[var(--color-text-secondary)]">
          {{ t('reader.search') }}
        </h3>
        <button
          type="button"
          data-testid="close-search"
          class="rounded p-1 text-xs text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- 搜索输入框 -->
      <form class="relative flex items-center gap-1.5" @submit.prevent="startSearch">
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          data-testid="search-input"
          class="min-w-0 flex-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]"
          :placeholder="t('reader.searchPlaceholder')"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-14 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          title="清空"
          @click="clearSearch"
        >
          ✕
        </button>
        <button
          type="submit"
          data-testid="search-submit"
          class="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:opacity-90 transition disabled:opacity-50"
          :disabled="!query.trim() || searching"
        >
          {{ searching ? t('reader.searching') : t('reader.search') }}
        </button>
      </form>

      <!-- 选项与快速切页控件 -->
      <div class="flex items-center justify-between text-[11px] text-[var(--color-text-secondary)]">
        <label class="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            v-model="matchCase"
            type="checkbox"
            class="rounded border-[var(--color-border-subtle)]"
            @change="query && startSearch()"
          />
          <span>{{ t('reader.caseSensitive') }}</span>
        </label>

        <div v-if="totalCount > 0" class="flex items-center gap-1">
          <span class="tabular-nums text-[10px] text-[var(--color-text-tertiary)]">
            {{ activeIndex + 1 }} / {{ totalCount }}
          </span>
          <button
            type="button"
            data-testid="prev-search-match"
            class="rounded p-1 hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
            :title="t('reader.searchPrev')"
            @click="prevMatch"
          >
            ↑
          </button>
          <button
            type="button"
            data-testid="next-search-match"
            class="rounded p-1 hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)]"
            :title="t('reader.searchNext')"
            @click="nextMatch"
          >
            ↓
          </button>
        </div>
      </div>

      <!-- 搜索进度条 -->
      <div v-if="searching" class="space-y-1">
        <div class="h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
          <div
            class="h-full bg-[var(--color-accent)] transition-all duration-150"
            :style="{ width: `${searchProgress}%` }"
          />
        </div>
        <p class="text-[10px] text-[var(--color-text-tertiary)]">
          {{ t('reader.searchProgress', { percent: searchProgress }) }}
        </p>
      </div>
    </div>

    <!-- 搜索结果列表 -->
    <div class="flex-1 overflow-y-auto p-2 space-y-3">
      <div
        v-if="!searching && totalCount === 0 && query"
        class="py-8 text-center text-xs text-[var(--color-text-tertiary)]"
      >
        {{ t('reader.searchNoResults') }}
      </div>

      <div
        v-if="!query && totalCount === 0"
        class="py-8 text-center text-xs text-[var(--color-text-tertiary)]"
      >
        {{ t('reader.searchPlaceholder') }}
      </div>

      <div v-for="group in results" :key="group.label" class="space-y-1">
        <div class="flex items-center justify-between px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
          <span class="truncate">{{ group.label || t('reader.toc') }}</span>
          <span class="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.2 text-[10px] tabular-nums">
            {{ group.subitems.length }}
          </span>
        </div>

        <ul class="space-y-1">
          <li
            v-for="sub in group.subitems"
            :key="sub.cfi"
            class="group cursor-pointer rounded-lg border p-2 text-xs transition leading-relaxed"
            :class="
              flatResults[activeIndex]?.item.cfi === sub.cfi
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-sunken)] shadow-sm'
                : 'border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-accent)]/50'
            "
            @click="jumpToIndex(flatResults.findIndex((r) => r.item.cfi === sub.cfi))"
          >
            <p class="text-[11px] text-[var(--color-text-secondary)]">
              <span>{{ sub.excerpt.pre }}</span>
              <mark class="rounded bg-amber-300 dark:bg-amber-500/50 px-0.5 font-bold text-neutral-900 dark:text-neutral-100">
                {{ sub.excerpt.match }}
              </mark>
              <span>{{ sub.excerpt.post }}</span>
            </p>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
