import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from '../../apps/client/frontend/src/api/client'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/**
 * 在服务器上创建账号（**这是本产品唯一的建号方式**）。
 *
 * 为什么测试要这么做：客户端和服务端都不提供公开注册 ——
 * 服务端连 /v1/auth/register 路由都不注册，账号只能由运维执行
 * `api createuser` 创建。测试如果还想「先注册再跑用例」，就必须走同一条运维路径，
 * 否则测的是一条已经不存在的能力。
 *
 * 实现：在 compose 里起一次性容器执行 createuser 子命令（等价于运维手动执行的那条命令）。
 * 口令通过 stdin 传入，避免出现在进程参数 / 日志里。
 *
 * 环境变量：
 *   HPF_TEST_NO_PROVISION=1  → 跳过建号，要求账号已由外部创建（用于连远端环境跑测试）
 *   HPF_TEST_COMPOSE_FILE    → 覆盖 compose 文件路径
 */
export function provisionAccount(email: string, password: string, displayName?: string): void {
  if (process.env['HPF_TEST_NO_PROVISION'] === '1') {
    console.log(`  [provision] 跳过建号（HPF_TEST_NO_PROVISION=1）：${email}`)
    return
  }
  const composeFile = process.env['HPF_TEST_COMPOSE_FILE'] ?? join(repoRoot, 'deploy', 'docker-compose.yml')
  const args = [
    'compose',
    '-f',
    composeFile,
    'run',
    '--rm',
    '-T',
    'api',
    'createuser',
    '--email',
    email,
    '--password-stdin',
    ...(displayName ? ['--name', displayName] : []),
  ]
  const res = spawnSync('docker', args, {
    input: password + '\n',
    encoding: 'utf8',
    env: { ...process.env, NO_PROXY: '*', no_proxy: '*' },
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
  if (res.status !== 0) {
    // 已存在不算失败：测试可能重跑同一个 runId（邮箱冲突时 createuser 会报错退出）。
    if (/already exists|duplicate|conflict/i.test(out)) {
      console.log(`  [provision] 账号已存在，复用：${email}`)
      return
    }
    throw new Error(
      `provisionAccount(${email}) 失败（docker compose run api createuser 退出码 ${res.status}）：${out}`,
    )
  }
  console.log(`  [provision] 已创建账号：${email}`)
}

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
