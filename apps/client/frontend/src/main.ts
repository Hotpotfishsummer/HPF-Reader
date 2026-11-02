import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import { router } from './app/router'
import { i18n } from './i18n'
import { createPlatform, installPlatform } from './platform'
import './styles/theme.css'

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

  await router.isReady()
  app.mount('#app')
}

void bootstrap()
