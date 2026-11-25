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

  /**
   * 产品决定门禁：客户端**只有登录入口，没有注册入口**。
   *
   * 账号由运维在服务器上执行 `api createuser` 创建；服务端连
   * /v1/auth/register 路由都不注册（见 apps/server/internal/httpapi/no_register_test.go）。
   *
   * 为什么用源码扫描而不是"看看界面"：
   *   注册入口可以以三种形态悄悄回来 —— 一个 API 方法、一个 store action、
   *   一个弹窗页签。任何一个都能让用户点进去拿到 404，而界面测试不一定覆盖到。
   *   这里直接禁止这些符号出现在客户端源码里。
   */
  it('客户端不得存在任何注册入口（API 方法 / store action / 弹窗页签）', () => {
    /**
     * 扫描前先剥掉注释：本仓库有大量「解释为什么**没有**注册」的注释，
     * 它们会提到 /v1/auth/register 这个字符串。门禁要抓的是**真的在调用/暴露**
     * 注册能力，而不是文字里提到它。
     */
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      const source = stripComments(readFileSync(file, 'utf8'))

      // ① 不得调用注册端点
      if (/\/v1\/auth\/register/.test(source)) offenders.push(`${rel}: 引用 /v1/auth/register`)
      // ② 不得有 register(input) 这类认证 API 方法（registerSessionBook / registerAiTokenGetter 是别的域，用词边界排除）
      if (/\bregister\s*\(\s*(input|\{[^}]*email)/.test(source)) offenders.push(`${rel}: 存在 register() 认证方法`)
      // ③ 不得有注册相关的界面文案键
      if (/['"]auth\.register['"]/.test(source)) offenders.push(`${rel}: 使用 auth.register 文案`)
      if (/\bdisplayNamePlaceholder\b/.test(source)) offenders.push(`${rel}: 存在注册用昵称输入框`)
    }
    expect(offenders).toEqual([])
  })

  it('登录弹窗必须说明"账号由管理员创建"（没有注册入口时的必要提示）', () => {
    const modal = readFileSync(join(SRC, 'features', 'auth', 'components', 'AuthModal.vue'), 'utf8')
    expect(modal).toContain('auth.noSelfRegister')
    expect(modal).not.toContain("mode = 'register'")
  })
})
