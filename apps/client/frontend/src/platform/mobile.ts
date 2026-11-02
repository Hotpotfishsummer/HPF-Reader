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
    files: {
      ...base.files,
      async importBookFromDialog() {
        // TODO(M1-G1): 接入 Android SAF / iOS UIDocumentPicker 后返回真实结果。
        // 现在显式返回 null（"未选择"），而不是伪造成功。
        return null
      },
    },
  }
}
