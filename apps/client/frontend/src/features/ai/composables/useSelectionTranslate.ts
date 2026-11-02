import { computed, ref } from 'vue'
import { isAbortError } from '../../../api'
import { getAiApi } from '../runtime'
import { formatQuotaMessage, quotaFromError } from '../quota'

/**
 * 划词翻译的状态机（task-23 最高优先级）。
 *
 * 设计要点：
 *
 *   1. **取消必须真的省钱**。用户点"停止"后 abort 掉 fetch —— 上游连接断开，
 *      后端停止向模型请求后续 token。只在前端隐藏 UI 是不够的。
 *
 *   2. **429 与网络错误分开呈现**。这是本任务第一个容易踩的点：
 *      `QuotaError` 要显示"配额不足（次数/tokens）+ 什么时候恢复"，
 *      而网络错误才显示"重试"。两者在 UI 上走完全不同的分支。
 *
 *   3. **流式渲染用 rAF 节流**。每个 delta 都触发一次 Vue 更新会让
 *      WebView 91 上的长文本翻译卡顿（每次更新都要重排气泡）。
 *      按帧合并：视觉上仍是"逐字出现"，但每帧最多一次 DOM 写入。
 */

export type TranslateStatus = 'idle' | 'streaming' | 'done' | 'error' | 'canceled' | 'quota'

export interface SelectionTranslateState {
  status: TranslateStatus
  /** 已经收到的译文（流式累积）。 */
  text: string
  /** 出错时的用户可读文案。 */
  errorText: string
  /** 配额耗尽时的结构化信息（用于显示重置时间）。 */
  quotaMessage: string
}

export interface StartOptions {
  text: string
  targetLang: string
  sourceLang?: string
  bookId?: string
  context?: string
  glossary?: Record<string, string>
}

export function useSelectionTranslate() {
  const status = ref<TranslateStatus>('idle')
  const text = ref('')
  const errorText = ref('')
  const quotaMessage = ref('')

  /**
   * 当前请求的 AbortController。
   * ⚠️ 放普通变量而不是 ref：AbortController 是命令式对象，
   * 进响应式系统只会带来无谓的 Proxy 开销。
   */
  let controller: AbortController | null = null

  /** rAF 合并：把这段时间内到达的 delta 一次性刷进 text。 */
  let pending = ''
  let rafId: number | null = null
  const supportsRaf = typeof requestAnimationFrame === 'function'

  function flush(): void {
    rafId = null
    if (pending === '') return
    text.value += pending
    pending = ''
  }

  /**
   * 强制把缓冲区写入 text（取消/结束时用）。
   *
   * 与 flush 的区别：即使有未触发的 rAF 也先取消它，保证 pending 一定被消费。
   * 这是为了不丢"已经到达但还没渲染"的文字。
   */
  function drain(): void {
    if (rafId !== null && supportsRaf) cancelAnimationFrame(rafId)
    rafId = null
    flush()
  }

  function scheduleFlush(): void {
    if (!supportsRaf) {
      // 极端环境（无 rAF）退化为立即写入：正确性优先于平滑度。
      flush()
      return
    }
    if (rafId === null) rafId = requestAnimationFrame(flush)
  }

  function clearFlush(): void {
    if (rafId !== null && supportsRaf) cancelAnimationFrame(rafId)
    rafId = null
    pending = ''
  }

  const isStreaming = computed(() => status.value === 'streaming')

  /** 中止当前翻译。返回 true 表示确实中止了一个正在进行的请求。 */
  function cancel(): boolean {
    const wasStreaming = status.value === 'streaming'
    if (controller) {
      controller.abort()
      controller = null
    }
    // ★ 必须 drain 而不是 clearFlush：缓冲里可能还有**已经到达、但还没渲染**的
    //   delta。直接丢弃会让用户眼前的文字凭空消失（真实 bug，有单测守着）。
    drain()
    if (wasStreaming) {
      status.value = 'canceled'
      return true
    }
    return false
  }

  function reset(): void {
    cancel()
    status.value = 'idle'
    text.value = ''
    errorText.value = ''
    quotaMessage.value = ''
  }

  async function start(options: StartOptions): Promise<void> {
    // 同一时间只有一个流：先中止旧的，避免两个流同时往同一个气泡里写。
    cancel()
    clearFlush()
    status.value = 'streaming'
    text.value = ''
    errorText.value = ''
    quotaMessage.value = ''

    const local = new AbortController()
    controller = local

    try {
      const finalText = await getAiApi().translateStream(
        { text: options.text, targetLang: options.targetLang },
        {
          signal: local.signal,
          ...(options.sourceLang === undefined ? {} : { sourceLang: options.sourceLang }),
          ...(options.bookId === undefined ? {} : { bookId: options.bookId }),
          ...(options.context === undefined ? {} : { context: options.context }),
          ...(options.glossary === undefined ? {} : { glossary: options.glossary }),
          onDelta: (chunk) => {
            pending += chunk
            scheduleFlush()
          },
        },
      )
      // 流正常结束：把缓冲区里剩下的刷进去（可能还有未渲染的 delta）。
      drain()
      // ★ 以服务端 done 事件的全文为准（本地拼接只用于乐观渲染）。
      if (finalText !== '') text.value = finalText
      if (controller === local) {
        status.value = 'done'
        controller = null
      }
    } catch (error) {
      if (isAbortError(error)) {
        // ★ 用户主动取消：不是错误，保留已收到的部分译文。
        //   ⚠️ 必须先 drain 再清定时器：缓冲里可能还有已经到达、但还没渲染的 delta，
        //   直接 clearFlush() 会把用户已经"看到"的部分文字抹掉（真实 bug，有单测守着）。
        drain()
        if (controller === local) status.value = 'canceled'
        return
      }
      clearFlush()
      if (controller !== local) return // 已被新请求取代，丢弃旧结果
      const quota = quotaFromError(error)
      if (quota) {
        // ★ 429 走**独立**状态：文案是"配额不足 + 恢复时间"，不是"网络出错"。
        status.value = 'quota'
        quotaMessage.value = formatQuotaMessage(quota)
        return
      }
      status.value = 'error'
      errorText.value = error instanceof Error ? error.message : String(error)
    } finally {
      if (controller === local) controller = null
    }
  }

  return {
    status,
    text,
    errorText,
    quotaMessage,
    isStreaming,
    start,
    cancel,
    reset,
  }
}

export type SelectionTranslateController = ReturnType<typeof useSelectionTranslate>