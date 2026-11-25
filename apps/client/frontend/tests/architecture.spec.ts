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

  /**
   * 门禁：模板里不得出现「先翻转自己、再在同一条语句里把自己关掉」的写法。
   *
   * 真实 bug（用户反馈"Aa 按钮打不开"）：
   *   @toggle-typography="typographyOpen = !typographyOpen; ...; typographyOpen = false; ..."
   * 前半句把它设为 true，后半句（"顺手关掉其它面板"的那一长串）又把它设回 false。
   * 结果按钮点了永远没反应，而模板字符串太长，review 时完全看不出来。
   *
   * 现在翻转逻辑在 src/reader/panelToggle.ts（有单测），模板只允许绑定函数名。
   */
  it('模板不得在事件绑定里"先翻转再关自己"（导致按钮点了没反应）', () => {
    /**
     * 只扫 <template> 段，并剥掉 HTML 注释。
     *
     * 两个理由：
     *   ① 要抓的是模板绑定，<script> 里的普通代码（`x = !x` 之后再赋别的值）是合法的；
     *   ② ReaderView.vue 的 <script> 里有一段注释**引用**了这个旧写法来说明 bug 原因，
     *      不剥掉就会把文档当成违规。
     */
    const templateOf = (src: string): string => {
      const m = /<template>([\s\S]*)<\/template>/.exec(src)
      const body = m?.[1] ?? ''
      return body.replace(/<!--[\s\S]*?-->/g, '')
    }

    const offenders: string[] = []
    for (const file of files) {
      if (!file.endsWith('.vue')) continue
      const rel = relative(SRC, file)
      const source = templateOf(readFileSync(file, 'utf8'))

      // 逐个事件绑定取值，例如 @toggle-x="A = !A; B = false; A = false"
      const bindingRe = /@[\w:-]+\s*=\s*"([^"]*)"/g
      let match: RegExpExecArray | null
      while ((match = bindingRe.exec(source)) !== null) {
        const expr = match[1] ?? ''
        // 找出所有「X = !X」里的 X
        const flipRe = /\b(\w+)\s*=\s*!\s*\1\b/g
        let flip: RegExpExecArray | null
        while ((flip = flipRe.exec(expr)) !== null) {
          const name = flip[1]
          // 同一个名字在翻转之后又被显式设为 false ⇒ 必然打不开
          const after = expr.slice(flip.index + flip[0].length)
          if (new RegExp(`\\b${name}\\s*=\\s*false\\b`).test(after)) {
            offenders.push(`${rel}: ${name} 先翻转再被设为 false（绑定: ${expr.slice(0, 80)}…）`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * 门禁：设置页里的**按钮文案**不得互相包含。
   *
   * 真实事故：翻页设置里加了「恢复默认键位」，而服务器地址区早就有「恢复默认」。
   * 于是 e2e 的 `getByRole('button', { name: '恢复默认' })` 从唯一匹配变成歧义匹配，
   * 报 "strict mode violation" —— 看起来像服务器设置坏了，实际是新按钮撞了名字。
   *
   * ★ 只查**真的渲染成 button 的**文案：像「同步」/「从未同步」这种一个是标题、
   *   一个是状态文本，不会互相干扰；一刀切查所有文案只会制造噪音。
   */
  it('设置页按钮文案不得互相包含（会让 e2e 的角色名匹配产生歧义）', () => {
    const zh = readFileSync(join(SRC, 'i18n', 'locales', 'zh-CN.ts'), 'utf8')
    const settingsBlock = /settings:\s*\{([\s\S]*?)\n  \},/.exec(zh)?.[1] ?? ''
    expect(settingsBlock.length, '未能定位 settings 文案块').toBeGreaterThan(0)

    // 收集 settings.* 的纯文本文案
    const texts = new Map<string, string>()
    for (const m of settingsBlock.matchAll(/^\s{4}(\w+):\s*'([^']{2,})',?$/gm)) {
      const key = m[1] ?? ''
      const text = m[2] ?? ''
      if (!/\{/.test(text) && /[\u4e00-\u9fa5]/.test(text)) texts.set(key, text)
    }

    /**
     * 哪些 key 真的被当成按钮文本渲染。
     * 扫设置相关 .vue 里的 `<button>...</button>` 片段，看它引用了哪个 `t('settings.X')`。
     */
    const buttonKeys = new Set<string>()
    const vueFiles = [
      join(SRC, 'features', 'settings', 'SettingsView.vue'),
      join(SRC, 'features', 'settings', 'PageTurnSettings.vue'),
    ]
    for (const file of vueFiles) {
      if (!existsSync(file)) continue
      const src = readFileSync(file, 'utf8')
      for (const btn of src.matchAll(/<button[\s\S]*?<\/button>/g)) {
        for (const ref of btn[0].matchAll(/t\('settings\.(\w+)'\)/g)) {
          buttonKeys.add(ref[1] ?? '')
        }
      }
    }
    expect(buttonKeys.size, '未找到任何按钮文案引用').toBeGreaterThan(2)

    const offenders: string[] = []
    const keys = [...buttonKeys]
    for (const a of keys) {
      for (const b of keys) {
        if (a === b) continue
        const ta = texts.get(a)
        const tb = texts.get(b)
        if (!ta || !tb || ta === tb) continue
        // a 是 b 的真子串 ⇒ getByRole(name) 会歧义
        if (tb.includes(ta) && tb.length > ta.length) {
          offenders.push(`settings.${a}「${ta}」是 settings.${b}「${tb}」的子串`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
