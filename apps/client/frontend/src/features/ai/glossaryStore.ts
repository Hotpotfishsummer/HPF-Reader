import { computed, ref, shallowRef, type Ref } from 'vue'
import {
  GLOSSARY_SOURCE_PRIORITY,
  isOverridable,
  type Glossary,
  type GlossaryPutRequest,
  type GlossarySource,
  type GlossaryTerm,
} from '../../api'
import { getAiApi } from './runtime'

/**
 * 术语表 store（task-24：**服务端为准**）。
 *
 * 与 task-23 版本的差别（很重要，别改回去）：
 *
 * | | task-23 | task-24 |
 * |---|---|---|
 * | 持久化 | 只写 localStorage | PUT 到服务端，localStorage 仅作**离线缓存** |
 * | 权威 | 本地 | 服务端（含 version） |
 * | key | 自己拼 source 字符串 | 服务端归一化后返回 |
 *
 * ★ 三条不可违反的规则：
 *
 * 1. **客户端不实现归一化**。`key` 由服务端从 `display` 计算。
 *    openapi 明确写了「客户端不应自行实现归一化——那是一套有版本的规则，
 *    重复实现必然不一致」。所以本地新增术语时**不填 key**，交给服务端。
 *
 * 2. **`user_confirmed` 不会被自动流水线覆盖**（后端硬保证，有测试守着）。
 *    所以 UI 要能区分"这条我已经确认过"和"这条还可能被自动改掉"。
 *
 * 3. **`version` 变了会导致相关块重译**（它参与译文 input_hash）。
 *    改一条术语 = 可能重译 + 扣额度。`version` 必须暴露给 UI 用于提示。
 *
 * 离线降级：网络不可用时读 localStorage 缓存，但**标记为 stale**，
 * 让 UI 能如实显示"这是缓存，可能不是最新"。不假装在线。
 */

const CACHE_PREFIX = 'hpf.glossary.cache.v2.'

interface CachedGlossary {
  glossary: Glossary
  cachedAt: number
}

function cacheKey(bookId: string, targetLang: string): string {
  return `${CACHE_PREFIX}${bookId}.${targetLang}`
}

function readCache(bookId: string, targetLang: string): CachedGlossary | null {
  try {
    const raw = localStorage.getItem(cacheKey(bookId, targetLang))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as CachedGlossary
    if (!parsed || typeof parsed !== 'object' || !parsed.glossary) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(bookId: string, targetLang: string, glossary: Glossary): void {
  try {
    localStorage.setItem(
      cacheKey(bookId, targetLang),
      JSON.stringify({ glossary, cachedAt: Date.now() } satisfies CachedGlossary),
    )
  } catch {
    // 配额满 / 隐私模式：缓存失败不影响主流程（服务端才是权威）。
  }
}

/** 按来源优先级排序：user_confirmed 最前（最可信、最不会被改）。 */
export function sortTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  return [...terms].sort((a, b) => {
    const d = GLOSSARY_SOURCE_PRIORITY[a.source] - GLOSSARY_SOURCE_PRIORITY[b.source]
    return d !== 0 ? d : a.display.localeCompare(b.display)
  })
}

/** 术语表 → 翻译请求用的 glossary 映射（display → target）。 */
export function toTranslateGlossary(terms: GlossaryTerm[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const term of sortTerms(terms)) {
    // 后面的（低优先级）不覆盖前面的（高优先级）—— 用户确认值必须赢。
    if (!(term.display in out)) out[term.display] = term.target
    for (const alias of term.aliases ?? []) {
      if (!(alias in out)) out[alias] = term.target
    }
  }
  return out
}

export interface GlossaryStoreState {
  /** 当前术语（已按来源优先级排序）。 */
  terms: Ref<GlossaryTerm[]>
  /** 服务端 version。变化意味着相关块会重译。 */
  version: Ref<number>
  loading: Ref<boolean>
  saving: Ref<boolean>
  /** 错误文案（空串表示无错）。 */
  error: Ref<string>
  /**
   * 是否为离线缓存（true = 显示的是本地缓存，服务端可能更新）。
   * ★ 不假装在线：true 时 UI 要显式提示。
   */
  stale: Ref<boolean>
  /** 翻译请求用的 display→target 映射。 */
  translateGlossary: Ref<Record<string, string>>
  reload: () => Promise<void>
  /** 新增/更新一条（key 省略，由服务端归一化计算）。 */
  upsert: (input: { display: string; target: string; source?: GlossarySource; aliases?: string[] }) => Promise<void>
  /** 删除一条（按归一 key）。 */
  remove: (key: string) => Promise<void>
  /** 确认一条（source 升级为 user_confirmed）。 */
  confirm: (term: GlossaryTerm) => Promise<void>
  /** 手动合并两组（归化译名做不到，这是手动路径）。 */
  merge: (fromKeys: string[], intoKey: string) => Promise<void>
  /**
   * 拆分：把一条术语的某个别名**移出**（误合并的纠正路径）。
   *
   * merge 的反向操作。如果用户发现两个实体被错误合到一起，
   * 需要把别名拆出来变成独立术语。
   */
  split: (key: string, alias: string) => Promise<void>
  /**
   * 锁定 / 解锁。
   *
   * ★ 语义对应后端的 `corrections.Op = lock`：
   *   锁定 = 来源升级为 `user_confirmed`（自动流水线**再也不会覆盖**这组）；
   *   解锁 = 降回 `llm_extracted`（允许自动流水线重新抽取）。
   *
   * 因为服务端的硬保证就是"user_confirmed 不被覆盖"，
   * 所以"锁"在本项目的术语模型里**不需要额外字段** —— 它就是一个来源。
   */
  setLocked: (term: GlossaryTerm, locked: boolean) => Promise<void>
}

export function useGlossary(bookId: () => string, targetLang: () => string): GlossaryStoreState {
  // ★ 引擎/store 实例不放 ref/reactive —— 这里只有纯数据，用 shallowRef 足够。
  const glossary = shallowRef<Glossary | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const stale = ref(false)

  const terms = computed<GlossaryTerm[]>(() => sortTerms(glossary.value?.terms ?? []))
  const version = computed(() => glossary.value?.version ?? 0)
  const translateGlossary = computed(() => toTranslateGlossary(glossary.value?.terms ?? []))

  async function reload(): Promise<void> {
    const id = bookId()
    const lang = targetLang()
    if (id === '' || lang === '') return
    loading.value = true
    error.value = ''
    try {
      const remote = await getAiApi().getGlossary(id, lang)
      glossary.value = remote
      stale.value = false
      writeCache(id, lang, remote)
    } catch (err) {
      // ★ 离线降级：服务端不可用时用缓存，但明确标记 stale。
      const cached = readCache(id, lang)
      if (cached) {
        glossary.value = cached.glossary
        stale.value = true
        error.value = ''
      } else {
        glossary.value = null
        stale.value = false
        error.value = err instanceof Error ? err.message : String(err)
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * 提交队列：**串行化 PUT**。
   *
   * ★ 为什么必须有：E2E 里连续添加两条术语时暴露出真实竞态 ——
   * 两次 add 各发一个 PUT，若先发的响应后到，`glossary.value` 会被
   * 旧响应覆盖，界面**少一条**。真实用户快速加两条术语就会踩到。
   * 服务端是合并语义（每次返回**完整**表），所以乱序响应 = 丢数据。
   *
   * 串行化后：每次 PUT 都基于上一次返回的最新表，响应顺序即提交顺序。
   */
  let commitChain: Promise<unknown> = Promise.resolve()

  /**
   * 提交变更（合并语义：只提交改动的那几条，未提及的保持不动）。
   *
   * 成功后用服务端返回的完整表覆盖本地 —— 这样 `key` 与 `version`
   * 都是服务端算的，本地不做任何猜测。
   */
  async function commit(req: GlossaryPutRequest): Promise<void> {
    const id = bookId()
    // 排到队尾；前一个失败也要继续执行后面的（用 catch 吞掉链上的拒绝）。
    const run = commitChain.catch(() => undefined).then(async () => {
      saving.value = true
      error.value = ''
      try {
        const updated = await getAiApi().putGlossary(id, req)
        glossary.value = updated
        stale.value = false
        writeCache(id, req.targetLang, updated)
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        saving.value = false
      }
    })
    commitChain = run
    await run
  }

  async function upsert(input: {
    display: string
    target: string
    source?: GlossarySource
    aliases?: string[]
  }): Promise<void> {
    const display = input.display.trim()
    const target = input.target.trim()
    if (display === '' || target === '') return
    const term: GlossaryTerm = {
      // ★ key 留空：服务端会用归一化规则从 display 计算。
      key: '',
      display,
      target,
      source: input.source ?? 'user_confirmed',
      ...(input.aliases && input.aliases.length > 0 ? { aliases: input.aliases } : {}),
    }
    await commit({ targetLang: targetLang(), terms: [term] })
  }

  async function remove(key: string): Promise<void> {
    if (key === '') return
    await commit({ targetLang: targetLang(), removeKeys: [key] })
  }

  async function confirm(term: GlossaryTerm): Promise<void> {
    await commit({
      targetLang: targetLang(),
      terms: [{ ...term, source: 'user_confirmed' }],
    })
  }

  /**
   * 合并两组实体（把 `fromKeys` 的译名并入 `intoKey`）。
   *
   * ★ 归化译名（Scarlett / 斯嘉丽）字符串法**必然合并失败**，
   *   所以这条路径是**用户手动触发**的，不做自动猜测。
   */
  async function merge(fromKeys: string[], intoKey: string): Promise<void> {
    if (intoKey === '') return
    const all = glossary.value?.terms ?? []
    const into = all.find((t) => t.key === intoKey)
    if (!into) return
    const aliases = new Set(into.aliases ?? [])
    for (const key of fromKeys) {
      if (key === intoKey) continue
      const other = all.find((t) => t.key === key)
      if (other) {
        aliases.add(other.display)
        for (const a of other.aliases ?? []) aliases.add(a)
      }
    }
    await commit({
      targetLang: targetLang(),
      terms: [{ ...into, aliases: [...aliases], source: 'user_confirmed' }],
      removeKeys: fromKeys.filter((k) => k !== intoKey),
    })
  }

  /** 拆分：把 alias 从该术语的别名里移出。 */
  async function split(key: string, alias: string): Promise<void> {
    const all = glossary.value?.terms ?? []
    const term = all.find((t) => t.key === key)
    if (!term) return
    const aliases = (term.aliases ?? []).filter((a) => a !== alias)
    await commit({
      targetLang: targetLang(),
      terms: [{ ...term, aliases, source: 'user_confirmed' }],
    })
  }

  /** 锁定/解锁：锁定就是升级为 user_confirmed。 */
  async function setLocked(term: GlossaryTerm, locked: boolean): Promise<void> {
    await commit({
      targetLang: targetLang(),
      terms: [{ ...term, source: locked ? 'user_confirmed' : 'llm_extracted' }],
    })
  }

  return {
    terms,
    version,
    loading,
    saving,
    error,
    stale,
    translateGlossary,
    reload,
    upsert,
    remove,
    confirm,
    merge,
    split,
    setLocked,
  }
}

/** 该术语是否会被自动流水线覆盖（供 UI 提示用）。 */
export function termIsOverridable(term: GlossaryTerm): boolean {
  return isOverridable(term.source)
}