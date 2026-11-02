import { describe, expect, it } from 'vitest'
import { ApiError } from '../client'
import { drainSseEvents, isAbortError, QuotaError, translateApiError } from '../ai'

/**
 * SSE 解析与错误翻译的测试（task-23 的核心正确性）。
 *
 * 两个最危险的错误：
 *   1. 把 429 当成网络错误 → 用户无限重试，永远不会成功。
 *   2. SSE 分块解析写错 → 译文丢字/错位，且**没有任何报错**（静默错误）。
 */

describe('drainSseEvents', () => {
  it('解析单个完整事件', () => {
    const { events, rest } = drainSseEvents('event: delta\ndata: {"text":"你好"}\n\n')
    expect(rest).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('delta')
    expect(events[0]?.data).toBe('{"text":"你好"}')
  })

  it('解析多个连续事件', () => {
    const buf =
      'event: delta\ndata: {"text":"A"}\n\n'
      + 'event: delta\ndata: {"text":"B"}\n\n'
      + 'event: done\ndata: {"translated":"AB"}\n\n'
    const { events } = drainSseEvents(buf)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'done'])
  })

  it('★ 不完整的事件留在 rest 里（网络会把一个事件切成两半）', () => {
    const { events, rest } = drainSseEvents('event: delta\ndata: {"text":"你')
    expect(events).toHaveLength(0)
    expect(rest).toBe('event: delta\ndata: {"text":"你')
  })

  it('★ 分块拼接后能正确还原（模拟真实流式到达）', () => {
    const chunks = ['event: del', 'ta\ndata: {"te', 'xt":"Hello"}\n', '\n']
    let buffer = ''
    const all = []
    for (const chunk of chunks) {
      buffer += chunk
      const { events, rest } = drainSseEvents(buffer)
      buffer = rest
      all.push(...events)
    }
    expect(all).toHaveLength(1)
    expect(all[0]?.data).toBe('{"text":"Hello"}')
    expect(buffer).toBe('')
  })

  it('兼容 CRLF 换行（某些代理会改写）', () => {
    const { events } = drainSseEvents('event: delta\r\ndata: {"text":"x"}\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('delta')
  })

  it('忽略注释行（: 开头）与 id/retry 字段', () => {
    const { events } = drainSseEvents(': keepalive\nid: 7\nretry: 1000\nevent: delta\ndata: {"text":"y"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('delta')
  })

  it('多行 data 用换行拼接（SSE 规范）', () => {
    const { events } = drainSseEvents('event: delta\ndata: line1\ndata: line2\n\n')
    expect(events[0]?.data).toBe('line1\nline2')
  })

  it('空 data 的事件不崩', () => {
    const { events } = drainSseEvents('event: delta\ndata:\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('')
  })

  it('空输入返回空结果', () => {
    const { events, rest } = drainSseEvents('')
    expect(events).toHaveLength(0)
    expect(rest).toBe('')
  })
})

describe('translateApiError（429 → QuotaError）', () => {
  function apiError(status: number, code: string, details: unknown): ApiError {
    return new ApiError(status, code, 'message', details)
  }

  it('★ 429 + quota_exceeded → QuotaError（不是普通 ApiError）', () => {
    const err = apiError(429, 'quota_exceeded', {
      code: 'quota_exceeded',
      message: 'quota',
      details: { dimension: 'tokens', limit: 100, used: 100, resetAt: '2026-12-01T00:00:00Z' },
    })
    const translated = translateApiError(err)
    expect(translated).toBeInstanceOf(QuotaError)
    const quota = translated as QuotaError
    expect(quota.dimension).toBe('tokens')
    expect(quota.resetAt).toBe('2026-12-01T00:00:00Z')
  })

  it('★ 429 + rate_limited（真限流）**不**翻译成 QuotaError', () => {
    // 限流应该由调用方按"稍后重试"处理，不能混为一谈。
    const err = apiError(429, 'rate_limited', { code: 'rate_limited', message: 'slow down' })
    const translated = translateApiError(err)
    expect(translated).toBe(err)
    expect(translated).not.toBeInstanceOf(QuotaError)
  })

  it('非 429 的错误原样返回', () => {
    const err = apiError(500, 'internal', {})
    expect(translateApiError(err)).toBe(err)
  })

  it('非 ApiError 原样返回', () => {
    const err = new Error('boom')
    expect(translateApiError(err)).toBe(err)
  })

  it('429 但 details 结构不对时不崩（原样返回）', () => {
    expect(translateApiError(apiError(429, 'quota_exceeded', { code: 'quota_exceeded' }))).toBeInstanceOf(ApiError)
    expect(translateApiError(apiError(429, 'quota_exceeded', null))).toBeInstanceOf(ApiError)
  })
})

describe('isAbortError', () => {
  it('识别 AbortError（取消是预期路径，不是失败）', () => {
    const err = new DOMException('aborted', 'AbortError')
    expect(isAbortError(err)).toBe(true)
  })

  it('识别名字为 AbortError 的 Error', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isAbortError(err)).toBe(true)
  })

  it('普通错误不是 abort', () => {
    expect(isAbortError(new Error('network'))).toBe(false)
    expect(isAbortError('abort')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})
