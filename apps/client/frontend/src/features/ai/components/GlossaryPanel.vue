<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GlossaryEntry, GlossaryOrigin } from '../../../api'
import { useGlossary } from '../glossaryStore'

/**
 * 术语表管理（task-23 第三项）。
 *
 * 显示/编辑/确认译名，并标出**来源**（用户确认 / LLM 抽取 / 确定性规则）——
 * 来源很重要：LLM 抽取的译名可能不准，用户需要一眼看出哪些还没确认。
 *
 * ⚠️ 服务端持久化接口尚未提供（见 glossaryStore.ts 顶部的说明），
 * 所以这里明确标注"暂存在本机"，不假装已同步。
 */

const props = defineProps<{
  bookId: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const glossary = useGlossary(() => props.bookId)

const newSource = ref('')
const newTarget = ref('')
const editingSource = ref<string | null>(null)
const editingTarget = ref('')

/** 按来源优先级排序：用户确认的排最前（这些是最可信的）。 */
const sorted = computed(() =>
  [...glossary.entries.value].sort((a, b) => {
    const rank: Record<GlossaryOrigin, number> = { user: 0, deterministic: 1, llm: 2 }
    return rank[a.origin] - rank[b.origin]
  }),
)

function originLabel(origin: GlossaryOrigin): string {
  switch (origin) {
    case 'user':
      return t('ai.originUser')
    case 'llm':
      return t('ai.originLlm')
    case 'deterministic':
      return t('ai.originDeterministic')
    default:
      return origin
  }
}

function originClass(origin: GlossaryOrigin): string {
  switch (origin) {
    case 'user':
      return 'bg-green-100 text-green-800'
    case 'llm':
      return 'bg-blue-100 text-blue-800'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

function add(): void {
  const source = newSource.value.trim()
  const target = newTarget.value.trim()
  if (source === '' || target === '') return
  glossary.upsert({ source, target, origin: 'user' })
  newSource.value = ''
  newTarget.value = ''
}

function beginEdit(entry: GlossaryEntry): void {
  editingSource.value = entry.source
  editingTarget.value = entry.target
}

function commitEdit(): void {
  const source = editingSource.value
  if (source === null) return
  const target = editingTarget.value.trim()
  if (target === '') return
  // 编辑即确认：origin 升级为 user。
  glossary.confirm(source, target)
  editingSource.value = null
  editingTarget.value = ''
}
</script>

<template>
  <div
    data-testid="glossary-panel"
    class="absolute right-2 top-14 z-30 w-[min(92vw,26rem)] rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
  >
    <div class="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <h2 class="text-sm font-semibold">{{ t('ai.glossaryTitle') }}</h2>
      <span class="text-[10px] text-[var(--color-text-tertiary)]">{{ glossary.entries.value.length }}</span>
      <button
        type="button"
        data-testid="glossary-close"
        class="ml-auto rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <div class="max-h-[50vh] overflow-auto px-3 py-2">
      <p v-if="sorted.length === 0" data-testid="glossary-empty" class="py-2 text-xs text-[var(--color-text-tertiary)]">
        {{ t('ai.glossaryEmpty') }}
      </p>

      <ul v-else class="space-y-1.5">
        <li
          v-for="entry in sorted"
          :key="entry.source"
          data-testid="glossary-row"
          class="rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium">{{ entry.source }}</p>
              <template v-if="editingSource === entry.source">
                <input
                  v-model="editingTarget"
                  data-testid="glossary-edit-input"
                  class="mt-1 w-full rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-xs"
                  @keyup.enter="commitEdit"
                >
              </template>
              <p v-else class="truncate text-xs text-[var(--color-text-secondary)]">→ {{ entry.target }}</p>
            </div>

            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              :class="originClass(entry.origin)"
            >
              {{ originLabel(entry.origin) }}
            </span>
          </div>

          <div class="mt-1 flex gap-1.5">
            <template v-if="editingSource === entry.source">
              <button
                type="button"
                data-testid="glossary-edit-save"
                class="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white"
                @click="commitEdit"
              >
                {{ t('ai.glossaryConfirm') }}
              </button>
              <button
                type="button"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px]"
                @click="editingSource = null"
              >
                ✕
              </button>
            </template>
            <template v-else>
              <button
                v-if="entry.origin !== 'user'"
                type="button"
                data-testid="glossary-confirm"
                class="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white"
                @click="glossary.confirm(entry.source)"
              >
                {{ t('ai.glossaryConfirm') }}
              </button>
              <button
                type="button"
                data-testid="glossary-edit"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px]"
                @click="beginEdit(entry)"
              >
                ✎
              </button>
              <button
                type="button"
                data-testid="glossary-delete"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-red-600"
                @click="glossary.remove(entry.source)"
              >
                {{ t('ai.glossaryDelete') }}
              </button>
            </template>
          </div>
        </li>
      </ul>
    </div>

    <!-- 新增 -->
    <div class="space-y-1.5 border-t border-[var(--color-border-subtle)] px-3 py-2">
      <div class="flex gap-1.5">
        <input
          v-model="newSource"
          data-testid="glossary-new-source"
          :placeholder="t('ai.glossarySource')"
          class="min-w-0 flex-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-1 text-xs"
          @keyup.enter="add"
        >
        <input
          v-model="newTarget"
          data-testid="glossary-new-target"
          :placeholder="t('ai.glossaryTarget')"
          class="min-w-0 flex-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-1 text-xs"
          @keyup.enter="add"
        >
        <button
          type="button"
          data-testid="glossary-add"
          class="shrink-0 rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white"
          @click="add"
        >
          {{ t('ai.glossaryAdd') }}
        </button>
      </div>
      <p data-testid="glossary-local-only" class="text-[10px] text-[var(--color-text-tertiary)]">
        {{ t('ai.glossaryLocalOnly') }}
      </p>
    </div>
  </div>
</template>
