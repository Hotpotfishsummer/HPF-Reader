import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client'
import type { AuthTokens } from '../../../api/contract'
import {
  ACCESS_TOKEN_SKEW_MS,
  AuthSession,
  classifyRefreshFailure,
  onSessionInvalidated,
  SESSION_STORAGE_KEY,
  SessionInvalidatedError,
  type AuthApiLike,
} from '../session'
import { createMemoryStorage, readJson, type SyncStorage } from '../storage'

/**
 * 这里锁死的是「刷新链路不给用户添乱」的四条不变量：
 *   ① 服务端明确吊销 ⇒ 清会话 + 广播失效 + 抛 SessionInvalidatedError（不再无限重试）；
 *   ② 网络/5xx ⇒ **不清会话**（否则一次断网就把用户踢下线）；
 *   ③ 跨实例（runtime 重建）并发刷新必须只发一次 —— 服务端有重用检测，
 *      重复用同一个 refresh token 会把整个 token family 吊销（本次线上故障形态）；
 *   ④ 提前知道 token 快过期就直接刷新，不发必然 401 的请求。
 */

function makeJwt(expSeconds: number): string {
  const enc = (obj: unknown): string =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'u1', exp: expSeconds })}.sig`
}

function tokens(overrides: Partial<AuthTokens> = {}): AuthTokens {
  return {
    accessToken: makeJwt(Math.floor(Date.now() / 1000) + 900),
    refreshToken: 'refresh-1',
    expiresIn: 900,
    user: { id: 'u1', email: 'a@b.c' },
    ...overrides,
  }
}

function seed(storage: SyncStorage, value: Record<string, unknown>): void {
  storage.set(SESSION_STORAGE_KEY, JSON.stringify(value))
}

function fakeAuth(overrides: Partial<AuthApiLike> = {}): AuthApiLike {
  return {
    register: vi.fn(),
    login: vi.fn(),
    refresh: vi.fn().mockResolvedValue(tokens({ refreshToken: 'refresh-2' })),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as AuthApiLike
}

describe('AuthSession：刷新失败分类', () => {
  it('服务端吊销（401 refresh token already used）⇒ 清会话并广播失效', async () => {
    const storage = createMemoryStorage()
    const auth = fakeAuth({
      refresh: vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized', 'refresh token already used; session revoked')),
    })
    const session = AuthSession.load(storage, auth)
    session.adopt(tokens())

    const events: string[] = []
    const off = onSessionInvalidated((inv) => events.push(inv.reason))
    try {
      await expect(session.refresh()).rejects.toBeInstanceOf(SessionInvalidatedError)
    } finally {
      off()
    }

    expect(session.accessToken).toBeNull()
    expect(storage.get(SESSION_STORAGE_KEY)).toBeNull()
    expect(events).toEqual(['refresh_rejected'])
  })

  it('refresh token 过期（401 expired）⇒ reason=refresh_expired', async () => {
    const storage = createMemoryStorage()
    const auth = fakeAuth({
      refresh: vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized', 'refresh token expired')),
    })
    const session = AuthSession.load(storage, auth)
    session.adopt(tokens())

    const err = await session.refresh().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionInvalidatedError)
    expect((err as SessionInvalidatedError).reason).toBe('refresh_expired')
  })

  it('网络故障（status 0）⇒ 保留会话，只把错误抛给调用方', async () => {
    const storage = createMemoryStorage()
    const auth = fakeAuth({ refresh: vi.fn().mockRejectedValue(new ApiError(0, 'network_error', 'Failed to fetch')) })
    const session = AuthSession.load(storage, auth)
    session.adopt(tokens())

    await expect(session.refresh()).rejects.toBeInstanceOf(ApiError)
    // ★ 一次断网绝不能把用户踢下线。
    expect(session.accessToken).not.toBeNull()
    expect(storage.get(SESSION_STORAGE_KEY)).not.toBeNull()
  })

  it('5xx / 429 也算可重试，不清会话', () => {
    expect(classifyRefreshFailure(new ApiError(503, 'unavailable', 'boom'))).toBeNull()
    expect(classifyRefreshFailure(new ApiError(429, 'rate_limited', 'slow down'))).toBeNull()
    expect(classifyRefreshFailure(new ApiError(400, 'invalid_request', 'Invalid refresh token'))).not.toBeNull()
    expect(classifyRefreshFailure(new Error('non-api'))).toBeNull()
  })
})

describe('AuthSession：单飞与轮换跟随', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('两个实例（runtime 重建前后）同时刷新 ⇒ 只发一次请求', async () => {
    const storage = createMemoryStorage()
    const pending: { release: ((v: AuthTokens) => void) | null } = { release: null }
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise<AuthTokens>((resolve) => {
          pending.release = resolve
        }),
    )
    const auth = fakeAuth({ refresh })
    const first = AuthSession.load(storage, auth)
    first.adopt(tokens())
    // 第二个实例从同一份 storage 恢复（模拟 runtime 重建后的新 AuthSession）。
    const second = AuthSession.load(storage, auth)

    const p1 = first.refresh()
    const p2 = second.refresh()
    expect(refresh).toHaveBeenCalledTimes(1)
    pending.release?.(tokens({ refreshToken: 'refresh-2' }))
    await Promise.all([p1, p2])

    // 两个实例都要跟上轮换后的 token，否则下次刷新会用旧 token 触发重用检测。
    expect(first.refreshToken).toBe('refresh-2')
    expect(second.refreshToken).toBe('refresh-2')
  })

  it('内存里的 token 已过期时，先跟 storage 对齐再刷新（不用旧 token 打重用检测）', async () => {
    const storage = createMemoryStorage()
    const refresh = vi.fn().mockResolvedValue(tokens({ refreshToken: 'refresh-3' }))
    const auth = fakeAuth({ refresh })
    const stale = AuthSession.load(storage, auth)
    stale.adopt(tokens({ refreshToken: 'refresh-old' }))
    // 另一个实例（另一窗口/重建后）已完成一次轮换。
    seed(storage, { ...tokens({ refreshToken: 'refresh-new' }), expiresAt: null })

    await stale.refresh()
    expect(refresh).toHaveBeenCalledWith('refresh-new', undefined)
  })

  it('没有 refresh token ⇒ no_refresh_token，且不打扰服务端', async () => {
    const storage = createMemoryStorage()
    const auth = fakeAuth()
    const session = AuthSession.load(storage, auth)
    const err = await session.refresh().catch((e: unknown) => e)
    expect(refreshSpy(auth)).not.toHaveBeenCalled()
    expect((err as SessionInvalidatedError).reason).toBe('no_refresh_token')
  })
})

function refreshSpy(auth: AuthApiLike): ReturnType<typeof vi.fn> {
  return auth.refresh as unknown as ReturnType<typeof vi.fn>
}

describe('AuthSession：过期判定', () => {
  it('JWT 的 exp 已过期 ⇒ isAccessTokenExpired()=true', () => {
    const storage = createMemoryStorage()
    const session = AuthSession.load(storage, fakeAuth())
    session.adopt(tokens({ accessToken: makeJwt(Math.floor(Date.now() / 1000) - 60), expiresIn: 1 }))
    expect(session.isAccessTokenExpired()).toBe(true)
  })

  it('exp 在未来 ⇒ false；剩余寿命小于 skew 也算需要刷新', () => {
    const storage = createMemoryStorage()
    const session = AuthSession.load(storage, fakeAuth())
    const nowSec = Math.floor(Date.now() / 1000)
    session.adopt(tokens({ accessToken: makeJwt(nowSec + 600), expiresIn: 600 }))
    expect(session.isAccessTokenExpired()).toBe(false)
    expect(session.isAccessTokenExpired(600_000 + ACCESS_TOKEN_SKEW_MS)).toBe(true)
  })

  it('完全没有会话 ⇒ false（不是"过期"，别让用户被提示重新登录）', () => {
    const session = AuthSession.load(createMemoryStorage(), fakeAuth())
    expect(session.isAccessTokenExpired()).toBe(false)
    expect(session.accessTokenExpiresAt).toBeNull()
  })

  it('持久化里缺 expiresAt（老版本数据）时从 JWT exp 现算', () => {
    const storage = createMemoryStorage()
    const exp = Math.floor(Date.now() / 1000) + 500
    seed(storage, {
      accessToken: makeJwt(exp),
      refreshToken: 'r',
      expiresIn: 900,
      userId: 'u1',
      email: 'a@b.c',
    })
    const session = AuthSession.load(storage, fakeAuth())
    expect(session.accessTokenExpiresAt).toBe(exp * 1000)
    expect(readJson<{ expiresAt?: number }>(storage, SESSION_STORAGE_KEY, {})?.expiresAt).toBeUndefined()
  })
})
