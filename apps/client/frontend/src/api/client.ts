import type { paths } from './schema'

/**
 * 由 api/openapi.yaml 生成的类型化 HTTP 客户端（极薄封装）。
 *
 * schema.d.ts 是 `npm run api:types`（openapi-typescript）的产物，**不要手改**。
 * 本文件只提供一个 fetch 包装；真正的平台差异在 src/platform/ 里处理。
 * Web/server 平台实现应当依赖这里的路径类型，而不是自己拼字符串。
 */

export type ApiPaths = paths

export interface ApiClientOptions {
  baseUrl: string
  getAccessToken?: () => string | null
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '')

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    const token = options.getAccessToken?.() ?? null
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const res = await fetch(`${base}${path}`, { ...init, headers })
    if (!res.ok) {
      let code = 'http_error'
      let message = `${res.status} ${res.statusText}`
      try {
        const body = (await res.json()) as { code?: string; message?: string }
        code = body.code ?? code
        message = body.message ?? message
      } catch {
        // 非 JSON 错误体，保留 HTTP 状态描述
      }
      throw new ApiError(res.status, code, message)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return { request }
}
