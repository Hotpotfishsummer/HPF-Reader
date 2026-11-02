import type { SyncOp } from '../../api/contract'
import type { OutboxEntry } from './types'
import { readJson, writeJson, type SyncStorage } from './storage'

export const OUTBOX_STORAGE_KEY = 'outbox.v1'

/**
 * 出站队列（outbox）。
 *
 * S1 架构下客户端的全部职责：**只负责把本地操作排好队、推上去、按服务端结果出队**，
 * 不做任何冲突裁决（那是服务端 internal/sync/engine.go 的事）。
 *
 * 关键性质：
 *   - 进程重启不丢：每次变更都同步写 storage；
 *   - 幂等靠 opId：服务端 7 天窗口去重，因此「推送成功但响应丢失」时重发是安全的；
 *   - 只有拿到服务端确认（applied / rejected / duplicate）才出队。
 */
export class Outbox {
  #entries: OutboxEntry[]
  readonly #storage: SyncStorage

  constructor(storage: SyncStorage, entries: OutboxEntry[] = []) {
    this.#storage = storage
    this.#entries = entries
  }

  static load(storage: SyncStorage): Outbox {
    const entries = readJson<OutboxEntry[]>(storage, OUTBOX_STORAGE_KEY, [])
    return new Outbox(storage, Array.isArray(entries) ? entries : [])
  }

  get size(): number {
    return this.#entries.length
  }

  list(): OutboxEntry[] {
    return this.#entries.slice()
  }

  /** 取前 n 条（不删除；只有 ack() 才出队）。 */
  peek(max: number): OutboxEntry[] {
    return this.#entries.slice(0, Math.max(0, max))
  }

  enqueue(op: SyncOp, now: number = Date.now()): OutboxEntry {
    const entry: OutboxEntry = { op, enqueuedAt: now, attempts: 0 }
    this.#entries.push(entry)
    this.#persist()
    return entry
  }

  /** 服务端已确认（applied/rejected/duplicate）后出队；返回真正移除的条数。 */
  ack(opIds: readonly string[]): number {
    const set = new Set(opIds)
    const before = this.#entries.length
    this.#entries = this.#entries.filter((entry) => !set.has(entry.op.opId))
    const removed = before - this.#entries.length
    if (removed > 0) this.#persist()
    return removed
  }

  /** 标记一次推送尝试（退避统计用）。 */
  markAttempt(opIds: readonly string[]): void {
    const set = new Set(opIds)
    for (const entry of this.#entries) {
      if (set.has(entry.op.opId)) entry.attempts += 1
    }
    this.#persist()
  }

  clear(): void {
    this.#entries = []
    this.#persist()
  }

  #persist(): void {
    writeJson(this.#storage, OUTBOX_STORAGE_KEY, this.#entries)
  }
}
