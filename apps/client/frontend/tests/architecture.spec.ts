import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 架构门禁（把"业务代码不得直接 import bindings"从口头约定变成可执行的测试）。
 * 对应 docs/research/50-vue3-reader-stack.md §2.3 与 task-9 步骤 4。
 *
 * ★ 为什么本文件在 `frontend/tests/` 而不是 `src/`（别顺手搬）：
 *   它要用 `node:fs` / `node:path` / `process` 扫源码树，而前端 tsconfig 的
 *   `types` 只有 `["vite/client"]`（不含 node 全局）。一旦落进 `src/**` 的
 *   tsconfig include 范围，`vue-tsc --noEmit` 会报 TS2591 并直接让构建失败。
 *   放在 `src/` 之外，则由 vitest 的 `tests/**\/*.spec.ts` include 收编。
 *   目录纪律见仓库根 AGENTS.md 与 tests/README.md。
 */

/**
 * 定位 src 目录：从 cwd 往上找，直到找到 src/reader/sanitize.ts。
 * 不用 import.meta.url —— vitest 在不同环境里可能给出非 file: 的 URL。
 */
function findSrc(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'src')
    if (existsSync(join(candidate, 'reader', 'sanitize.ts'))) return candidate
    dir = dirname(dir)
  }
  throw new Error(`找不到 src 目录（cwd=${process.cwd()}）`)
}

const SRC = findSrc()

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // vendor 是上游第三方源码，不受我们的架构规则约束。
      if (entry === 'vendor' || entry === '__tests__') continue
      walk(full, out)
    } else if (/\.[cm]?[jt]sx?$|\.[jt]sx?$|.vue$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** 允许 import bindings / @wailsio/runtime 的白名单。 */
const PLATFORM_ADAPTERS = [
  join('platform', 'desktop.ts'),
  join('platform', 'mobile.ts'),
]

describe('架构门禁', () => {
  const files = walk(SRC)

  it('业务代码不得 import Wails 生成的 bindings', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      if (PLATFORM_ADAPTERS.includes(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (/from\s*['"][^'"]*\/bindings\//.test(source) || /from\s*['"]@\/bindings\//.test(source)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('业务代码不得 import @wailsio/runtime（只有平台适配层可以）', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      if (PLATFORM_ADAPTERS.includes(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (/from\s*['"]@wailsio\/runtime/.test(source)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('没有任何文件用 ref()/reactive() 包裹 foliate-js 实例（硬规则 §5.2）', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      // 只扫引擎相关文件，避免误报普通状态
      if (!/foliate|engine/i.test(file)) continue
      if (/ref\s*(<[^>]*>)?\(\s*document\.createElement\s*\(\s*['"]foliate/i.test(source)) {
        offenders.push(relative(SRC, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('foliate-view 的实例必须来自 markRaw 或闭包变量（useFoliateEngine 里显式检查）', () => {
    const engine = readFileSync(join(SRC, 'reader', 'useFoliateEngine.ts'), 'utf8')
    expect(engine).toContain('markRaw(document.createElement')
    expect(engine).toContain('let view: View | null = null')
    // 不允许把 view 塞进 ref
    expect(engine).not.toMatch(/ref<[^>]*View[^>]*>\s*\(/)
  })
})
