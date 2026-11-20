import { TestHarness, deviceIdFor } from './runner'
import { createApiClient } from '../../apps/client/frontend/src/api/client'
import { createAuthApi } from '../../apps/client/frontend/src/api/endpoints'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'

export async function runAuthSuite(
  harness: TestHarness,
  runId: string,
  password = 'IntegrationTest2026!Password',
): Promise<{
  userEmail: string
  deviceA: ReturnType<typeof createSyncRuntime>
  deviceB: ReturnType<typeof createSyncRuntime>
}> {
  const SUITE = 'Auth & Multi-Device'
  console.log(`\n=== [Suite 2] 认证鉴权、令牌生命周期与多设备会话验证 ===`)

  const userEmail = `auth-user-${runId}@example.com`
  const deviceIdA = deviceIdFor('dev-A', runId)
  const deviceIdB = deviceIdFor('dev-B', runId)

  // 1. 设备 A 注册
  const deviceA = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdA,
    deviceName: 'Desktop-Windows-A',
    platform: 'windows',
  })

  const tokensA = await harness.runStep(
    SUITE,
    'AU-01',
    '新用户注册：返回 AccessToken、RefreshToken 及用户资料',
    () =>
      deviceA.session.register({
        email: userEmail,
        password,
        displayName: 'Integration Tester',
        deviceName: 'Desktop-Windows-A',
        platform: 'windows',
      }),
    (res) => ({
      ok:
        res.accessToken.length > 20 &&
        res.refreshToken.length > 10 &&
        res.user?.email === userEmail,
      detail: `user.id: ${res.user?.id}, expiresIn: ${res.expiresIn}`,
    }),
  )

  // 2. 邮箱重复冲突检测
  const dupErr = await harness.expectApiError(
    '重复邮箱注册',
    () =>
      createAuthApi(createApiClient({ baseUrl: harness.baseUrl })).register({
        email: userEmail,
        password: 'AnotherPassword123!',
      }),
    409,
  )
  harness.check(SUITE, 'AU-02', '重复注册同一邮箱返回 409 conflict', dupErr.ok, dupErr.detail)

  // 3. 错误口令登录拦截
  const badLoginErr = await harness.expectApiError(
    '错误口令登录',
    () =>
      createAuthApi(createApiClient({ baseUrl: harness.baseUrl })).login({
        email: userEmail,
        password: 'WrongPassword!',
      }),
    401,
  )
  harness.check(SUITE, 'AU-03', '错误密码登录返回 401 unauthorized', badLoginErr.ok, badLoginErr.detail)

  // 4. GET /v1/me 验证 Bearer Token
  const me = await harness.runStep(
    SUITE,
    'AU-04',
    '携带有效 Bearer Token 获取个人资料 (GET /v1/me)',
    () => deviceA.client.request<{ id: string; email: string; displayName: string }>('/v1/me'),
    (res) => ({
      ok: res.email === userEmail && res.displayName === 'Integration Tester',
      detail: `me: ${res.email}`,
    }),
  )

  // 5. 设备 B 登录同一账号（独立设备会话）
  const deviceB = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdB,
    deviceName: 'Mobile-Android-B',
    platform: 'android',
  })

  const tokensB = await harness.runStep(
    SUITE,
    'AU-05',
    '设备 B 登录同一账号获取独立令牌对',
    () =>
      deviceB.session.login({
        email: userEmail,
        password,
        deviceName: 'Mobile-Android-B',
        platform: 'android',
      }),
    (res) => ({
      ok: res.accessToken !== tokensA.accessToken && res.refreshToken !== tokensA.refreshToken,
      detail: `Device B got distinct access & refresh token`,
    }),
  )

  // 6. 设备列表包含 A 与 B
  const devices = await harness.runStep(
    SUITE,
    'AU-06',
    '服务端登记设备清单包含设备 A 与设备 B',
    () => createAuthApi(deviceA.client).devices(),
    (list) => {
      const hasA = list.some((d) => d.id === deviceIdA && d.name === 'Desktop-Windows-A')
      const hasB = list.some((d) => d.id === deviceIdB && d.name === 'Mobile-Android-B')
      return { ok: hasA && hasB, detail: `Device count: ${list.length}` }
    },
  )

  // 7. 令牌轮换与重用检测（独立专用账号）
  const testRotEmail = `rot-${runId}@example.com`
  const rotRuntime = createSyncRuntime({
    baseUrl: harness.baseUrl,
    storage: createMemoryStorage(),
    deviceId: deviceIdFor('rot', runId),
  })
  await rotRuntime.session.register({ email: testRotEmail, password, deviceName: 'Rot-Tester' })
  const oldRefresh = rotRuntime.session.refreshToken ?? ''

  // 正常轮换：拿到新 RefreshToken
  const rotated = await harness.runStep(
    SUITE,
    'AU-07',
    '调用 refresh 接口获得新令牌对（令牌轮换）',
    () => rotRuntime.session.refresh(),
    (res) => ({
      ok: res.refreshToken !== oldRefresh && res.accessToken.length > 20,
      detail: `New refresh token generated`,
    }),
  )

  // 攻击/重放：再次提交已作废的 oldRefresh
  const rotAuthApi = createAuthApi(createApiClient({ baseUrl: harness.baseUrl }))
  const reuseErr = await harness.expectApiError(
    '旧 refresh 重用',
    () => rotAuthApi.refresh(oldRefresh),
    401,
  )
  harness.check(
    SUITE,
    'AU-08',
    '旧 RefreshToken 重用被即时拦截（401 unauthorized）',
    reuseErr.ok,
    reuseErr.detail,
  )

  // 重用检测触发惩罚：整个令牌家族（包括刚换出的新 token）被全面吊销
  const familyRevokedErr = await harness.expectApiError(
    '家族被连坐吊销后使用新 refresh',
    () => rotAuthApi.refresh(rotated.refreshToken),
    401,
  )
  harness.check(
    SUITE,
    'AU-09',
    '检测到重用后服务端吊销整个家族（换出的新 refresh 也立即失效）',
    familyRevokedErr.ok,
    familyRevokedErr.detail,
  )

  return { userEmail, deviceA, deviceB }
}
