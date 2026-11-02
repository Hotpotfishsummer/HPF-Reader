/// <reference types="vite/client" />

// 注意：这里**不要**写 `declare module '*.vue'`。
// vue-tsc 原生支持 .vue 的 SFC 类型推导，加通配声明会把它覆盖成 unknown props。

interface ImportMetaEnv {
  /** 强制指定平台实现：wails | web。用于 E2E 与浏览器预览。 */
  readonly VITE_HPF_PLATFORM?: string
  /** Web/server 平台的后端基地址。 */
  readonly VITE_HPF_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
