/**
 * 给 vendored fflate 的最小类型声明。
 *
 * foliate-js 自带的 `vendor/fflate.js` 只 export 了 `unzlibSync` 一个函数
 * （它是 fflate 的裁剪版，只做 zlib 容器的 inflate，不导出 deflate 侧）。
 * 我们不引入 npm 的 fflate 依赖，直接用这一份 —— 零新增依赖。
 */
declare module 'foliate-js/vendor/fflate.js' {
  export function unzlibSync(data: Uint8Array, options?: { out?: Uint8Array }): Uint8Array
}
