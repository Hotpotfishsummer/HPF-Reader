/**
 * 同步用到的本地持久化抽象。
 *
 * 为什么不用 Pinia：见 docs/research/50-vue3-reader-stack.md §5 与 ADR-002 §4 ——
 * 引擎真相区必须能在无 Vue、无 DOM 的环境（Node 联调脚本、单测）里跑；
 * localStorage 只是浏览器上的一个实现。
 */
export interface SyncStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export function createMemoryStorage(seed: Record<string, string> = {}): SyncStorage {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value)
    },
    remove: (key) => {
      map.delete(key)
    },
  }
}

/** 浏览器实现：localStorage 不可用（隐私模式/Node）时退化为内存，绝不抛异常。 */
export function createBrowserStorage(prefix = 'hpf.sync.'): SyncStorage {
  const memory = createMemoryStorage()
  const ls = (() => {
    try {
      const candidate = globalThis.localStorage
      if (!candidate) return null
      const probe = prefix + '__probe'
      candidate.setItem(probe, '1')
      candidate.removeItem(probe)
      return candidate
    } catch {
      return null
    }
  })()
  if (ls === null) return memory
  return {
    get: (key) => {
      try {
        return ls.getItem(prefix + key)
      } catch {
        return memory.get(key)
      }
    },
    set: (key, value) => {
      try {
        ls.setItem(prefix + key, value)
      } catch {
        memory.set(key, value)
      }
    },
    remove: (key) => {
      try {
        ls.removeItem(prefix + key)
      } catch {
        memory.remove(key)
      }
    },
  }
}

export function readJson<T>(storage: SyncStorage, key: string, fallback: T): T {
  const raw = storage.get(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(storage: SyncStorage, key: string, value: unknown): void {
  storage.set(key, JSON.stringify(value))
}
