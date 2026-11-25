import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '../../../api/client'
import type { Locator } from '../../../api/contract'
import { SyncEngine, LAST_SUCCESS_STORAGE_KEY, type SyncEngineHooks } from '../engine'
import { AuthSession, SessionInvalidatedError } from '../session'
import { createMemoryStorage, type SyncStorage } from '../storage'

/**
 * 回归背景（线上真实故障）：
 *   135 条待推送的进度变更，点「立即同步」只在「推送中 ↔ 离线」之间反复横跳，
 *   上次同步永远是「从未同步」。根因是服务端把 refresh token 家族整个吊销了
 *   （401 reuse detected），而客户端把「凭据失效」当成普通网络故障处理：
 *   无限退避重试 + 把相位写成 offline + 清不掉会话 + 不告诉用户要重新登录。
 *
 * 这些用例锁死修复后的三条不变量：
 *   ① 凭据失效 ⇒ phase='auth' + lastError.code='auth_expired' + **不再重试**；
 *   ② 网络故障 ⇒ phase='offline' + 仍会退避重试（不能把可恢复错误当致命错误）；
 *   ③ 上次同步成功时间要跨重启保留（否则永远是「从未同步」）。
 */

const LOCATOR: Locator = { href: '/ch1', type: 'application/xhtml+xml', title: 'Ch 1' }

function makeClient(handler: (path: string) => unknown): { client: ApiClient; calls: string[] } {
  const calls: string[] = []
  const client = {
    baseUrl: 'http://127.0.0.1:1',
    request: <T,>(path: string): Promise<T> => {
      calls.push(path)
      return Promise.resolve(handler(path) as T)
    },
    requestVoid: () => Promise.resolve(),
  } as unknown as ApiClient
  return { client, calls }
}

function fakeSession(overrides: Partial<SyncEngineHooks['session']> = {}): SyncEngineHooks['session'] {
  return {
    refresh: vi.fn().mockRejectedValue(
      new SessionInvalidatedError({
        reason: 'refresh_rejected',
        message: 'refresh token already used; session revoked',
        status: 401,
        code: 'unauthorized',
      }),
    ),
    isAccessTokenExpired: () => false,
    hasSession: () => true,
    ...overrides,
  } as SyncEngineHooks['session']
}

function newEngine(
  storage: SyncStorage,
  client: ApiClient,
  session?: SyncEngineHooks['session'],
  now = () => 1_700_000_000_000,
): SyncEngine {
  return new SyncEngine(
    { baseUrl: 'http://127.0.0.1:1', deviceId: '7b1c1f1e-0000-7000-8000-000000000001', baseBackoffMs: 10, maxBackoffMs: 10 },
    { client, storage, now, isOnline: () => true },
    { session },
  )
}

describe('SyncEngine：失败分类与相位', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('401 且 refresh 被服务端吊销 ⇒ phase=auth，且不再无限重试', async () => {
    const storage = createMemoryStorage()
    const { client, calls } = makeClient(() => {
      throw new ApiError(401, 'unauthorized', 'invalid or expired token')
    })
    const engine = newEngine(storage, client, fakeSession())
    engine.enqueueProgress({ bookId: 'book-1', locator: LOCATOR, totalProgression: 0.1 })

    const result = await engine.run()
    const status = engine.getStatus()

    expect(status.phase).toBe('auth')
    expect(status.lastError?.code).toBe('auth_expired')
    // 服务端原文要透出给用户（本地化文案在 UI 层，引擎不自带 i18n）。
    expect(status.lastError?.message).toContain('refresh token already used')
    expect(result.errors[0]).toContain('auth_expired')

    // ★ 关键：不能挂退避定时器。否则每 30s 又打一轮必然 401 的请求，
    //   界面就会在「推送中 ↔ 离线」之间反复横跳（线上现象）。
    const afterFirst = calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.length).toBe(afterFirst)
    expect(engine.getStatus().phase).toBe('auth')
    // 未确认的 op 不得被丢弃。
    expect(engine.outbox.size).toBe(1)
  })

  it('access token 已过期 ⇒ 先刷新，不浪费一次必然 401 的请求', async () => {
    const storage = createMemoryStorage()
    const { client, calls } = makeClient((path) => {
      if (path.startsWith('/v1/sync/push')) return { results: [], cursor: 1 }
      return { changes: [], nextCursor: 1, hasMore: false }
    })
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'fresh', refreshToken: 'r2' })
    const engine = newEngine(storage, client, fakeSession({ refresh, isAccessTokenExpired: () => true }))
    engine.enqueueProgress({ bookId: 'book-1', locator: LOCATOR, totalProgression: 0.1 })

    await engine.run()

    expect(refresh).toHaveBeenCalled()
    // 刷新在**发请求之前**发生：第一个请求就是带新 token 的业务请求。
    expect(calls[0]).toContain('/v1/sync/push')
    expect(engine.getStatus().phase).toBe('idle')
  })

  it('网络故障（status 0）⇒ phase=offline，并且仍然会退避重试', async () => {
    const storage = createMemoryStorage()
    const { client, calls } = makeClient(() => {
      throw new ApiError(0, 'network_error', 'Failed to fetch')
    })
    const engine = newEngine(storage, client, fakeSession({ hasSession: () => true }))
    engine.enqueueProgress({ bookId: 'book-1', locator: LOCATOR, totalProgression: 0.1 })

    await engine.run()
    expect(engine.getStatus().phase).toBe('offline')
    expect(engine.getStatus().lastError?.code).toBe('offline')
    expect(engine.outbox.size).toBe(1)

    const first = calls.length
    await vi.advanceTimersByTimeAsync(50)
    // 可恢复错误必须继续重试（否则一断网就再也不同步了）。
    expect(calls.length).toBeGreaterThan(first)
    engine.stopAutoSync()
  })

  it('4xx 协议错误（非鉴权）⇒ phase=error，且不重试', async () => {
    const storage = createMemoryStorage()
    const { client, calls } = makeClient(() => {
      throw new ApiError(400, 'invalid_batch', 'op.hlc malformed')
    })
    const engine = newEngine(storage, client, fakeSession({ hasSession: () => true }))
    engine.enqueueProgress({ bookId: 'book-1', locator: LOCATOR, totalProgression: 0.1 })

    await engine.run()
    expect(engine.getStatus().phase).toBe('error')
    expect(engine.getStatus().lastError?.message).toContain('malformed')

    const first = calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.length).toBe(first)
  })
})

describe('SyncEngine：启动引导（bootstrap）失败也要落状态', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bootstrap 拿到 401 且 refresh 被吊销 ⇒ phase=auth（而不是复位成 idle）', async () => {
    const storage = createMemoryStorage()
    const { client } = makeClient(() => {
      throw new ApiError(401, 'unauthorized', 'invalid or expired token')
    })
    const engine = newEngine(storage, client, fakeSession())

    await expect(engine.bootstrap()).rejects.toBeInstanceOf(SessionInvalidatedError)

    // ★ 现场：协调器的 activate() 会把异常吞掉并复位相位，
    //   如果 bootstrap 自己不落状态，用户看到的就是「空闲 + 从未同步」。
    const status = engine.getStatus()
    expect(status.phase).toBe('auth')
    expect(status.lastError?.code).toBe('auth_expired')
    engine.dispose()
  })

  it('会话在同步之外失效（模块级广播）⇒ 相位立刻收敛到 auth', async () => {
    const storage = createMemoryStorage()
    const { client } = makeClient(() => ({ changes: [], nextCursor: 1, hasMore: false }))
    const authApi = {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      refresh: vi
        .fn()
        .mockRejectedValue(new ApiError(401, 'unauthorized', 'refresh token already used; session revoked')),
    }
    const session = AuthSession.load(
      storage,
      authApi as unknown as Parameters<typeof AuthSession.load>[1],
      'dev-1',
    )
    // 真实 AuthSession：refresh 失败会广播失效，引擎应据此收敛相位。
    session.adopt({
      accessToken: 'a.b.c',
      refreshToken: 'refresh-1',
      expiresIn: 900,
      user: { id: 'u1', email: 'e@example.com' } as never,
    })
    const engine = newEngine(storage, client, session)
    expect(engine.getStatus().phase).toBe('idle')

    await expect(session.refresh()).rejects.toBeInstanceOf(SessionInvalidatedError)

    expect(engine.getStatus().phase).toBe('auth')
    expect(engine.getStatus().lastError?.code).toBe('auth_expired')
    engine.dispose()
  })
})

describe('SyncEngine：上次同步时间持久化', () => {
  it('同步成功后写入 lastok.v1，并在新实例里恢复（不再永远显示「从未同步」）', async () => {
    const storage = createMemoryStorage()
    const { client } = makeClient((path) => (path.startsWith('/v1/sync/pull') ? { changes: [], nextCursor: 7, hasMore: false } : { results: [], cursor: 7 }))
    const at = 1_700_000_123_456
    const engine = newEngine(storage, client, fakeSession(), () => at)

    await engine.run()
    expect(engine.getStatus().lastSyncedAt).toBe(at)
    expect(JSON.parse(storage.get(LAST_SUCCESS_STORAGE_KEY) ?? 'null')).toBe(at)

    // 模拟重启：同一个 storage，新引擎实例。
    const revived = newEngine(storage, client, fakeSession(), () => at + 1000)
    expect(revived.getStatus().lastSyncedAt).toBe(at)
  })

  it('失败不会污染上次同步时间', async () => {
    const storage = createMemoryStorage({ [LAST_SUCCESS_STORAGE_KEY]: JSON.stringify(1_600_000_000_000) })
    const { client } = makeClient(() => {
      throw new ApiError(0, 'network_error', 'Failed to fetch')
    })
    const engine = newEngine(storage, client, fakeSession({ hasSession: () => true }))
    engine.enqueueProgress({ bookId: 'book-1', locator: LOCATOR, totalProgression: 0.1 })

    await engine.run()
    expect(engine.getStatus().lastSyncedAt).toBe(1_600_000_000_000)
    engine.stopAutoSync()
  })
})
