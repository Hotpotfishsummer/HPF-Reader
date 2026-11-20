// ★ 必须排在**第一行**：polyfill 要先于其他模块的顶层代码生效。
//   详见 src/compat/polyfills.ts —— WebView 不是随浏览器更新的，
//   老 Android WebView(Chromium 91) 缺 Object.groupBy，会让 foliate-js 打不开任何书。
import { INSTALLED_POLYFILLS, verifyPolyfills } from './compat/polyfills'
import { probeCapabilities } from './compat/capabilities'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import { router } from './app/router'
import { i18n } from './i18n'
import { createPlatform, installPlatform } from './platform'
import './styles/theme.css'

if (INSTALLED_POLYFILLS.length > 0) {
  console.info(`[polyfill] 已补齐运行时内置对象：${INSTALLED_POLYFILLS.join(', ')}`)
}
const polyfillProblems = verifyPolyfills()
if (polyfillProblems) {
  console.warn(`[polyfill] 自检未通过：${polyfillProblems}`)
}

/**
 * 启动能力探测：缺关键能力时给出**用户能看懂**的提示，而不是白屏或
 * `TypeError: xxx is not a function`。这是兜底，不是修复的替代品。
 * 结果挂到 `window.__HPF_CAPABILITIES__` 供排障/E2E 读取。
 */
const capabilityReport = probeCapabilities()
;(window as unknown as Record<string, unknown>)['__HPF_CAPABILITIES__'] = capabilityReport
if (!capabilityReport.ok) {
  console.warn('[capability] 关键能力缺失：', capabilityReport.problems)
  for (const problem of capabilityReport.problems) console.warn(`[capability] ${problem.message}`)
}

async function bootstrap(): Promise<void> {
  const app = createApp(App)

  const pinia = createPinia()
  pinia.use(piniaPluginPersistedstate)
  app.use(pinia)
  app.use(router)
  app.use(i18n)
  app.use(VueQueryPlugin, {
    queryClientConfig: {
      defaultOptions: {
        queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
      },
    },
  })

  // 平台实现在挂载前解析完成：业务组件不需要处理"平台还没准备好"的中间态。
  const platform = await createPlatform()
  installPlatform(app, platform)

  // ★ 安全：在挂载前解析 API 传输方式（桌面端 = 本机 Go 中继）。
  //   放在挂载之前，是为了让**第一个** API 请求就走严格 TLS 校验的通道，
  //   而不是先漏一个直连请求。失败时返回 null（诚实降级为直连）。
  try {
    await platform.resolveApiTransport()
  } catch (error) {
    console.warn('[security] 解析 API 传输方式失败，API 将直连（证书校验退化）', error)
  }

  await router.isReady()
  app.mount('#app')
}

void bootstrap()
