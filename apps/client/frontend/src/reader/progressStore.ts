import type { Platform } from '@/platform'

/**
 * 只钉住定位器里我们真正要用的两个字段。
 *
 * 为什么不是 `Locator`：契约里 `Locator` = `{ href: string; type: string }` 且
 * `href` 是可选的（引擎在 payload 里可能只放 CFI）。用结构化最小类型既能接住
 * 契约类型，也能接住测试里的假引擎，同时**强制我们在使用前校验 href**。
 */
export interface ProgressLocatorLike {
  href: string
  type: string
  title?: string | null
  locations?: {
    fragments?: string[]
    progression?: number
    position?: number
    totalProgression?: number
  }
  text?: {
    before?: string
    highlight?: string
    after?: string
  }
}

/**
 * ★ 本地优先的阅读进度缓存（task-12）。
 *
 * 设计动机：阅读进度必须在**没有任何服务器**的情况下也能落盘并续读。
 * 进度有两个后端，写的时候两边都写，读的时候本地优先：
 *
 *   1. `localStorage`（key 见 `PROGRESS_STORAGE_KEY`）—— 同步、永远可用、不需要任何后端。
 *      它是"重开能续读"的最后一道保险：即使 platform 写入失败（无 Wails / 无服务端），
 *      同一次会话内以及同一浏览器 profile 下的下次打开仍然能续读。
 *   2. `platform.library.saveProgress` —— 桌面端落到 Go 侧的
 *      `<dataDir>/progress.json`（跨浏览器 profile / 清理缓存后仍然有效，
 *      也是将来同步引擎的输入）。
 *
 * 为什么不放 Pinia：进度是**同步实体**（见 docs/research/50-vue3-reader-stack.md §3.1），
 * 不是本地 UI 偏好。它是一个普通的模块级 map，不需要被任何组件响应式订阅。
 *
 * ★ task-4 追加：第三个后端 —— **云端权威进度**（HLC 同步引擎的本地投影）。
 *   见下方 `resolveRemoteProgress`。它只读不写：写方向走 outbox（enqueueProgress），
 *   由 ReaderView 节流后调用，**本文件绝不发网络请求**。
 */

export const PROGRESS_STORAGE_KEY = 'hpf.reader.progress.v1'

interface ProgressEntry {
  locator: string
  /** 0-100 的整百分比，仅用于书库卡片显示"读到哪了"。 */
  fraction: number
  updatedAt: number
}

type ProgressTable = Record<string, ProgressEntry>

/**
 * localStorage 在隐私模式 / 沙箱 iframe / 存储被禁用时会**抛异常**（不是返回 null），
 * 所以每一次访问都必须包起来。失败时退化为纯内存，绝不让阅读器崩掉。
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    // 试写一次，探测是否真的可写（Safari 隐私模式会在这里抛）
    const probe = '__hpf_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return localStorage
  } catch {
    return null
  }
}

function readTable(): ProgressTable {
  const store = storage()
  if (!store) return {}
  try {
    const raw = store.getItem(PROGRESS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ProgressTable
  } catch {
    // 数据损坏时不要让阅读器挂掉：当作空表，后续写入会覆盖它。
    return {}
  }
}

function writeTable(table: ProgressTable): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(table))
  } catch {
    // 配额满 / 被禁用：忽略，platform 那一侧仍然是有效后端。
  }
}

/** 只读本地缓存（同步）。没有记录时返回空串。 */
export function readLocalProgress(bookId: string): string {
  if (!bookId) return ''
  const entry = readTable()[bookId]
  return entry?.locator ?? ''
}

/** 本地缓存里的 0-100 整百分比；没有记录 / 读不到数字时返回 0，不编造。 */
export function readLocalFraction(bookId: string): number {
  if (!bookId) return 0
  const fraction = readTable()[bookId]?.fraction
  return typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : 0
}

/**
 * 本地缓存里所有书的阅读百分比（0-100），书库卡片用。
 * 只返回"真的读进去过"的记录：没有 fraction 的旧记录显示为 0，不编造数字。
 */
export function progressSnapshot(): Record<string, number> {
  const table = readTable()
  const out: Record<string, number> = {}
  for (const [bookId, entry] of Object.entries(table)) {
    const fraction = typeof entry?.fraction === 'number' ? entry.fraction : 0
    if (fraction > 0) out[bookId] = Math.round(fraction)
  }
  return out
}

/**
 * 记一次进度。
 *
 * 本地是**同步**写入（用户翻页后立刻生效，返回后马上读得到），
 * platform 那一侧是 fire-and-forget —— 后端不可用时不能阻塞阅读，也不能弹错。
 *
 * ★ 注意：这里**不发任何同步请求**。云端推送由 ReaderView 通过
 *   `getSyncEngine().enqueueProgress(...)` 节流触发（见 reader/progressSync.ts）。
 */
export function rememberProgress(
  bookId: string,
  locator: string,
  fraction: number,
  platform?: Platform,
): void {
  if (!bookId || !locator) return

  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  const table = readTable()
  const previous = table[bookId]
  if (previous?.locator === locator) return
  table[bookId] = { locator, fraction: percent, updatedAt: Date.now() }
  writeTable(table)

  if (!platform) return
  void platform.library.saveProgress(bookId, locator).catch((error: unknown) => {
    console.warn('[progress] 本地已保存，但写入 platform 失败（离线是正常情况）', error)
  })
}

/**
 * 打开书之前解析"上次读到哪"。
 *
 * 顺序：本地缓存 → platform（Go 的 progress.json / 服务端）。
 * 从 platform 拿到值时会**回填**本地缓存，下次就不用再等异步了。
 *
 * 云端权威进度不在这里解析：它需要 contentHash 才能映射到 server bookId，
 * 由 `resolveReaderProgress` 统一编排（见文件末尾）。
 */
export async function resolveProgress(bookId: string, platform?: Platform): Promise<string> {
  const local = readLocalProgress(bookId)
  if (!platform) return local
  try {
    const remote = (await platform.library.getProgress(bookId)) ?? ''
    if (remote) {
      if (remote !== local) {
        const table = readTable()
        const previous = table[bookId]
        table[bookId] = {
          locator: remote,
          fraction: previous?.fraction ?? 0,
          updatedAt: Date.now(),
        }
        writeTable(table)
      }
      return remote
    }
  } catch (error) {
    // 离线 / 没有这本书：本地缓存就是答案。
    console.warn('[progress] 读取 platform 进度失败，使用本地缓存', error)
  }
  return local
}

// ---------------------------------------------------------------------------
// task-4：云端权威进度（HLC 同步引擎的本地投影）
// ---------------------------------------------------------------------------

/** 只依赖"读"的那部分引擎能力，便于单测注入假引擎。 */
export interface ProgressEngineLike {
  local: {
    books: Record<string, { id: string; contentHash: string | null }>
    progress: Record<string, { locator: ProgressLocatorLike | null; totalProgression: number }>
  }
}

export interface RemoteProgress {
  /** 服务端权威 bookId（本地书库 id 是文件哈希前 16 位，两者不同）。 */
  serverBookId: string
  /** 服务端存的是 Readium Locator 对象；这里保留完整对象，由调用方决定怎么用。 */
  locator: ProgressLocatorLike
  /** 0-100 整百分比（服务端是 0..1 的 totalProgression）。 */
  progression: number
}

export interface ResolvedReaderProgress {
  /** 打开书时交给 foliate 的 locator（可能是空串 = 从头打开）。 */
  locator: string
  /** 该 locator 的来源：云端权威 / 本地缓存 / platform。 */
  source: 'remote' | 'local' | 'platform'
  /** 把远端 locator 回填进本地缓存时用的 0-100 百分比。 */
  fraction: number
  /** 命中的服务端权威记录（同步时用它拿 serverBookId，避免重复映射）。 */
  remote: RemoteProgress | null
}

/**
 * contentHash 归一化：'sha256:ABC' / 'abc' / '' 都能互相比较。
 * 本地书库 id（contentId）是 hex 前 16 位，服务端存的是 'sha256:<64 hex>'，
 * 所以比较前必须剥掉算法前缀并统一小写。
 */
export function normalizeContentHash(hash: string | null | undefined): string {
  if (typeof hash !== 'string') return ''
  const trimmed = hash.trim().toLowerCase()
  return trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed
}

/** 0..1 的 totalProgression → 0-100 整百分比（夹在 [0,100]，反正是用于显示与回填）。 */
export function progressionToPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value * 100)))
}

function isLocator(value: unknown): value is ProgressLocatorLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { href?: unknown; type?: unknown }
  return typeof candidate.href === 'string' && typeof candidate.type === 'string'
}

/**
 * 把本地书映射到服务端 bookId，并取出服务端权威进度。
 *
 * 映射规则：`engine.local.books` 里有 `contentHash`（书籍文件 sha256）。
 * 用本地书的 contentHash 去匹配；**匹配不到就返回 null**——
 * 绝不退回"用本地 id 当 serverBookId"，那会在服务端制造一条不存在的书
 * （服务端 bookId 是 UUID，本地 id 是 16 位 hex，伪造必然被拒或写错书）。
 *
 * locator 类型在这里被校验：服务端投影里的 locator 可能是 null / 半成品（pull 早期
 * payload 缺 href），这种记录不能拿来定位，按"没有云端进度"处理。
 */
export function resolveRemoteProgress(
  contentHash: string | null | undefined,
  engine?: ProgressEngineLike,
): RemoteProgress | null {
  if (!engine || !contentHash) return null
  const wanted = normalizeContentHash(contentHash)
  if (!wanted) return null

  let serverBookId: string | null = null
  for (const book of Object.values(engine.local.books ?? {})) {
    if (book && normalizeContentHash(book.contentHash) === wanted) {
      serverBookId = book.id
      break
    }
  }
  if (!serverBookId) return null

  const progress = engine.local.progress?.[serverBookId]
  if (!progress || !isLocator(progress.locator)) return null

  return {
    serverBookId,
    locator: progress.locator,
    progression: progressionToPercent(progress.totalProgression),
  }
}

/**
 * Locator → 交给 foliate 的定位串。
 *
 * 优先 `locations.fragments[0]`（EPUB CFI，引擎原生定位）；没有 CFI 时退回 href
 * （至少能定位到章节，不会白屏）。
 */
export function locatorToFoliateString(locator: ProgressLocatorLike): string {
  const fragment = locator.locations?.fragments?.[0]
  if (typeof fragment === 'string' && fragment !== '') return fragment
  return locator.href
}

/**
 * 打开书时的进度优先级（task-4 验收项）：
 *
 *   云端权威（若比本地更远，或本地根本没有记录） > 本地缓存 > platform。
 *
 * 为什么"更远"才用云端：进度是 LWW 实体，本地刚翻的一页可能还没推上去；
 * 如果无脑用云端覆盖，用户在离线/在途状态下的阅读位置会被**回退**。
 * 反过来，本地没有记录（新设备首同步）或云端明显更远（另一台设备读得更靠后）时，
 * 云端才是正确答案。
 *
 * 纯函数 + 注入式依赖：不碰网络、不碰全局单例，单测可直接喂假引擎。
 */
export async function resolveReaderProgress(input: {
  bookId: string
  contentHash: string | null | undefined
  engine?: ProgressEngineLike
  platform?: Platform
  /** 覆盖本地缓存读取（测试注入）。 */
  readLocal?: (bookId: string) => string
  /** 覆盖本地百分比读取（测试注入）。 */
  readFraction?: (bookId: string) => number
}): Promise<ResolvedReaderProgress> {
  const readLocal = input.readLocal ?? readLocalProgress
  const readFraction = input.readFraction ?? readLocalFraction

  const localLocator = readLocal(input.bookId)
  const localFraction = readFraction(input.bookId)
  const remote = resolveRemoteProgress(input.contentHash, input.engine)

  if (remote && (localLocator === '' || remote.progression > localFraction)) {
    return {
      locator: locatorToFoliateString(remote.locator),
      source: 'remote',
      fraction: remote.progression,
      remote,
    }
  }

  if (localLocator !== '') {
    return { locator: localLocator, source: 'local', fraction: localFraction, remote }
  }

  const platformLocator = await readPlatformProgress(input.bookId, input.platform)
  if (platformLocator !== '') {
    return { locator: platformLocator, source: 'platform', fraction: localFraction, remote }
  }

  return { locator: '', source: 'local', fraction: 0, remote }
}

async function readPlatformProgress(bookId: string, platform?: Platform): Promise<string> {
  if (!bookId || !platform) return ''
  try {
    return (await platform.library.getProgress(bookId)) ?? ''
  } catch (error) {
    console.warn('[progress] 读取 platform 进度失败，改为从头打开', error)
    return ''
  }
}

/**
 * 把云端权威进度回填到本地缓存（它已经在屏幕上生效了，本地缓存不该继续指向旧位置）。
 *
 * 只改 locator 不动 updatedAt 语义：下一次 rememberProgress 会正常覆盖它。
 */
export function cacheResolvedProgress(bookId: string, locator: string, fraction?: number): void {
  if (!bookId || !locator) return
  const table = readTable()
  const previous = table[bookId]
  const percent =
    typeof fraction === 'number' && Number.isFinite(fraction)
      ? fraction
      : (previous?.fraction ?? 0)
  table[bookId] = {
    locator,
    fraction: Math.max(0, Math.min(100, Math.round(percent))),
    updatedAt: Date.now(),
  }
  writeTable(table)
}

/** 测试与"清空本地数据"用。 */
export function clearLocalProgress(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(PROGRESS_STORAGE_KEY)
  } catch {
    // 忽略
  }
}
