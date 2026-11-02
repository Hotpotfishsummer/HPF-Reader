import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 注意：单测**故意不复用 vite.config.ts**，因为那里挂了 @wailsio/runtime 的 vite 插件，
// 而 Wails 运行时在纯 Node/浏览器环境下没有宿主桥。测试只需要 vue 插件 + 别名。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'foliate-js': fileURLToPath(new URL('./src/vendor/foliate-js', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    // 章节文档里常带外链样式表，happy-dom 默认会尝试加载并抛 DOMException 噪音。
    // 我们只测"净化后长什么样"，不需要它真的去取 CSS。
    environmentOptions: {
      happyDOM: {
        settings: {
          // 章节文档常带外链样式表；测试环境不加载它们，且**按成功处理**，
          // 否则 happy-dom 会为每条外链抛一个 DOMException 噪音。
          enableCSSFileLoading: false,
          handleDisabledFileLoadingAsSuccess: true,
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: true,
        },
      },
    },
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    globals: false,
    restoreMocks: true,
    // happy-dom 在解析带外链样式表的章节文档时会打印 DOMException 噪音
    // （"CSS file loading is disabled"）。那是测试环境的预期行为，不是被测代码的问题。
    onConsoleLog(log) {
      if (log.includes('Failed to load external stylesheet')) return false
      return undefined
    },
  },
})
