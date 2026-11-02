import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import wails from '@wailsio/runtime/plugins/vite'

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
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
