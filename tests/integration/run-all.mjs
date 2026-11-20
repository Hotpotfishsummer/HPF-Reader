import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const frontend = join(root, 'apps', 'client', 'frontend')
const out = process.env.HPF_REPORT_DIR ?? join(here, 'evidence')
const entry = join(here, 'main.ts')
const bundleDir = join(here, '.build')
const bundle = join(bundleDir, 'main.mjs')

mkdirSync(out, { recursive: true })
mkdirSync(bundleDir, { recursive: true })

const viteEntry = join(frontend, 'node_modules', 'vite', 'dist', 'node', 'index.js')
if (!existsSync(viteEntry)) {
  console.error('vite not found at ' + viteEntry)
  process.exit(2)
}
const { build } = await import(pathToFileURL(viteEntry).href)

console.log('[build] 打包集成测试入口: ' + entry + ' -> ' + bundle)
const started = Date.now()
await build({
  configFile: false,
  root: frontend,
  logLevel: 'warn',
  resolve: { alias: { '@': join(frontend, 'src') } },
  build: {
    ssr: entry,
    outDir: bundleDir,
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: 'main.mjs', format: 'es' } },
  },
})
console.log('[build] 完成，耗时 ' + (Date.now() - started) + 'ms\n')

// 运行测试，NODE_TLS_REJECT_UNAUTHORIZED=0 用于测试 Caddy 本地自签证书，NO_PROXY 避免本地代理拦截
const result = spawnSync(process.execPath, [bundle], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NO_PROXY: '*',
    no_proxy: '*',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    HPF_API_BASE: process.env.HPF_API_BASE ?? 'http://127.0.0.1:8080',
    HPF_CADDY_BASE: process.env.HPF_CADDY_BASE ?? 'https://localhost',
    HPF_ROOT: root,
    HPF_REPORT_DIR: out,
    HPF_BOOKS_DIR: process.env.HPF_BOOKS_DIR ?? join(root, 'testdata', 'books'),
  },
})
process.exit(result.status ?? 1)
