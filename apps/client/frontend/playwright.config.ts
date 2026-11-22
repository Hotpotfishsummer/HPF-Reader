import { defineConfig, devices } from '@playwright/test'

/**
 * E2E 配置。
 *
 * 为什么要有 E2E：foliate-js 是命令式渲染，依赖 ResizeObserver / CSS 多列 / getClientRects 的
 * **真实几何**，jsdom / happy-dom 没有布局引擎（getBoundingClientRect 恒为 0），必然测不对。
 * 所以引擎行为只能用真实浏览器测（docs/research/50-vue3-reader-stack.md §11）。
 *
 * 用系统已安装的 Chrome（channel: 'chrome'），避免下载 Playwright 自带浏览器。
 */
export default defineConfig({
  // 用例统一放在仓库根 tests/e2e；config 必须留在 frontend 才能解析 @playwright/test。
  // frontend → apps/client → apps → <repo root>
  testDir: '../../../tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'corepack pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
})
