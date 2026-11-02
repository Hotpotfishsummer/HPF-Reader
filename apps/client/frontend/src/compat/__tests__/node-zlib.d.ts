/**
 * 只为单元测试提供 `node:zlib` 的最小类型声明。
 *
 * 为什么需要它：`tsconfig.json` 的 `types` 只有 `["vite/client"]`（故意不装 `@types/node`，
 * 避免前端代码误用 Node 全局）。但 `deflateRaw.spec.ts` 需要用 `deflateRawSync` **生成真实的
 * 裸 deflate 数据**来验证 polyfill —— 手搓的假数据验证不了真实的 ZIP 解压路径。
 *
 * 只声明测试实际用到的两个函数，不引入完整 Node 类型。
 */
declare module 'node:zlib' {
  export interface DeflateRawOptions {
    level?: number
  }
  export function deflateRawSync(data: Uint8Array, options?: DeflateRawOptions): Uint8Array
  export function inflateRawSync(data: Uint8Array): Uint8Array
}
