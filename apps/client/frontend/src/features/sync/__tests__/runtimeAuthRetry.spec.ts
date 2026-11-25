import { describe, expect, it } from 'vitest'
import { createSyncRuntime } from '../runtime'
import { SESSION_STORAGE_KEY } from '../session'
import { createMemoryStorage } from '../storage'

/**
 * 集成级回归：**整条 runtime 装配**下，过期 access token 不该让书库首屏报错。
 *
 * ★ 锁的是用户实测反馈：
 *   「云端书库默认会提示什么错误，只有点击一下"刷新云端"按钮才会正常」
 *   截图里的错误是 `操作失败：invalid or expired token`。
 *
 * 根因：`refreshCloud()` 直接调 `getApi().books.list()`，**不经过**同步引擎的
 * `#withAuthRetry`。令牌刷新只存在于引擎里，于是书库这条路径完全没有兜底。
 *
 * 为什么必须有这一层（api/__tests__/authRetry.spec.ts 已经测了客户端）：
 *   那个用例只证明"客户端**支持**刷新"，证明不了"runtime **真的把回调接上了**"。
 *   漏接回调时客户端测试依然全绿，而线上照样报错 —— 这个断层正是要守的。
 */

/** 一个能识别 token 有效性、并按需轮换 refresh token 的假服务端。 */
function fakeServer(options: { rotateRefresh?: boolean } = {}) {
  const state = {
    /**
     * 服务端当前认可的 access token。
     *
     * ★ 必须与客户端存储里的 `expired-access` **不同**：否则第一个请求就会直接 200，
     *   "401 → 刷新 → 重试"这条路径根本没被走到（第一版就是这么假绿的）。
     */
    validAccess: 'server-access',
    /** 当前有效的 refresh token。 */
    validRefresh: 'refresh-1',
    /** refresh 请求次数（验证单飞：并发 401 只刷一次）。 */
    refreshCalls: 0,
    /** books.list 收到的 Authorization 头，按顺序。 */
    listAuth: [] as string[],
    /** books.list 的总调用次数。 */
    listCalls: 0,
  }

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers ?? {})
    const auth = headers.get('Authorization') ?? ''

    if (url.includes('/v1/auth/refresh')) {
      state.refreshCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { refreshToken?: string }
      if (body.refreshToken !== state.validRefresh) {
        return Promise.resolve(
          json(401, { code: 'invalid_token', message: 'invalid or expired token' }),
        )
      }
      // 轮换：旧 refresh 立刻作废，发新的一对
      if (options.rotateRefresh !== false) state.validRefresh = `refresh-${state.refreshCalls + 1}`
      state.validAccess = `fresh-access-${state.refreshCalls}`
      return Promise.resolve(
        json(200, {
          accessToken: state.validAccess,
          refreshToken: state.validRefresh,
          expiresIn: 3600,
          user: { id: 'u1', email: 'a@b.c' },
        }),
      )
    }

    if (url.includes('/v1/books')) {
      state.listCalls += 1
      state.listAuth.push(auth)
      if (auth !== `Bearer ${state.validAccess}`) {
        return Promise.resolve(
          json(401, { code: 'invalid_token', message: 'invalid or expired token' }),
        )
      }
      return Promise.resolve(json(200, { items: [] }))
    }

    return Promise.resolve(json(404, { code: 'not_found', message: 'nope' }))
  }) as typeof fetch

  return { state, fetchImpl }
}

function storedSession(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: 'expired-access',
    refreshToken: 'refresh-1',
    expiresIn: 3600,
    userId: 'u1',
    email: 'a@b.c',
    // ★ 显式写一个**已过期**的时间：真实场景就是关掉应用几小时后再打开
    expiresAt: Date.now() - 60_000,
    ...over,
  })
}

describe('runtime 装配：过期 token 下书库首屏不该报错', () => {
  it('★ books.list 撞 401 后自动刷新并重试，调用方直接拿到数据', async () => {
    const { state, fetchImpl } = fakeServer()
    const storage = createMemoryStorage({ [SESSION_STORAGE_KEY]: storedSession() })

    const runtime = createSyncRuntime({
      baseUrl: 'http://fake.test',
      storage,
      fetchImpl,
    })

    // 模拟书库的 refreshCloud()：直接调 client，不经过同步引擎
    const page = await runtime.client.request<{ items: unknown[] }>('/v1/books?limit=50')

    expect(page.items).toEqual([])
    expect(state.refreshCalls, '应该恰好刷新一次').toBe(1)
    expect(state.listAuth).toHaveLength(2)
    expect(state.listAuth[0], '第一次用的是过期的 token').toBe('Bearer expired-access')
    expect(state.listAuth[1], '重试必须带上刷新后的 token').toContain('Bearer fresh-access')
  })

  it('★ 并发多个请求撞 401，只刷新一次（refresh token 轮换，重复刷新会吊销会话）', async () => {
    const { state, fetchImpl } = fakeServer()
    const storage = createMemoryStorage({ [SESSION_STORAGE_KEY]: storedSession() })

    const runtime = createSyncRuntime({ baseUrl: 'http://fake.test', storage, fetchImpl })

    const results = await Promise.all([
      runtime.client.request<{ items: unknown[] }>('/v1/books?a=1'),
      runtime.client.request<{ items: unknown[] }>('/v1/books?a=2'),
      runtime.client.request<{ items: unknown[] }>('/v1/books?a=3'),
    ])

    expect(results).toHaveLength(3)
    expect(state.refreshCalls, '三个并发 401 只能触发一次刷新').toBe(1)
  })

  it('refresh token 也已失效时，把 401 如实抛给上层（不假装成功）', async () => {
    const { state, fetchImpl } = fakeServer()
    // 存储里的 refresh token 与服务端认可的不一致 ⇒ 刷新必然失败
    const storage = createMemoryStorage({
      [SESSION_STORAGE_KEY]: storedSession({ refreshToken: 'bogus-refresh' }),
    })

    const runtime = createSyncRuntime({ baseUrl: 'http://fake.test', storage, fetchImpl })

    const err = await runtime.client.request('/v1/books').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    // 刷新确实被尝试过（不是静默放弃）
    expect(state.refreshCalls).toBe(1)
    // 失败原因要能透出来，UI 才能提示"请重新登录"
    expect(String((err as Error).message)).toMatch(/invalid|expired/i)
  })

  it('没有会话时不做无谓刷新，直接走未授权路径', async () => {
    const { state, fetchImpl } = fakeServer()
    const storage = createMemoryStorage() // 空存储 = 未登录

    const runtime = createSyncRuntime({ baseUrl: 'http://fake.test', storage, fetchImpl })

    const err = await runtime.client.request('/v1/books').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(state.refreshCalls, '未登录不该触发刷新').toBe(0)
  })
})
