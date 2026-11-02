import type { Platform } from '@/platform'

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
