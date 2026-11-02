import { nativeSupportsDecompressionFormat } from './polyfills'

/**
 * ★ 启动能力探测（task-14）。
 *
 * 目的不是"替代修复"，而是**兜底**：万一某些设备的 WebView 缺的能力我们没补到，
 * 用户应该看到一句能看懂的话（"请更新 Android System WebView"），
 * 而不是白屏、静默失败、或者只看到 `TypeError: x is not a function`。
 *
 * 这里只列**会导致"书打不开"的关键能力**；缺了任何一条都给出可操作提示。
 */

export interface CapabilityProblem {
  /** 稳定的机器可读标识（日志/测试用）。 */
  code: string
  /** 给用户看的一句话（中文，不含技术黑话）。 */
  message: string
  /** 给开发者看的细节。 */
  detail: string
}

export interface CapabilityReport {
  ok: boolean
  problems: CapabilityProblem[]
  /** 探测到的 UA（日志用）。 */
  userAgent: string
}

const UPDATE_WEBVIEW_HINT =
  '请更新「Android System WebView」：在应用商店搜索它并安装更新，然后重新打开本应用。'

const REQUIRED_BUILTINS: Array<{ name: string; check: () => boolean }> = [
  { name: 'Object.groupBy', check: () => typeof (Object as unknown as AnyRecord)['groupBy'] === 'function' },
  { name: 'Object.hasOwn', check: () => typeof (Object as unknown as AnyRecord)['hasOwn'] === 'function' },
  { name: 'Array.prototype.findLastIndex', check: () => typeof (Array.prototype as unknown as AnyRecord)['findLastIndex'] === 'function' },
  { name: 'Array.prototype.at', check: () => typeof (Array.prototype as unknown as AnyRecord)['at'] === 'function' },
  { name: 'structuredClone', check: () => typeof (globalThis as unknown as AnyRecord)['structuredClone'] === 'function' },
  { name: 'Promise.withResolvers', check: () => typeof (Promise as unknown as AnyRecord)['withResolvers'] === 'function' },
  { name: 'TextDecoder', check: () => typeof (globalThis as unknown as AnyRecord)['TextDecoder'] === 'function' },
  { name: 'TransformStream', check: () => typeof (globalThis as unknown as AnyRecord)['TransformStream'] === 'function' },
  { name: 'ReadableStream', check: () => typeof (globalThis as unknown as AnyRecord)['ReadableStream'] === 'function' },
]

type AnyRecord = Record<string, unknown>

/** 探测关键能力。可重复调用，无副作用（除了构造一个瞬时 DecompressionStream）。 */
export function probeCapabilities(): CapabilityReport {
  const problems: CapabilityProblem[] = []

  for (const { name, check } of REQUIRED_BUILTINS) {
    let present = false
    try {
      present = check()
    } catch {
      present = false
    }
    if (!present) {
      problems.push({
        code: `builtin:${name}`,
        message: `当前系统的网页组件版本太旧，缺少必需的能力（${name}）。${UPDATE_WEBVIEW_HINT}`,
        detail: `${name} 不是 function；polyfill 也未能安装（可能被宿主冻结）。`,
      })
    }
  }

  // 解压格式：缺 deflate-raw 会让**真实 EPUB**（有 deflate 条目的）全部打不开。
  try {
    if (!nativeSupportsDecompressionFormat('deflate-raw')) {
      // 只有在兜底也没接管的情况下才算问题
      let handled = false
      try {
        const Constructor = (globalThis as unknown as AnyRecord)['DecompressionStream'] as
          | (new (f: string) => unknown)
          | undefined
        if (typeof Constructor === 'function') {
          new Constructor('deflate-raw')
          handled = true
        }
      } catch {
        handled = false
      }
      if (!handled) {
        problems.push({
          code: 'webapi:deflate-raw',
          message: `当前系统的网页组件无法解压这本书。${UPDATE_WEBVIEW_HINT}`,
          detail: "DecompressionStream('deflate-raw') 不可用，且 JS 兜底未生效。",
        })
      }
    }
  } catch {
    // 探测本身失败不应影响启动
  }

  return {
    ok: problems.length === 0,
    problems,
    userAgent: typeof navigator === 'object' ? navigator.userAgent : 'unknown',
  }
}
