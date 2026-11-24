import { ApiError } from '../../api/client'
import type { AuthTokens } from '../../api/contract'
import { readJson, writeJson, type SyncStorage } from './storage'

export const SESSION_STORAGE_KEY = 'session.v1'

export interface StoredSession {
  accessToken: string
  refreshToken: string
  expiresIn: number
  userId: string | null
  email: string | null
  /**
   * access token 的绝对过期时间（epoch ms）。
   * 老版本持久化数据里没有这个字段 → 运行时从 JWT 的 exp 现算（见 accessTokenExpiresAt）。
   */
  expiresAt?: number | null
}

/** 引擎只依赖这三个方法（便于单测注入假实现）。 */
export interface AuthApiLike {
  register(input: {
    email: string
    password: string
    displayName?: string
    deviceId?: string
    deviceName?: string
    platform?: string
  }): Promise<AuthTokens>
  login(input: {
    email: string
    password: string
    deviceId?: string
    deviceName?: string
    platform?: string
  }): Promise<AuthTokens>
  refresh(refreshToken: string, deviceId?: string): Promise<AuthTokens>
  logout(refreshToken: string, allDevices?: boolean): Promise<void>
}

/** 会话不可恢复的原因（用于 UI 文案：告诉用户"为什么"要重新登录）。 */
export type AuthInvalidationReason =
  /** 服务端明确拒绝了这个 refresh token（含「已被使用 → 整个 family 被吊销」）。 */
  | 'refresh_rejected'
  /** refresh token 本身过期。 */
  | 'refresh_expired'
  /** 本地根本没有 refresh token（从未登录 / 被清过）。 */
  | 'no_refresh_token'

export interface AuthInvalidation {
  reason: AuthInvalidationReason
  /** 服务端原始 message（诊断用；UI 展示更友好的中文）。 */
  message: string
  status: number | null
  code: string | null
}

/**
 * 刷新失败且**不可恢复**时抛出。
 *
 * ★ 为什么要专门一个错误类型：引擎必须能区分「网络抖动（可退避重试）」与
 *   「登录凭据已被服务端吊销（重试一万次也没用，必须让用户重新登录）」。
 *   把两者都当 offline 处理，就会出现真实故障现场：每 30s 打一轮
 *   push 401 → refresh 401，界面永远在「推送中 ↔ 离线」之间跳，用户看不到原因。
 */
export class SessionInvalidatedError extends Error {
  readonly invalidation: AuthInvalidation

  constructor(invalidation: AuthInvalidation) {
    super(invalidation.message)
    this.name = 'SessionInvalidatedError'
    this.invalidation = invalidation
  }

  get reason(): AuthInvalidationReason {
    return this.invalidation.reason
  }
}

// ---------------------------------------------------------------- 会话失效广播

const invalidationListeners = new Set<(invalidation: AuthInvalidation) => void>()

/**
 * 订阅「会话已失效」事件（auth store / 同步引擎 / 协调器用）。
 * 单例订阅点放在模块级，因为 runtime 重建会换掉 AuthSession 实例，
 * 订阅者不应该跟着实例一起丢。
 */
export function onSessionInvalidated(listener: (invalidation: AuthInvalidation) => void): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

function publishInvalidation(invalidation: AuthInvalidation): void {
  for (const listener of [...invalidationListeners]) {
    try {
      listener(invalidation)
    } catch {
      // 订阅者自身出错不能影响会话清理。
    }
  }
}

// ---------------------------------------------------------------- 单飞刷新（跨实例）

/**
 * ★ 必须是**模块级**单飞：runtime 重建（用户改服务器地址）会 new 一个 AuthSession，
 *   而旧实例的刷新请求可能还在飞。两个实例拿同一个 refresh token 各刷一次，
 *   服务端的「重用检测」会直接吊销整个 token family —— 用户从此永久登录失效，
 *   只能重新登录（这就是本次线上故障的形态）。
 *   按 refresh token 值去重，而不是按实例去重，才能真正止住这个竞态。
 */
const inflightRefreshes = new Map<string, Promise<AuthTokens>>()

/** 默认提前量：access token 剩余寿命不足 30s 就视为需要刷新（避免"发出必然 401 的请求"）。 */
export const ACCESS_TOKEN_SKEW_MS = 30_000

/** 从 JWT 的 payload 里读出 exp（秒）。解不出来就返回 null，绝不抛错。 */
function readJwtExpirySeconds(token: string): number | null {
  try {
    if (typeof atob !== 'function') return null
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = parts[1] ?? ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const parsed = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : null
  } catch {
    return null
  }
}

/**
 * 认证会话：令牌持久化 + **刷新轮换** + 单飞（single-flight）刷新。
 *
 * 服务端 /v1/auth/refresh 是「轮换 + 重用检测」：旧 refresh 一旦被再次使用，
 * 整个 token family 会被吊销。因此：
 *   ① 并发请求同时收到 401 时必须**只刷新一次**（模块级单飞，见 inflightRefreshes）；
 *   ② 刷新失败必须区分「可重试」与「不可恢复」——后者清空本地会话并广播失效，
 *      让 UI 明确提示「登录已过期，请重新登录」，而不是无限重试下去。
 */
export class AuthSession {
  #storage: SyncStorage
  #auth: AuthApiLike
  #deviceId: string | null
  #pendingRefresh: Promise<AuthTokens> | null = null

  constructor(storage: SyncStorage, auth: AuthApiLike, deviceId: string | null = null) {
    this.#storage = storage
    this.#auth = auth
    this.#deviceId = deviceId
  }

  static load(storage: SyncStorage, auth: AuthApiLike, deviceId: string | null = null): AuthSession {
    const session = new AuthSession(storage, auth, deviceId)
    const stored = readJson<StoredSession | null>(storage, SESSION_STORAGE_KEY, null)
    if (stored !== null && typeof stored.accessToken === 'string') session.#save(stored)
    return session
  }

  #current: StoredSession | null = null

  get tokens(): StoredSession | null {
    return this.#current
  }

  get accessToken(): string | null {
    return this.#current?.accessToken ?? null
  }

  get refreshToken(): string | null {
    return this.#current?.refreshToken ?? null
  }

  get userId(): string | null {
    return this.#current?.userId ?? null
  }

  get email(): string | null {
    return this.#current?.email ?? null
  }

  /** access token 的绝对过期时间（epoch ms）；未知返回 null。 */
  get accessTokenExpiresAt(): number | null {
    const current = this.#current
    if (current === null) return null
    if (typeof current.expiresAt === 'number' && Number.isFinite(current.expiresAt)) return current.expiresAt
    const exp = readJwtExpirySeconds(current.accessToken)
    return exp === null ? null : exp * 1000
  }

  /**
   * access token 是否已经（即将）过期。
   *
   * 过期时间已知：now + skew >= expiresAt → true。
   * 完全未知：返回 false（宁可多发一次请求，也不要凭空把用户踢下线）。
   */
  isAccessTokenExpired(skewMs = ACCESS_TOKEN_SKEW_MS): boolean {
    const at = this.accessTokenExpiresAt
    if (at === null) return false
    return Date.now() + Math.max(0, skewMs) >= at
  }

  /** 本地是否还有会话（不管能不能用）。 */
  hasSession(): boolean {
    return this.#current !== null
  }

  setDeviceId(deviceId: string): void {
    this.#deviceId = deviceId
  }

  #save(tokens: StoredSession): StoredSession {
    this.#current = tokens
    writeJson(this.#storage, SESSION_STORAGE_KEY, tokens)
    return tokens
  }

  adopt(tokens: AuthTokens): StoredSession {
    const exp = readJwtExpirySeconds(tokens.accessToken)
    return this.#save({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      userId: tokens.user?.id ?? null,
      email: tokens.user?.email ?? null,
      expiresAt: exp !== null ? exp * 1000 : Date.now() + Math.max(0, tokens.expiresIn) * 1000,
    })
  }

  /**
   * 用持久化存储里的会话刷新内存副本。
   *
   * 用途：另一个实例（例如 runtime 重建前后的两个 AuthSession）刚刚完成轮换，
   * 本实例手里的 refresh token 已经作废 —— 必须先跟上最新值，否则一次「用旧 token 刷新」
   * 就会触发服务端的重用检测。
   */
  #followStorage(): void {
    const stored = readJson<StoredSession | null>(this.#storage, SESSION_STORAGE_KEY, null)
    if (stored === null) {
      this.#current = null
      return
    }
    if (typeof stored.accessToken !== 'string') return
    this.#current = { ...stored }
  }

  async register(input: {
    email: string
    password: string
    displayName?: string
    deviceName?: string
    platform?: string
  }): Promise<AuthTokens> {
    const tokens = await this.#auth.register({ ...input, ...(this.#deviceId ? { deviceId: this.#deviceId } : {}) })
    this.adopt(tokens)
    return tokens
  }

  async login(input: { email: string; password: string; deviceName?: string; platform?: string }): Promise<AuthTokens> {
    const tokens = await this.#auth.login({ ...input, ...(this.#deviceId ? { deviceId: this.#deviceId } : {}) })
    this.adopt(tokens)
    return tokens
  }

  /** 单飞刷新：并发调用（含跨实例）共享同一个 in-flight 请求。 */
  async refresh(): Promise<AuthTokens> {
    if (this.#pendingRefresh !== null) return this.#pendingRefresh
    // 先跟上别的实例可能已经写入的轮换结果。
    this.#followStorage()

    const refreshToken = this.refreshToken
    if (refreshToken === null) {
      const failure: AuthInvalidation = {
        reason: 'no_refresh_token',
        message: '本地没有可用的刷新令牌',
        status: null,
        code: null,
      }
      this.clear()
      publishInvalidation(failure)
      throw new SessionInvalidatedError(failure)
    }

    const existing = inflightRefreshes.get(refreshToken)
    if (existing !== undefined) {
      // 有别的实例正在刷同一个 token：复用它的结果，并把结果落到本实例。
      const task = existing.then((tokens) => {
        this.adopt(tokens)
        return tokens
      })
      this.#pendingRefresh = task
      try {
        return await task
      } finally {
        this.#pendingRefresh = null
      }
    }

    const task = this.#auth
      .refresh(refreshToken, this.#deviceId ?? undefined)
      .then((tokens) => {
        this.adopt(tokens)
        return tokens
      })
      .catch((err: unknown) => {
        const invalidation = classifyRefreshFailure(err)
        if (invalidation !== null) {
          this.clear()
          publishInvalidation(invalidation)
          throw new SessionInvalidatedError(invalidation)
        }
        // 网络 / 5xx / 超时：会话本身可能仍然有效，**绝不能**清掉。
        throw err
      })
      .finally(() => {
        inflightRefreshes.delete(refreshToken)
        this.#pendingRefresh = null
      })
    inflightRefreshes.set(refreshToken, task)
    this.#pendingRefresh = task
    return task
  }

  async logout(allDevices = false): Promise<void> {
    const refreshToken = this.refreshToken
    if (refreshToken !== null) {
      try {
        await this.#auth.logout(refreshToken, allDevices)
      } catch {
        // 服务端不可达也要清掉本地会话，否则用户会卡在「退不出去」的状态。
      }
    }
    this.clear()
  }

  clear(): void {
    this.#current = null
    this.#storage.remove(SESSION_STORAGE_KEY)
  }
}

/**
 * 把刷新失败分成「不可恢复」与「可重试」两类。
 *
 * 不可恢复 = 服务端明确说这枚 refresh token 不行（4xx），或者本地压根没有 token。
 * 可重试 = 网络错误、超时、5xx、429 —— 这些时候会话多半还有效，清掉等于误伤。
 */
export function classifyRefreshFailure(err: unknown): AuthInvalidation | null {
  if (!(err instanceof ApiError)) return null
  if (err.status >= 500 || err.status === 429) return null
  if (err.status === 0) return null
  if (err.status !== 400 && err.status !== 401 && err.status !== 403) return null
  const message = err.message || 'refresh token rejected'
  const lower = message.toLowerCase()
  const reason: AuthInvalidationReason =
    lower.includes('expired') ? 'refresh_expired' : 'refresh_rejected'
  return { reason, message, status: err.status, code: err.code || null }
}
