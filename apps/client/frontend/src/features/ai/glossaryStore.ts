import { computed, ref } from 'vue'
import type { GlossaryEntry, GlossaryOrigin } from '../../api'

/**
 * 术语表（task-23 第三项）。
 *
 * ⚠️ **契约缺口（必须如实说明，不能假装）**：
 * task-23 的说明里提到 `GET/PUT /v1/books/{id}/glossary`，并注明"可能还在做"。
 * 实测服务端路由表（apps/server/internal/httpapi/server.go）**没有**这个端点，
 * `api/openapi.yaml` 里也没有。因此本模块**只做本地持久化**：
 *   - 术语表存在 localStorage（按 bookId 分键）；
 *   - 翻译时通过 `POST /v1/ai/translate` 的 `glossary` 字段传给模型
 *     （**这条链路是服务端已实现的**，见 httpapi/ai.go:25 / ai/ai.go:120）；
 *   - UI 上明确标注"暂存在本机"，不假装已经同步到服务端。
 *
 * 这样做的价值：术语一致性**真的生效**（模型会拿到 glossary），
 * 而且接口一旦补上，只需替换本文件的持久化实现，UI 与调用方不用动。
 */

const STORAGE_PREFIX = 'hpf.glossary.v1.'

export type { GlossaryEntry, GlossaryOrigin }

function storageKey(bookId: string): string {
  return STORAGE_PREFIX + bookId
}

/** 来源标记的展示优先级：用户确认 > LLM 抽取 > 确定性规则。 */
export function originPriority(origin: GlossaryOrigin): number {
  switch (origin) {
    case 'user':
      return 0
    case 'deterministic':
      return 1
    case 'llm':
      return 2
    default:
      return 3
  }
}

function isEntry(value: unknown): value is GlossaryEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['source'] === 'string'
    && typeof v['target'] === 'string'
    && (v['origin'] === 'user' || v['origin'] === 'llm' || v['origin'] === 'deterministic')
  )
}

/** 从 localStorage 读术语表；坏数据（非 JSON / 结构不对）直接当空表，不抛。 */
export function loadGlossary(bookId: string): GlossaryEntry[] {
  if (bookId === '') return []
  try {
    const raw = localStorage.getItem(storageKey(bookId))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

export function saveGlossary(bookId: string, entries: GlossaryEntry[]): void {
  if (bookId === '') return
  try {
    localStorage.setItem(storageKey(bookId), JSON.stringify(entries))
  } catch {
    // 存储满 / 隐私模式：静默失败。术语表丢了不影响阅读与翻译主链路。
  }
}

/** 转成翻译接口要的 `glossary` 字段（source → target）。 */
export function toTranslateGlossary(entries: GlossaryEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  // 同一 source 有多条时，按来源优先级取最可信的一条（用户确认优先）。
  const best = new Map<string, GlossaryEntry>()
  for (const entry of entries) {
    const existing = best.get(entry.source)
    if (!existing || originPriority(entry.origin) < originPriority(existing.origin)) {
      best.set(entry.source, entry)
    }
  }
  for (const [source, entry] of best) out[source] = entry.target
  return out
}

/**
 * 当前书籍的术语表（组件级使用）。
 *
 * 返回的 entries 是 ref，直接绑定到 UI；所有修改都会**立即**落 localStorage，
 * 避免"编辑完忘了保存"。
 */
export function useGlossary(bookId: () => string) {
  const entries = ref<GlossaryEntry[]>(loadGlossary(bookId()))
  const translateMap = computed(() => toTranslateGlossary(entries.value))

  function reload(): void {
    entries.value = loadGlossary(bookId())
  }

  function persist(): void {
    saveGlossary(bookId(), entries.value)
  }

  function upsert(entry: GlossaryEntry): void {
    const index = entries.value.findIndex((e) => e.source === entry.source)
    if (index >= 0) {
      // 保留原有 origin 优先级更高的那条：用户手动确认永远覆盖 LLM 抽取。
      const existing = entries.value[index]
      if (existing && originPriority(existing.origin) < originPriority(entry.origin)) return
      entries.value[index] = entry
    } else {
      entries.value = [...entries.value, entry]
    }
    persist()
  }

  function remove(source: string): void {
    entries.value = entries.value.filter((e) => e.source !== source)
    persist()
  }

  /** 确认一条 LLM 抽取的译名：origin 升级为 user。 */
  function confirm(source: string, target?: string): void {
    const index = entries.value.findIndex((e) => e.source === source)
    if (index < 0) {
      if (target === undefined) return
      upsert({ source, target, origin: 'user' })
      return
    }
    const existing = entries.value[index]
    if (!existing) return
    entries.value[index] = {
      source: existing.source,
      target: target ?? existing.target,
      origin: 'user',
    }
    persist()
  }

  return { entries, translateMap, reload, upsert, remove, confirm, persist }
}

export type GlossaryStore = ReturnType<typeof useGlossary>
