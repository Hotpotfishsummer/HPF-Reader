import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ApiError } from '../../apps/client/frontend/src/api/client'

export interface CheckResult {
  suite: string
  id: string
  name: string
  ok: boolean
  detail: string
  durationMs: number
}

export class TestHarness {
  checks: CheckResult[] = []
  private startTime = Date.now()

  constructor(public baseUrl: string) {}

  check(suite: string, id: string, name: string, ok: boolean, detail = '', durationMs = 0): boolean {
    this.checks.push({ suite, id, name, ok, detail, durationMs })
    const prefix = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    const detailStr = detail ? ` :: ${detail}` : ''
    console.log(`  ${prefix}  [${suite}] ${id}  ${name}${detailStr}`)
    return ok
  }

  async runStep<T>(
    suite: string,
    id: string,
    name: string,
    fn: () => Promise<T>,
    assertFn?: (res: T) => { ok: boolean; detail?: string },
  ): Promise<T> {
    const start = Date.now()
    try {
      const res = await fn()
      const durationMs = Date.now() - start
      if (assertFn) {
        const { ok, detail = '' } = assertFn(res)
        this.check(suite, id, name, ok, detail, durationMs)
      } else {
        this.check(suite, id, name, true, '', durationMs)
      }
      return res
    } catch (err) {
      const durationMs = Date.now() - start
      const detail = err instanceof Error ? err.message : String(err)
      this.check(suite, id, name, false, `Exception: ${detail}`, durationMs)
      throw err
    }
  }

  async expectApiError(
    label: string,
    fn: () => Promise<unknown>,
    expectedStatus: number,
  ): Promise<{ ok: boolean; detail: string; actualStatus?: number }> {
    try {
      await fn()
      return { ok: false, detail: `${label}: Expected HTTP ${expectedStatus} but succeeded` }
    } catch (err) {
      if (err instanceof ApiError) {
        const ok = err.status === expectedStatus
        return {
          ok,
          actualStatus: err.status,
          detail: `${label}: actual HTTP ${err.status} [${err.code}] ${err.message}`,
        }
      }
      return { ok: false, detail: `${label}: Non-ApiError ${String(err)}` }
    }
  }

  summary() {
    const passed = this.checks.filter((c) => c.ok).length
    const failed = this.checks.filter((c) => !c.ok).length
    const total = this.checks.length
    const totalDurationMs = Date.now() - this.startTime
    return { total, passed, failed, totalDurationMs }
  }
}

export function generateRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function deviceIdFor(tag: string, runId: string): string {
  const hex = createHash('sha256').update(tag + '|' + runId).digest('hex').slice(0, 12)
  return 'b2b2b2b2-0000-7000-8000-' + hex
}

export async function fileSha256(filePath: string): Promise<{ hex: string; bytes: Uint8Array; size: number }> {
  const bytes = new Uint8Array(await readFile(filePath))
  const hex = createHash('sha256').update(bytes).digest('hex')
  return { hex, bytes, size: bytes.byteLength }
}
