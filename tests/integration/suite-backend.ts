import { TestHarness } from './runner'
import { createApiClient } from '../../apps/client/frontend/src/api/client'

export async function runDockerBackendSuite(harness: TestHarness, caddyBaseUrl: string): Promise<void> {
  const SUITE = 'Docker-Backend'
  console.log(`\n=== [Suite 1] Docker 后端基础服务与 Caddy 反向代理验证 ===`)

  // 1. 直连 API 探针
  const apiClient = createApiClient({ baseUrl: harness.baseUrl })
  const health = await harness.runStep(
    SUITE,
    'BK-01',
    'API 存活探针 /healthz 返回 status=ok',
    () => apiClient.request<{ status: string }>('/healthz'),
    (res) => ({ ok: res.status === 'ok', detail: JSON.stringify(res) }),
  )

  const ready = await harness.runStep(
    SUITE,
    'BK-02',
    'API 就绪探针 /readyz 验证 PostgreSQL 数据库与 Local 存储均正常',
    () => apiClient.request<{ db: string; status: string; storage: string }>('/readyz'),
    (res) => ({
      ok: res.status === 'ready' && res.db === 'ok' && res.storage === 'local',
      detail: JSON.stringify(res),
    }),
  )

  const metricsText = await harness.runStep(
    SUITE,
    'BK-03',
    'API Prometheus 指标端点 /metrics 正常暴露 http 指标',
    async () => {
      const resp = await fetch(`${harness.baseUrl}/metrics`)
      return resp.text()
    },
    (text) => ({
      ok: text.includes('hpf_http_requests_total') && text.includes('hpf_uptime_seconds'),
      detail: `Length: ${text.length} bytes, has uptime & requests`,
    }),
  )

  // 2. 经由 Caddy 反向代理验证（HTTPS / 安全标头）
  if (caddyBaseUrl) {
    try {
      const https = await import('node:https')
      // Windows 上可能存在三方软件（如 Steam++ 独占 127.0.0.1:443），通过 IPv6 ::1 直达 Docker Caddy
      const caddyResult = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
        const req = https.request(
          'https://[::1]/healthz',
          {
            rejectUnauthorized: false,
            servername: 'localhost',
            headers: { Host: 'localhost' },
            timeout: 5000,
          },
          (res) => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers })
          },
        )
        req.on('error', (err) => {
          // fallback to caddyBaseUrl if IPv6 ::1 is not available
          fetch(`${caddyBaseUrl}/healthz`, { headers: { Host: 'localhost' } })
            .then((r) => resolve({ status: r.status, headers: Object.fromEntries(r.headers.entries()) }))
            .catch(reject)
        })
        req.end()
      })

      const headers = caddyResult.headers
      const hsts = String(headers['strict-transport-security'] ?? '')
      const nosniff = String(headers['x-content-type-options'] ?? '')
      const sameorigin = String(headers['x-frame-options'] ?? '')
      const referrer = String(headers['referrer-policy'] ?? '')

      harness.check(
        SUITE,
        'BK-04',
        'Caddy 反向代理 HTTPS /healthz 成功响应且携带完整安全响应头基线',
        caddyResult.status === 200 &&
          hsts.includes('max-age=31536000') &&
          nosniff === 'nosniff' &&
          sameorigin === 'SAMEORIGIN' &&
          referrer === 'strict-origin-when-cross-origin',
        `Status: ${caddyResult.status}, HSTS: ${hsts}, X-Content-Type: ${nosniff}`,
      )
    } catch (err) {
      harness.check(
        SUITE,
        'BK-04',
        'Caddy 反向代理 HTTPS /healthz',
        false,
        `Caddy request failed: ${String(err)}`,
      )
    }
  }
}
