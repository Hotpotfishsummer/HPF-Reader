import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { getSyncRuntime, onSyncRuntimeReplaced } from '@/features/sync/runtime'
import { notifyAuthChanged } from '@/features/sync/coordinator'
import { getApi } from '@/api'
import type { DeviceDto, UserDto } from '@/api/contract'
import type { AuthSession } from '@/features/sync/session'

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

  function currentSession(): AuthSession {
    // 读一下 sessionVersion：runtime 重建时该值 +1，订阅它的 computed 会重算。
    void sessionVersion.value
    return getSyncRuntime().session
  }

  /** 有效令牌：内存里的展示态优先，其次回落到持久化会话。 */
  function accessToken(): string | null {
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
    }
  }

  const offRuntimeReplaced = onSyncRuntimeReplaced(() => {
    sessionVersion.value += 1
    syncFromSession()
  })
  onScopeDispose(offRuntimeReplaced)

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
    login,
    logout,
    refreshProfile,
    syncFromSession,
  }
})
