import { inject, type App, type InjectionKey } from 'vue'
import { createServerPlatform } from './server'
import { createTestPlatform } from './test'
import type { Platform } from './types'

export * from './types'
export { createTestPlatform, type TestPlatform, type TestPlatformOptions } from './test'
export { createServerPlatform, type ServerPlatformOptions } from './server'

export const PlatformKey: InjectionKey<Platform> = Symbol('hpf.platform')

/**
 * 宿主探测。
 *
 * 不能靠 `window._wails`：那个全局是 **@wailsio/runtime 自己 import 时创建的**，
 * 用它做探测等于"已经加载了才算 Wails"，顺序反了。
 * 这里探测的是各个 WebView 宿主真正注入的桥：
 *   - Windows(WebView2): window.chrome.webview
 *   - macOS/iOS(WKWebView): window.webkit.messageHandlers.external
 *   - Android: window.wails.invoke (addJavascriptInterface)
 */
export function isWailsHost(win: Window = window): boolean {
  const w = win as unknown as {
    chrome?: { webview?: unknown }
    webkit?: { messageHandlers?: Record<string, unknown> }
    wails?: { invoke?: unknown; invokeAsync?: unknown }
  }
  return Boolean(
    w.wails?.invoke
    || w.wails?.invokeAsync
    || w.chrome?.webview
    || w.webkit?.messageHandlers?.['external'],
  )
}

function isMobileHost(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/**
 * 按宿主创建平台实现。
 *
 * 桌面/移动的实现用**动态 import**：这样 Web 构建里 @wailsio/runtime 与 bindings
 * 根本不会被打进主 chunk（R13：@wailsio/runtime 被误引入 Web 构建会白屏）。
 */
export async function createPlatform(): Promise<Platform> {
  const forced = import.meta.env.VITE_HPF_PLATFORM
  if (forced === 'test') return createTestPlatform()
  if (forced === 'web') {
    return createServerPlatform({ baseUrl: import.meta.env.VITE_HPF_API_BASE ?? '' })
  }
  if (forced === 'wails' || isWailsHost()) {
    if (isMobileHost()) {
      const { createMobilePlatform } = await import('./mobile')
      return createMobilePlatform()
    }
    const { createDesktopPlatform } = await import('./desktop')
    return createDesktopPlatform()
  }
  return createServerPlatform({ baseUrl: import.meta.env.VITE_HPF_API_BASE ?? '' })
}

let currentPlatform: Platform | null = null

/** 测试环境显式设置或重置平台实例。 */
export function setPlatformForTest(platform: Platform | null): void {
  currentPlatform = platform
}

/** 在 main.ts 里注入（而不是全局单例），这样 E2E 可以替换成 testPlatform。 */
export function installPlatform(app: App, platform: Platform): void {
  currentPlatform = platform
  app.provide(PlatformKey, platform)
}

/** 业务代码唯一的平台入口。 */
export function usePlatform(): Platform {
  if (currentPlatform) return currentPlatform
  const platform = inject(PlatformKey)
  if (!platform) {
    throw new Error('[platform] PlatformKey 未注入：请在 main.ts 里调用 installPlatform(app, platform)')
  }
  return platform
}
