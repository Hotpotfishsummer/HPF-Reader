import type { AuthTokens } from '../../api/contract'
import { readJson, writeJson, type SyncStorage } from './storage'

export const SESSION_STORAGE_KEY = 'session.v1'

export interface StoredSession {
  accessToken: string
  refreshToken: string
  expiresIn: number
  userId: string | null
  email: string | null
}

/** 引擎只依赖这三个方法（便于单测注入假实现）。 */
export interface AuthApiLike {
  // ★ 没有 register：本产品不提供公开注册，账号由运维在服务器上创建。
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

/**
 * 认证会话：令牌持久化 + **刷新轮换** + 单飞（single-flight）刷新。
 *
 * 服务端 /v1/auth/refresh 是「轮换 + 重用检测」：旧 refresh 一旦被再次使用，
 * 整个 token family 会被吊销。因此并发请求同时收到 401 时必须**只刷新一次**，
 * 否则第二个刷新请求会把刚拿到的新令牌一起作废 —— 这是最容易踩的坑。
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

  setDeviceId(deviceId: string): void {
    this.#deviceId = deviceId
  }

  #save(tokens: StoredSession): StoredSession {
    this.#current = tokens
    writeJson(this.#storage, SESSION_STORAGE_KEY, tokens)
    return tokens
  }

  adopt(tokens: AuthTokens): StoredSession {
    return this.#save({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      userId: tokens.user?.id ?? null,
      email: tokens.user?.email ?? null,
    })
  }

  async login(input: { email: string; password: string; deviceName?: string; platform?: string }): Promise<AuthTokens> {
    const tokens = await this.#auth.login({ ...input, ...(this.#deviceId ? { deviceId: this.#deviceId } : {}) })
    this.adopt(tokens)
    return tokens
  }

  /** 单飞刷新：并发调用共享同一个 in-flight 请求。 */
  async refresh(): Promise<AuthTokens> {
    if (this.#pendingRefresh !== null) return this.#pendingRefresh
    const refreshToken = this.refreshToken
    if (refreshToken === null) throw new Error('no refresh token available')
    const task = this.#auth
      .refresh(refreshToken, this.#deviceId ?? undefined)
      .then((tokens) => {
        this.adopt(tokens)
        return tokens
      })
      .finally(() => {
        this.#pendingRefresh = null
      })
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
