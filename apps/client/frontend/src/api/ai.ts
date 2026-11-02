import type { ApiClient } from './client'
import { ApiError } from './client'
import type { AiJob, AiUsage, QuotaExceededError, TranslateRequest } from './contract'

/**
 * AI 相关接口的客户端封装（task-23）。
 *
 * 三条必须做对的事（否则用户会被误导）：
 *
 *   1. **429 不是网络错误**。后端用 `details.dimension` 区分 `calls` / `tokens`，
 *      带 `limit` / `used` / `resetAt`。把 429 说成"网络出错请重试"会让用户
 *      无限重试——重试永远不会成功，只会白等。这里把它翻译成 `QuotaError`。
 *
 *   2. **`paused` 不是 `failed`**。整书翻译因额度不足暂停时，已完成块级译文
 *      全部保留、下个周期自动继续。说成失败会吓到用户，还会让他重花一次钱。
 *
 *   3. **流式可取消**。用户取消后必须真的停止请求（AbortController），
 *      否则上游继续生成 = 继续烧钱。
 */

/** 配额耗尽（HTTP 429）。与网络错误/限流**刻意**分开，因为处置方式不同。 */
export class QuotaError extends Error {
  readonly dimension: 'calls' | 'tokens'
  readonly limit: number
  readonly used: number
  readonly resetAt: string

  constructor(details: QuotaExceededError['details'], message?: string) {
    super(message ?? 'quota exceeded')
    this.name = 'QuotaError'
    this.dimension = details.dimension
    this.limit = details.limit
    this.used = details.used
    this.resetAt = details.resetAt
  }

  /** 距额度重置还有多少毫秒；已过期或时间无法解析时返回 0。 */
  msUntilReset(now: number = Date.now()): number {
    const at = Date.parse(this.resetAt)
    if (Number.isNaN(at)) return 0
    return Math.max(0, at - now)
  }
}

/** 流式翻译的一次事件回调集合。 */
export interface TranslateStreamHandlers {
  /** 增量译文（逐块到达）。 */
  onDelta?(text: string): void
  /** 结束：含拼接后的全文，便于客户端对齐（不要用自己拼的结果当权威）。 */
  onDone?(translated: string): void
  /** 流中途错误（SSE 里的 event: error，此时 HTTP 状态已经是 200）。 */
  onStreamError?(error: { code: string; message: string }): void
}

export interface TranslateStreamOptions extends TranslateStreamHandlers {
  /** 取消信号。abort 之后不再有任何回调被触发。 */
  signal?: AbortSignal
  /** 术语表（本书已确认译名），会进 system 前缀。 */
  glossary?: Record<string, string>
  context?: string
  bookId?: string
  sourceLang?: string
}

/** 是否是可取消导致的 abort（而不是真正的失败）。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError'
  if (error instanceof Error) return error.name === 'AbortError' || /aborted/i.test(error.message)
  return false
}

/**
 * 解析一个 SSE 数据块。
 *
 * SSE 格式：事件之间用空行分隔，每个事件由若干 `field: value` 行组成。
 * 我们只关心 `event` 与 `data`（后端发的都是 data-only 语义的事件）。
 *
 * ⚠️ 不能用 `JSON.parse` 直接吃整块：一个 chunk 可能被网络切成两半，
 * 所以由调用方维护缓冲区，只在遇到空行时消费一个完整事件。
 */
export interface SseEvent {
  event: string
  data: string
}

/** 从缓冲区里切出所有**完整**事件，返回剩余未完成的尾巴。 */
export function drainSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  // 兼容 CRLF / CR：统一成 LF 再按空行切。
  const normalized = buffer.split('\r\n').join('\n').split('\r').join('\n')
  const parts = normalized.split('\n\n')
  // 最后一段可能是半个事件（还没收到空行），留在缓冲区里。
  const rest = parts.pop() ?? ''
  const events: SseEvent[] = []
  for (const part of parts) {
    if (part.trim() === '') continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      // 忽略 id: / retry: / 注释行（: 开头）
    }
    events.push({ event, data: dataLines.join('\n') })
  }
  return { events, rest }
}

/**
 * 把 429 响应体翻译成 `QuotaError`；其它情况原样返回 ApiError。
 *
 * 这里**只认 code === 'quota_exceeded'**：`rate_limited`（真限流）应该
 * 由调用方按"稍后重试"处理，不能混为一谈。
 */
export function translateApiError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error
  if (error.status !== 429) return error
  const details = error.details
  if (
    typeof details === 'object'
    && details !== null
    && (details as { code?: unknown }).code === 'quota_exceeded'
  ) {
    const d = (details as QuotaExceededError).details
    if (d && typeof d === 'object') return new QuotaError(d, error.message)
  }
  return error
}

export interface AiApi {
  /**
   * 流式翻译。返回完整译文。
   *
   * ⚠️ 配额不足时抛出 `QuotaError`，**在流开始之前** —— 后端刻意在写 200 与
   * 写 SSE 之前完成预扣，所以这里拿到的是标准 JSON 429，不是半截流。
   */
  translateStream(req: TranslateRequest, options?: TranslateStreamOptions): Promise<string>
  /** 本周期配额与用量。 */
  usage(): Promise<AiUsage>
  /** 提交整书翻译任务（202）。 */
  createBookTranslateJob(bookId: string, targetLang: string): Promise<AiJob>
  /** 查任务状态（轮询用）。 */
  getJob(jobId: string): Promise<AiJob>
}

export function createAiApi(client: ApiClient): AiApi {
  return {
    async translateStream(req, options = {}) {
      const { signal, glossary, context, bookId, sourceLang, onDelta, onDone, onStreamError } = options
      const body: TranslateRequest & { glossary?: Record<string, string> } = {
        text: req.text,
        targetLang: req.targetLang,
      }
      const mergedContext = context ?? req.context
      if (mergedContext) body.context = mergedContext
      const mergedBookId = bookId ?? req.bookId
      if (mergedBookId) body.bookId = mergedBookId
      const mergedSourceLang = sourceLang ?? req.sourceLang
      if (mergedSourceLang) body.sourceLang = mergedSourceLang
      if (glossary && Object.keys(glossary).length > 0) body.glossary = glossary

      const base = client.baseUrl
      const token = getTokenFromClient(client)
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (token) headers.set('Authorization', 'Bearer ' + token)

      let res: Response
      try {
        res = await fetch(base + '/v1/ai/translate', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(120_000),
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw new ApiError(0, 'network_error', error instanceof Error ? error.message : String(error))
      }

      if (!res.ok) {
        // ★ 429 在这里被翻译成 QuotaError（不是"网络错误"）。
        let payload: unknown
        try {
          payload = await res.json()
        } catch {
          payload = undefined
        }
        const code = isRecordWith(payload, 'code') ? String(payload['code']) : 'http_error'
        const message = isRecordWith(payload, 'message') ? String(payload['message']) : res.status + ' ' + res.statusText
        const apiError = new ApiError(res.status, code, message, payload)
        const translated = translateApiError(apiError)
        throw translated instanceof Error ? translated : apiError
      }

      if (!res.body) {
        throw new ApiError(res.status, 'no_stream', 'response has no body stream')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let acc = ''
      let finalText: string | null = null
      let streamErr: { code: string; message: string } | null = null

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const { events, rest } = drainSseEvents(buffer)
          buffer = rest
          for (const ev of events) {
            if (ev.data === '') continue
            let payload: unknown
            try {
              payload = JSON.parse(ev.data)
            } catch {
              continue
            }
            if (ev.event === 'delta' && isRecordWith(payload, 'text')) {
              const text = String(payload['text'])
              acc += text
              onDelta?.(text)
            } else if (ev.event === 'done') {
              // ★ 以服务端拼接的全文为准（便于对齐；本地拼接只用于乐观渲染）。
              finalText = isRecordWith(payload, 'translated') ? String(payload['translated']) : acc
              onDone?.(finalText)
            } else if (ev.event === 'error') {
              streamErr = {
                code: isRecordWith(payload, 'code') ? String(payload['code']) : 'stream_error',
                message: isRecordWith(payload, 'message') ? String(payload['message']) : 'stream error',
              }
              onStreamError?.(streamErr)
            }
          }
        }
      } catch (error) {
        // 取消时 reader.read() 会抛 AbortError：这是**预期**路径，不是失败。
        if (isAbortError(error)) throw error
        throw error
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // 已释放，忽略
        }
      }

      if (streamErr) {
        throw new ApiError(200, streamErr.code, streamErr.message)
      }
      return finalText ?? acc
    },

    async usage() {
      try {
        return await client.request<AiUsage>('/v1/ai/usage')
      } catch (error) {
        const translated = translateApiError(error)
        throw translated instanceof Error ? translated : error
      }
    },

    async createBookTranslateJob(bookId, targetLang) {
      try {
        return await client.request<AiJob>('/v1/ai/jobs', {
          method: 'POST',
          body: JSON.stringify({
            kind: 'book_translate',
            bookId,
            options: { targetLang },
          }),
        })
      } catch (error) {
        const translated = translateApiError(error)
        throw translated instanceof Error ? translated : error
      }
    },

    async getJob(jobId) {
      return client.request<AiJob>('/v1/ai/jobs/' + encodeURIComponent(jobId))
    },
  }
}

function isRecordWith(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && key in value
}

/**
 * 从 ApiClient 上取 access token。
 *
 * ApiClient 没有暴露 token getter（它是内部闭包），但 translateStream 需要
 * 自己发 fetch 才能拿到流。这里通过一个**显式注册**的 getter 解决：
 * 由 api/index.ts 在创建 client 时一并注册，避免任何隐式全局。
 */
let tokenGetter: () => string | null = () => null

export function registerAiTokenGetter(getter: () => string | null): void {
  tokenGetter = getter
}

function getTokenFromClient(_client: ApiClient): string | null {
  return tokenGetter()
}