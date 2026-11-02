import { createAiApi, createApiClient, registerAiTokenGetter, type AiApi } from '../../api'
import { defaultApiBaseUrl } from '../sync/runtime'
import { getSyncRuntime } from '../sync/runtime'

/**
 * AI 能力的运行期单例（task-23）。
 *
 * ★ 刻意**复用 sync 的 AuthSession**，不自己建一套认证：
 *   - 用户登录后 token 存在 sync 的 session 里（`session.v1`）；
 *   - AI 调用与同步调用必须用同一个 token，否则会出现"同步能推、翻译 401"
 *     这种极难排查的状态；
 *   - 而且 `AuthSession` 有单飞刷新逻辑（服务端是轮换 + 重用检测），
 *     复制一份就会把刚拿到的新令牌作废。
 *
 * 但 AI **不**共享 sync 的 client：SSE 需要自己发裸 fetch（要读流），
 * 而 `ApiClient.request` 会把响应体整个读成文本，拿不到增量。
 */

let singleton: AiApi | null = null

export interface AiRuntimeOptions {
  baseUrl?: string
  /** 测试注入：绕过 AuthSession，直接用给定的 token。 */
  getAccessToken?: () => string | null
}

export function createAiRuntime(options: AiRuntimeOptions = {}): AiApi {
  const baseUrl = options.baseUrl ?? defaultApiBaseUrl()

  let token: () => string | null
  if (options.getAccessToken) {
    token = options.getAccessToken
  } else {
    // 复用 sync 的会话：getSyncRuntime() 会按需创建（已有 UI 在用它，不会额外开销）。
    token = () => getSyncRuntime().session.accessToken
  }

  // ★ SSE 走裸 fetch，必须把 token getter 显式注册给 ai.ts。
  registerAiTokenGetter(token)
  const client = createApiClient({ baseUrl, getAccessToken: token })
  return createAiApi(client)
}

export function getAiApi(): AiApi {
  if (singleton === null) singleton = createAiRuntime()
  return singleton
}

/** 测试/嵌入方显式注入（避免每个用例都碰 localStorage / sync 引擎）。 */
export function configureAiApi(api: AiApi | null): void {
  singleton = api
}
