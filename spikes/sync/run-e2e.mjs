/**
 * 同步联调运行器：用项目自带的 vite 把 e2e.ts 打成单文件 ESM，再交给 node 执行。
 *
 * 为什么不用 esbuild CLI：本仓库 node_modules 里没有独立 esbuild CLI（已实测 Command not found），
 * 而 vite 是现成的、且与前端 build 用同一套解析规则（含 TS、路径别名、import.meta.env）。
 *
 * 用法：node spikes/sync/run-e2e.mjs
 * 环境变量：
 *   HPF_SPIKE_BASE  服务端地址（默认 http://127.0.0.1:18080）
 *   HPF_SPIKE_BOOK  真实 EPUB 路径（默认 testdata/books/frankenstein.epub）
 *   HPF_SPIKE_OUT   证据目录（默认 spikes/sync/evidence）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const frontend = join(root, 'apps', 'client', 'frontend')
const out = process.env.HPF_SPIKE_OUT ?? join(here, 'evidence')
const entry = join(here, 'e2e.ts')
const bundleDir = join(here, '.build')
const bundle = join(bundleDir, 'e2e.mjs')

mkdirSync(out, { recursive: true })
mkdirSync(bundleDir, { recursive: true })

const viteEntry = join(frontend, 'node_modules', 'vite', 'dist', 'node', 'index.js')
if (!existsSync(viteEntry)) {
  console.error('vite not found at ' + viteEntry)
  process.exit(2)
}
const { build } = await import(pathToFileURL(viteEntry).href)

console.log('[build] ' + entry + ' -> ' + bundle)
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
    rollupOptions: { output: { entryFileNames: 'e2e.mjs', format: 'es' } },
  },
})
console.log('[build] done in ' + (Date.now() - started) + 'ms')

const result = spawnSync(process.execPath, [bundle], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HPF_SPIKE_BASE: process.env.HPF_SPIKE_BASE ?? 'http://127.0.0.1:18080',
    HPF_SPIKE_ROOT: root,
    HPF_SPIKE_OUT: out,
    HPF_SPIKE_BOOK: process.env.HPF_SPIKE_BOOK ?? join(root, 'testdata', 'books', 'frankenstein.epub'),
  },
})
process.exit(result.status ?? 1)
