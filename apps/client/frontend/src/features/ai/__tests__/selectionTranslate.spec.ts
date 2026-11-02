import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, QuotaError } from '../../../api'

/**
 * 划词翻译状态机的测试（task-23）。
 *
 * 重点验证三条**行为契约**（不是"函数被调用了"这种弱断言）：
 *   1. 429 → status='quota'（不是 'error'），且带配额文案
 *   2. 取消 → status='canceled'，**不**当错误
 *   3. 流式 delta 会累积成完整译文
 */

const mockTranslateStream = vi.fn()

vi.mock('../runtime', () => ({
  getAiApi: () => ({ translateStream: mockTranslateStream }),
}))

const { useSelectionTranslate } = await import('../composables/useSelectionTranslate')

/** 构造一个 429 的 QuotaError（与 ai.ts 里 translateApiError 的产物一致）。 */
function quotaError(dimension: 'calls' | 'tokens'): QuotaError {
  return new QuotaError({
    dimension,
    limit: 100,
    used: 100,
    resetAt: '2026-12-01T00:00:00Z',
  })
}

describe('useSelectionTranslate', () => {
  beforeEach(() => {
    mockTranslateStream.mockReset()
  })

  it('正常流式：delta 累积成完整译文，status=done', async () => {
    mockTranslateStream.mockImplementation(async (_req: unknown, options: { onDelta?: (t: string) => void }) => {
      options.onDelta?.('Hello ')
      options.onDelta?.('world')
      return 'Hello world'
    })

    const state = useSelectionTranslate()
    await state.start({ text: 'Hallo Welt', targetLang: 'en' })

    expect(state.status.value).toBe('done')
    expect(state.text.value).toBe('Hello world')
    expect(state.errorText.value).toBe('')
  })

  it('★ 429 → status=quota（不是 error），并给出配额文案', async () => {
    mockTranslateStream.mockRejectedValue(quotaError('tokens'))

    const state = useSelectionTranslate()
    await state.start({ text: 'x', targetLang: 'zh-CN' })

    // 核心：不能落到 error 分支（那会显示"网络出错请重试"）
    expect(state.status.value).toBe('quota')
    expect(state.status.value).not.toBe('error')
    expect(state.quotaMessage.value).toContain('token')
    expect(state.quotaMessage.value).toMatch(/恢复|继续/)
    expect(state.errorText.value).toBe('')
  })

  it('★ 429 calls 维度：文案说「调用次数」，不说 token', async () => {
    mockTranslateStream.mockRejectedValue(quotaError('calls'))
    const state = useSelectionTranslate()
    await state.start({ text: 'x', targetLang: 'zh-CN' })
    expect(state.status.value).toBe('quota')
    expect(state.quotaMessage.value).toContain('调用次数')
    expect(state.quotaMessage.value).not.toContain('token')
  })

  it('★ 网络错误 → status=error（这个才该显示重试）', async () => {
    mockTranslateStream.mockRejectedValue(new ApiError(0, 'network_error', 'connection refused'))
    const state = useSelectionTranslate()
    await state.start({ text: 'x', targetLang: 'zh-CN' })
    expect(state.status.value).toBe('error')
    expect(state.errorText.value).toContain('connection refused')
    expect(state.quotaMessage.value).toBe('')
  })

  it('★ 取消 → status=canceled，不当成错误', async () => {
    // 模拟一个一直不返回的流，直到 abort
    mockTranslateStream.mockImplementation((_req: unknown, options: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new DOMException('aborted', 'AbortError')
          reject(err)
        })
      })
    })

    const state = useSelectionTranslate()
    const task = state.start({ text: 'x', targetLang: 'zh-CN' })
    expect(state.status.value).toBe('streaming')

    state.cancel()
    await task

    expect(state.status.value).toBe('canceled')
    // 取消不是错误：不能有 errorText
    expect(state.errorText.value).toBe('')
  })

  it('取消后保留已收到的部分译文（用户还能看到已翻完的部分）', async () => {
    let abortSignal: AbortSignal | undefined
    mockTranslateStream.mockImplementation((_req: unknown, options: { signal?: AbortSignal; onDelta?: (t: string) => void }) => {
      abortSignal = options.signal
      options.onDelta?.('部分')
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })

    const state = useSelectionTranslate()
    const task = state.start({ text: 'x', targetLang: 'zh-CN' })
    await Promise.resolve()
    state.cancel()
    await task

    expect(state.status.value).toBe('canceled')
    expect(state.text.value).toContain('部分')
    expect(abortSignal?.aborted).toBe(true)
  })

  it('cancel() 返回是否真的中止了在途请求', async () => {
    mockTranslateStream.mockImplementation((_req: unknown, options: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const state = useSelectionTranslate()
    const task = state.start({ text: 'x', targetLang: 'zh-CN' })
    expect(state.cancel()).toBe(true)
    await task
    // 没有在途请求时 cancel 返回 false
    expect(state.cancel()).toBe(false)
  })

  it('reset() 清空全部状态', async () => {
    mockTranslateStream.mockRejectedValue(quotaError('calls'))
    const state = useSelectionTranslate()
    await state.start({ text: 'x', targetLang: 'zh-CN' })
    expect(state.status.value).toBe('quota')
    state.reset()
    expect(state.status.value).toBe('idle')
    expect(state.text.value).toBe('')
    expect(state.quotaMessage.value).toBe('')
  })

  it('新请求会中止旧请求（同一气泡不会有两个流同时写）', async () => {
    const signals: AbortSignal[] = []
    mockTranslateStream.mockImplementation((_req: unknown, options: { signal?: AbortSignal }) => {
      if (options.signal) signals.push(options.signal)
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const state = useSelectionTranslate()
    void state.start({ text: 'first', targetLang: 'zh-CN' })
    await Promise.resolve()
    void state.start({ text: 'second', targetLang: 'zh-CN' })
    await Promise.resolve()

    expect(signals.length).toBe(2)
    // 第一个必须被 abort
    expect(signals[0]?.aborted).toBe(true)
  })
})
