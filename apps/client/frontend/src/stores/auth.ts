import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { getSyncRuntime, onSyncRuntimeReplaced } from '@/features/sync/runtime'
import { notifyAuthChanged } from '@/features/sync/coordinator'
import { getApi } from '@/api'
import type { DeviceDto, UserDto } from '@/api/contract'
import type { AuthSession } from '@/features/sync/session'
import { onSessionInvalidated } from '@/features/sync/session'

export const useAuthStore = defineStore('auth', () => {
  /**
   * ★ 会话必须**惰性获取**：用户改服务器地址会重建整条同步链路（含新的 AuthSession），
   *   把 session 存成 Store 级常量会让登录态永远停留在旧服务器上。
   *   sessionVersion 是「runtime 已重建」的响应式信号，让下面的 computed 重新求值。
   */
  const sessionVersion = ref(0)
  const token = ref<string | null>(null)
  const user = ref<UserDto | null>(null)
  const devices = ref<DeviceDto[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /**
   * 登录态是否**因为凭据失效**而被清掉（区别于「从未登录/主动登出」）。
   *
   * ★ 这个标志存在的唯一理由：让界面能说人话。
   *   服务端吊销了 refresh token 时，用户看到的必须是「登录已过期，请重新登录」，
   *   而不是莫名其妙的「同步失败/离线」——后者会让人以为是自己网络的问题。
   */
  const sessionExpired = ref(false)

  function currentSession(): AuthSession {
    // 读一下 sessionVersion：runtime 重建时该值 +1，订阅它的 computed 会重算。
    void sessionVersion.value
    return getSyncRuntime().session
  }

  /**
   * 有效令牌：内存里的展示态优先，其次回落到持久化会话。
   *
   * ★ 会话一旦被判定失效就必须返回 null：runtime 重建会在同一份 storage 上
   *   产生新的 AuthSession，旧实例的刷新请求晚一步失败时，**新实例手里还是吊销前的
   *   token**——现场就是「storage 已清空 + isAuthenticated 仍为 true」，
   *   界面于是既不给「重新登录」按钮、也不禁用「立即同步」。
   */
  function accessToken(): string | null {
    if (sessionExpired.value) return null
    return token.value ?? currentSession().accessToken
  }

  const isAuthenticated = computed(() => accessToken() !== null)
  const email = computed(() => user.value?.email ?? currentSession().email)
  const userId = computed(() => user.value?.id ?? currentSession().userId)

  /** runtime 重建后重新同步 token / 用户展示（服务器地址变更时由运行时的替换事件触发）。 */
  function syncFromSession(): void {
    const session = currentSession()
    token.value = session.accessToken
    if (session.accessToken === null) {
      user.value = null
      devices.value = []
    } else {
      // 新 runtime 上有可用会话（例如切回另一台服务器）→ 之前的失效结论作废。
      sessionExpired.value = false
    }
  }

  const offRuntimeReplaced = onSyncRuntimeReplaced(() => {
    sessionVersion.value += 1
    syncFromSession()
  })
  onScopeDispose(offRuntimeReplaced)

  /**
   * 会话被服务端吊销 / refresh token 过期：AuthSession 已经把自己清空了，
   * 这里只负责把「展示态 + 后续行为」一起收敛：
   *   ① 清 token / user / devices → UI 立刻显示未登录并给出「重新登录」；
   *   ② notifyAuthChanged() → 协调器停掉周期同步，不再每 30s 打一轮必然 401 的请求。
   */
  const offInvalidated = onSessionInvalidated(() => {
    sessionExpired.value = true
    token.value = null
    user.value = null
    devices.value = []
    notifyAuthChanged()
  })
  onScopeDispose(offInvalidated)

  async function login(emailVal: string, passwordVal: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await currentSession().login({
        email: emailVal,
        password: passwordVal,
        platform: 'desktop',
      })
      token.value = res.accessToken
      if (res.user) {
        user.value = res.user
      }
      sessionExpired.value = false
      await refreshProfile()
      // 通知同步协调器：登录成功 → bootstrap + 自动同步。
      notifyAuthChanged()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      loading.value = false
    }
  }

  async function logout(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      await currentSession().logout(false)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      // 无论服务端是否可达，本地展示态都要清干净。
      token.value = null
      user.value = null
      devices.value = []
      loading.value = false
      // 主动登出不是「过期」，别让界面提示"登录已过期，请重新登录"。
      sessionExpired.value = false
      // 通知同步协调器：登出 → stopAutoSync()，此后不再发起同步请求。
      notifyAuthChanged()
    }
  }

  async function refreshProfile(): Promise<void> {
    if (accessToken() === null) return
    const api = getApi()
    try {
      const me = await api.auth.me()
      user.value = me
      const devs = await api.auth.devices()
      devices.value = devs
    } catch {
      // 忽略离线或未鉴权
    }
  }

  return {
    isAuthenticated,
    email,
    userId,
    /** 当前令牌（可写）：UI / 测试可直接注入或清空登录态。 */
    token,
    user,
    devices,
    loading,
    error,
    /** 登录态是否因凭据失效被清掉（用于「登录已过期，请重新登录」文案）。 */
    sessionExpired,
    login,
    logout,
    refreshProfile,
    syncFromSession,
  }
})
