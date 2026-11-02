#!/usr/bin/env node
/**
 * 从 api/openapi.yaml 生成 TypeScript 类型到 src/api/schema.d.ts。
 *
 * 契约文件是**唯一权威来源**（api/ 目录只读，客户端不得修改它）。
 * 用法：
 *   cd apps/client/frontend && corepack pnpm run api:types
 *
 * 直接调用 openapi-typescript 的 JS API（而不是 CLI 子进程）：
 * 这样不依赖 npx / shell 解析，Windows 与 CI 上行为一致。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import openapiTS, { astToString } from 'openapi-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(here, '..')
// frontend 在 apps/client/frontend，契约文件在仓库根 api/openapi.yaml → 上溯 3 级。
const specPath = resolve(frontendRoot, '../../../api/openapi.yaml')
const outPath = resolve(frontendRoot, 'src/api/schema.d.ts')

const banner = `/**
 * 本文件由 scripts/gen-api-types.mjs 从 api/openapi.yaml 生成，请勿手改。
 * 重新生成: corepack pnpm run api:types
 */

`

try {
  const ast = await openapiTS(new URL(`file://${specPath.replace(/\\/g, '/')}`))
  const output = astToString(ast)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, banner + output, 'utf8')
  const specBytes = readFileSync(specPath).length
  console.log(`[gen-api-types] 已写入 ${outPath} (源 ${specBytes} bytes)`)
} catch (error) {
  console.error('[gen-api-types] 生成失败:', error instanceof Error ? error.message : error)
  process.exit(1)
}
