<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { type GlossaryTerm, type GlossarySource } from '../../../api'
import { useGlossary } from '../glossaryStore'

/**
 * 术语表管理（task-24）。
 *
 * 与 task-23 的差别：现在**真的存到服务端**（GET/PUT /v1/books/{id}/glossary），
 * 本地只是离线缓存。所以这里不再有「暂存在本机」的标注。
 *
 * 三条必须让用户看见的事：
 *
 * 1. **改术语会导致相关块重译**（version 参与 input_hash）。
 *    不提示的话，用户改个译名会莫名发现整书重翻并扣钱。
 * 2. **user_confirmed 不会被自动流水线覆盖**。要标出来哪些已锁定。
 * 3. **归化译名（Scarlett/斯嘉丽）字符串法合并失败**。
 *    不假装能自动，引导用户手动 merge。
 */

const props = defineProps<{
  bookId: string
  targetLang: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const glossary = useGlossary(() => props.bookId, () => props.targetLang)

const newDisplay = ref('')
const newTarget = ref('')
const editingKey = ref<string | null>(null)
const editingTarget = ref('')
/** 合并模式：选中多条 → 指定主条目 → merge。 */
const mergeMode = ref(false)
const selectedKeys = ref<string[]>([])
const mergeInto = ref('')

onMounted(() => void glossary.reload())

const sorted = computed(() => glossary.terms.value)

function sourceLabel(source: GlossarySource): string {
  switch (source) {
    case 'user_confirmed':
      return t('ai.sourceUserConfirmed')
    case 'llm_extracted':
      return t('ai.sourceLlmExtracted')
    default:
      return t('ai.sourceDeterministic')
  }
}

function sourceClass(source: GlossarySource): string {
  switch (source) {
    case 'user_confirmed':
      return 'bg-green-100 text-green-800'
    case 'llm_extracted':
      return 'bg-blue-100 text-blue-800'
    default:
      return 'bg-gray-100 text-gray-700'
  }
}

async function add(): Promise<void> {
  const display = newDisplay.value.trim()
  const target = newTarget.value.trim()
  if (display === '' || target === '') return
  await glossary.upsert({ display, target, source: 'user_confirmed' })
  newDisplay.value = ''
  newTarget.value = ''
}

function beginEdit(term: GlossaryTerm): void {
  editingKey.value = term.key
  editingTarget.value = term.target
}

async function commitEdit(term: GlossaryTerm): Promise<void> {
  const target = editingTarget.value.trim()
  if (target === '') return
  // 编辑即确认：source 升级为 user_confirmed（用户意图永久保留）。
  await glossary.upsert({ display: term.display, target, source: 'user_confirmed', aliases: term.aliases })
  editingKey.value = null
  editingTarget.value = ''
}

function toggleSelect(key: string): void {
  const i = selectedKeys.value.indexOf(key)
  if (i >= 0) selectedKeys.value.splice(i, 1)
  else selectedKeys.value.push(key)
}

async function doMerge(): Promise<void> {
  if (mergeInto.value === '' || selectedKeys.value.length < 1) return
  await glossary.merge(selectedKeys.value, mergeInto.value)
  mergeMode.value = false
  selectedKeys.value = []
  mergeInto.value = ''
}
</script>

<template>
  <div
    data-testid="glossary-panel"
    class="absolute right-2 top-14 z-30 w-[min(92vw,28rem)] rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-2xl"
  >
    <div class="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
      <h2 class="text-sm font-semibold">{{ t('ai.glossaryTitle') }}</h2>
      <span class="text-[10px] text-[var(--color-text-tertiary)]">
        {{ sorted.length }}
        <span data-testid="glossary-version" class="ml-1">v{{ glossary.version.value }}</span>
      </span>
      <span v-if="glossary.loading.value" class="text-[10px] text-[var(--color-text-tertiary)]">
        {{ t('ai.loading') }}
      </span>
      <span v-if="glossary.saving.value" class="text-[10px] text-[var(--color-text-tertiary)]">
        {{ t('ai.saving') }}
      </span>
      <button
        type="button"
        data-testid="glossary-close"
        class="ml-auto rounded px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
        @click="emit('close')"
      >
        ✕
      </button>
    </div>

    <!-- ★ 离线缓存提示：不假装在线 -->
    <p
      v-if="glossary.stale.value"
      data-testid="glossary-stale"
      class="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-900"
    >
      {{ t('ai.glossaryStale') }}
    </p>

    <p
      v-if="glossary.error.value"
      data-testid="glossary-error"
      class="border-b border-red-200 bg-red-50 px-3 py-1.5 text-[10px] text-red-900"
    >
      {{ glossary.error.value }}
    </p>

    <!-- ★ version 变更会触发重译：这是"会花钱"的后果，必须显式说明 -->
    <p
      data-testid="glossary-version-warning"
      class="border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[10px] text-[var(--color-text-tertiary)]"
    >
      {{ t('ai.glossaryVersionWarning') }}
    </p>

    <div class="max-h-[50vh] overflow-auto px-3 py-2">
      <p v-if="sorted.length === 0" data-testid="glossary-empty" class="py-2 text-xs text-[var(--color-text-tertiary)]">
        {{ t('ai.glossaryEmpty') }}
      </p>

      <ul v-else class="space-y-1.5">
        <li
          v-for="term in sorted"
          :key="term.key"
          data-testid="glossary-row"
          class="rounded-md border border-[var(--color-border-subtle)] px-2 py-1.5"
        >
          <div class="flex items-start gap-2">
            <input
              v-if="mergeMode"
              type="checkbox"
              :checked="selectedKeys.includes(term.key)"
              data-testid="glossary-merge-checkbox"
              class="mt-0.5"
              @change="toggleSelect(term.key)"
            >
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium">
                {{ term.display }}
                <span class="ml-1 font-mono text-[10px] text-[var(--color-text-tertiary)]">{{ term.key }}</span>
              </p>
              <template v-if="editingKey === term.key">
                <input
                  v-model="editingTarget"
                  data-testid="glossary-edit-input"
                  class="mt-1 w-full rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-xs"
                  @keyup.enter="commitEdit(term)"
                >
              </template>
              <p v-else class="truncate text-xs text-[var(--color-text-secondary)]">→ {{ term.target }}</p>
              <!-- 别名：每个都能单独拆出去（split = merge 的反向纠正） -->
              <p v-if="term.aliases && term.aliases.length > 0" class="mt-0.5 flex flex-wrap items-center gap-1">
                <span class="text-[10px] text-[var(--color-text-tertiary)]">{{ t('ai.glossaryAliases') }}:</span>
                <span
                  v-for="alias in term.aliases"
                  :key="alias"
                  class="inline-flex items-center gap-1 rounded bg-[var(--color-surface-sunken)] px-1 text-[10px]"
                >
                  {{ alias }}
                  <button
                    type="button"
                    data-testid="glossary-split"
                    :title="t('ai.glossarySplitHint')"
                    class="text-[var(--color-text-tertiary)] hover:text-red-600"
                    @click="glossary.split(term.key, alias)"
                  >×</button>
                </span>
              </p>
            </div>

            <span
              data-testid="glossary-source"
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              :class="sourceClass(term.source)"
            >
              {{ sourceLabel(term.source) }}
            </span>
          </div>

          <div v-if="!mergeMode" class="mt-1 flex gap-1.5">
            <template v-if="editingKey === term.key">
              <button
                type="button"
                data-testid="glossary-edit-save"
                class="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white"
                @click="commitEdit(term)"
              >
                {{ t('ai.glossaryConfirm') }}
              </button>
              <button
                type="button"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px]"
                @click="editingKey = null"
              >
                ✕
              </button>
            </template>
            <template v-else>
              <!-- 锁定 / 解锁。锁定 = user_confirmed = 自动流水线不再改动这组 -->
              <button
                v-if="term.source !== 'user_confirmed'"
                type="button"
                data-testid="glossary-lock"
                :title="t('ai.glossaryLockHint')"
                class="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] text-white"
                @click="glossary.setLocked(term, true)"
              >
                {{ t('ai.glossaryLock') }}
              </button>
              <button
                v-else
                type="button"
                data-testid="glossary-unlock"
                :title="t('ai.glossaryUnlockHint')"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px]"
                @click="glossary.setLocked(term, false)"
              >
                {{ t('ai.glossaryUnlock') }}
              </button>
              <button
                type="button"
                data-testid="glossary-edit"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px]"
                @click="beginEdit(term)"
              >
                ✎
              </button>
              <button
                type="button"
                data-testid="glossary-delete"
                class="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-red-600"
                @click="glossary.remove(term.key)"
              >
                {{ t('ai.glossaryDelete') }}
              </button>
            </template>
          </div>
        </li>
      </ul>
    </div>

    <!-- 合并模式：归化译名做不到，这是手动路径 -->
    <div v-if="mergeMode" class="space-y-1.5 border-t border-[var(--color-border-subtle)] px-3 py-2">
      <p class="text-[10px] text-[var(--color-text-tertiary)]">{{ t('ai.glossaryMergeHint') }}</p>
      <div class="flex gap-1.5">
        <input
          v-model="mergeInto"
          data-testid="glossary-merge-into"
          :placeholder="t('ai.glossaryMergeInto')"
          class="min-w-0 flex-1 rounded border border-[var(--color-border-subtle)] px-1.5 py-1 text-xs"
        >
        <button
          type="button"
          data-testid="glossary-merge-do"
          class="shrink-0 rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-white"
          @click="doMerge"
        >
          {{ t('ai.glossaryMerge') }}
        </button>
        <button
          type="button"
          data-testid="glossary-merge-cancel"
          class="shrink-0 rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs"
          @click="mergeMode = false; selectedKeys = []"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 新增 -->
    <div v-else class="space-y-1.5 border-t border-[var(--color-border-subtle)] px-3 py-2">
      <div class="flex gap-1.5">
        <input
          v-model="newDisplay"
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
      <button
        type="button"
        data-testid="glossary-merge-mode"
        class="text-[10px] text-[var(--color-accent)] underline"
        @click="mergeMode = true"
      >
        {{ t('ai.glossaryMergeEntry') }}
      </button>
    </div>
  </div>
</template>