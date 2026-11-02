import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import wails from '@wailsio/runtime/plugins/vite'
import postcssCascadeLayers from '@csstools/postcss-cascade-layers'

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
 * ★ 构建期把 CSS `@layer` 扁平化（task-17，WebView 91 的**第二个**真实阻塞点）。
 *
 * Tailwind v4 把所有样式包在 `@layer theme/base/components/utilities` 里，
 * 而 `@layer` 是 **Chrome 99+** 才有的。WebView 91 会把整个 `@layer` 块
 * **静默丢弃**（不报错、不抛异常、console 干净 —— 最坏的一种失败）。
 *
 * 实测后果（WebView 91 / Android 12）：
 *   layerProbe: 0、顶层规则 66 条中 layer 块 = 0
 *   `.absolute{position:absolute}` → `static`
 *   `.flex` → `block`、`.h-full` → `auto`
 *   工具栏按钮 `border-radius:0px`、body 背景透明
 *   foliate-view 被撑到 **1482px**（视口仅 843px），正文被推出可视区
 *
 * 用官方 polyfill `@csstools/postcss-cascade-layers` 展平：它把 `@layer`
 * 展开成等效的普通规则，并在必要处用 `:where()` 降 specificity 来
 * 保持原来的层叠语义。**保留 Tailwind v4，不降级到 v3。**
 *
 * 注意这**只是 CSS 层叠语法降级**；vendor 里 paginator 的 `@container`
 * 查询是另一件事，已由 `useReaderLayout` 显式设置 `max-column-count` 绕过。
 */
const postcssPlugins = [
  // Tailwind v4 的 @layer 输出必须展平，否则老 WebView 整份样式表作废。
  postcssCascadeLayers(),
]

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
  css: {
    postcss: {
      plugins: postcssPlugins,
    },
  },
  plugins: [vue(), tailwindcss(), wails('./bindings')],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // foliate-js 是 vendor 进来的上游源码（固定 commit，见 src/vendor/foliate-js/VENDOR.md）。
      // 用别名让代码里写 'foliate-js/view.js'，同时避开 npm 上的冒名包。
      'foliate-js': fileURLToPath(new URL('./src/vendor/foliate-js', import.meta.url)),
    },
  },
})