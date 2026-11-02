import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import wails from '@wailsio/runtime/plugins/vite'
import { flattenCssLayers } from './scripts/flatten-css-layers.mjs'

/**
 * ★ 兼容基线（task-14）：**Chromium 91**。
 *
 * 依据不是猜的：Android 模拟器（Pixel_6 / API31）实测 WebView UA 是
 * `Chrome/91.0.4472.114`，而 e-ink 阅读器（文石/Kindle 类）大量是
 * Android 8~11 + WebView 80~100。桌面 WebView2 是 evergreen，不是瓶颈。
 *
 * 为什么是 chrome91 而不是 `es2020`：`es2020` 只约束**语言版本**，
 * 不约束"某个浏览器到底支持到什么程度"；esbuild 需要具体浏览器才能
 * 正确决定哪些语法必须降级。chrome91 是最贴近真实运行时的具体下限。
 *
 * ⚠️ 这个 target **只降语法**，不会 polyfill 运行时内置对象
 * （`Object.groupBy` / `findLastIndex` / `Promise.withResolvers` ...）。
 * 内置对象由 `src/compat/polyfills.ts` 兜底，并用
 * `node scripts/audit-builtins.mjs src --chrome 91` 做门禁。
 */
const COMPAT_TARGET = 'chrome91'

/**
 * ★ 构建期把 CSS `@layer` 展平（task-14 追加项，WebView 91 的**第二个**真实阻塞点）。
 *
 * Tailwind v4 把所有样式包在 `@layer theme/base/components/utilities` 里，
 * 而 `@layer` 是 **Chrome 99+** 才有的。WebView 91 会把整个 `@layer` 块
 * **静默丢弃**（不报错、不抛异常、console 干净 —— 最坏的一种失败）。
 *
 * 后果实测（mobile-dev 在 WebView 91 上的一手数据）：
 *   `.absolute{position:absolute}` 算出来是 `static`
 *   `document.styleSheets[0]` 有 66 条顶层规则但 `layerBlockRules = 0`
 *   body 变成 `font:sans-serif` / `bg:transparent`
 *   → 阅读器根容器 `flex h-full` 塌掉，foliate-view 撑到 **1482px**（视口只有 843px）
 *   → paginator 拿到的容器尺寸是错的 → **真书渲染不出正文**（iframes=0、0%）
 *
 * 展平为什么不是 hack：`@layer` 的唯一语义是**层叠顺序**，而 Tailwind 输出的
 * 块顺序本身就是 theme → base → components → utilities，展平后**文档顺序与
 * 层叠顺序一致**，层叠结果等价（这正是 `postcss-cascade-layers` 做的事）。
 *
 * 注意：**只降 CSS 层叠语法**，vendor 里 paginator 的 `@container` 查询是另一件事 ——
 * 我们已经用 `useReaderLayout` 显式设置 `max-column-count` 属性，绕过了它（见
 * `src/reader/useFoliateEngine.ts` 的 `setLayout`）。
 */
function flattenCssLayersPlugin(): Plugin {
  let outDir = ''
  return {
    name: 'hpf-flatten-css-layers',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const assetsDir = join(outDir, 'assets')
      let files: string[]
      try {
        files = readdirSync(assetsDir).filter((name) => name.endsWith('.css'))
      } catch {
        return // 没有 CSS 产物就没什么可做的
      }
      for (const name of files) {
        const path = join(assetsDir, name)
        if (!statSync(path).isFile()) continue
        const original = readFileSync(path, 'utf8')
        if (!original.includes('@layer')) continue
        const result = flattenCssLayers(original)
        writeFileSync(path, result.css, 'utf8')
        // 构建日志里留痕，便于复核"确实降级了"
        this.info(
          `flatten-css-layers: ${name} 展平 ${result.blocks} 个 @layer 块、丢弃 ${result.statements} 条顺序声明（` +
            `${original.length} → ${result.css.length} B）`,
        )
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    target: COMPAT_TARGET,
  },
  esbuild: {
    // 让 dev/SSR 走同一条降级规则，避免"开发能用、构建后不能用"的假象。
    target: COMPAT_TARGET,
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [vue(), tailwindcss(), wails('./bindings'), flattenCssLayersPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // foliate-js 是 vendor 进来的上游源码（固定 commit，见 src/vendor/foliate-js/VENDOR.md）。
      // 用别名让代码里写 'foliate-js/view.js'，同时避开 npm 上的冒名包。
      'foliate-js': fileURLToPath(new URL('./src/vendor/foliate-js', import.meta.url)),
    },
  },
})
