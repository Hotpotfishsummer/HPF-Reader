import { createDesktopPlatform } from './desktop'
import type { CapabilityName, Platform } from './types'

/**
 * 移动端（Wails v3 iOS/Android，官方标注 experimental）平台骨架。
 *
 * ⚠️ 目前复用桌面实现：Wails 移动端同样走 window.wails / 同一套 bindings，
 * 因此能力集合相同；差异集中在**能力探测**与**禁止的能力**上，写在这里而不是散落在业务代码里。
 *
 * 移动端明确不做的事（ADR-002 §3 / G1 闸门）：
 *   - 系统文件对话框语义不同（走 SAF / UIDocumentPicker），M1 先不接；
 *   - 移动端没有"另开窗口"能力，阅读器必须同窗口内嵌。
 */
const MOBILE_CAPABILITIES: readonly CapabilityName[] = ['library.local', 'sync.outbox', 'system.openExternal']

export function createMobilePlatform(): Platform {
  const base = createDesktopPlatform()
  return {
    ...base,
    kind: 'wails',
    capabilities: MOBILE_CAPABILITIES,
    // 移动端不经过 WebView2/Chromium 的 --ignore-certificate-errors 问题路径：
    // 直接用系统 WebView 的原生 fetch（TLS 校验由 WebView 自己完成）。
    // 显式返回 null 而不是继承桌面实现，避免把"本机中继"语义带到没有它的平台上。
    async resolveApiTransport() {
      return null
    },
    // library.importBookBytes（云端下载 -> 本地书库）直接继承桌面实现：
    // 移动端同样有本地书库（capabilities 含 'library.local'），走同一套 Go bindings。
    files: {
      ...base.files,
      async importBookFromDialog() {
        // TODO(M1-G1): 接入 Android SAF / iOS UIDocumentPicker 后返回真实结果。
        // 现在显式返回 null（"未选择"），而不是伪造成功。
        return null
      },
    },
    window: {
      hasControls: false,
      isMacTrafficLights: false,
      async minimize() {},
      async toggleMaximize() {},
      async close() {},
      async isMaximized() {
        return false
      },
      async toggleFullscreen() {},
      async isFullscreen() {
        return false
      },
    },
  }
}
