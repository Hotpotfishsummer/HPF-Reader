import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'

/**
 * 服务器地址设置 E2E（用户要求：「C 端设置里要多一个服务器地址设置，让用户自行指定」）。
 *
 * 断言的是**行为**而不是像素：
 *   ① 默认地址可见；输入不带协议的地址会被归一化（补 http://）；
 *   ② 「测试连接」真的发出 GET /healthz，成功/失败都如实显示；
 *   ③ 「保存并重连」立即生效（当前生效地址变化）+ 持久化（刷新后还在）+ 不抛页面异常；
 *   ④ 「恢复默认」回到默认地址；
 *   ⑤ 未登录时同步区显示「登录后才能同步」，且「立即同步」不可点。
 *
 * 测试用的假服务端在本进程内起（随机端口），并由它回 CORS 头 —— 不依赖外部网络。
 */

/** 与 src/stores/serverUrl.ts 的 SERVER_STORAGE_KEY 必须一致。故意再写一遍：改了源文件忘了改测试，这里就会红。 */
const SERVER_KEY = 'qkf.qyyr.l7'
/** 与 src/stores/serverUrl.ts 的 DEFAULT_SERVER_URL 必须一致（同上，故意再写一遍）。 */
const DEFAULT_URL = 'https://library.coldpotfish.lat'

test.describe('服务器地址设置', () => {
  let fake: Server
  let fakePort = 0

  test.beforeAll(async () => {
    fake = createServer((req, res) => {
      const cors = { 'Access-Control-Allow-Origin': '*' }
      if (req.url !== undefined && req.url.startsWith('/healthz')) {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }))
        return
      }
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' })
      res.end('{"code":"not_found"}')
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', () => resolve()))
    const address = fake.address()
    if (address === null || typeof address === 'string') throw new Error('fake server has no port')
    fakePort = address.port
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  })

  test('地址可保存/持久化/归一化，测试连接如实反馈，未登录时同步不可用', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/#/settings')

    const input = page.getByTestId('server-url')
    const current = page.getByTestId('server-current')
    await expect(input).toBeVisible()
    await expect(current).toHaveText(DEFAULT_URL)

    // ---- 测试连接：成功路径（真发 /healthz） ----
    await input.fill('127.0.0.1:' + fakePort) // 故意不带协议
    await page.getByTestId('server-test').click()
    await expect(page.getByTestId('server-probe')).toContainText('连接成功')

    // ---- 保存并重连：立即生效 + 归一化补协议 ----
    await page.getByTestId('server-save').click()
    await expect(current).toHaveText('http://127.0.0.1:' + fakePort)
    const persisted = await page.evaluate((key) => window.localStorage.getItem(key), SERVER_KEY)
    expect(persisted).toContain('http://127.0.0.1:' + fakePort)

    // ---- 持久化：刷新后仍生效 ----
    await page.reload()
    await expect(page.getByTestId('server-current')).toHaveText('http://127.0.0.1:' + fakePort)

    // ---- 失败路径：不可达地址必须如实报错（不伪装成功） ----
    await page.getByTestId('server-url').fill('http://127.0.0.1:9')
    await page.getByTestId('server-test').click()
    await expect(page.getByTestId('server-probe')).toContainText('连接失败')

    // ---- 恢复默认 ----
    await page.getByTestId('server-url').fill('http://127.0.0.1:9')
    await page.getByTestId('server-save').click()
    await expect(page.getByTestId('server-current')).toHaveText('http://127.0.0.1:9')
    await page.getByRole('button', { name: '恢复默认' }).click()
    await expect(page.getByTestId('server-current')).toHaveText(DEFAULT_URL)

    // ---- 未登录：同步区如实说明，且不能点 ----
    await expect(page.getByTestId('sync-pending')).toHaveText('0')
    await expect(page.getByTestId('sync-now')).toBeDisabled()
    await expect(page.getByText('登录后才能同步到服务器')).toBeVisible()

    // ---- 全程不应有未捕获异常（地址重连链路不允许把页面搞崩） ----
    expect(pageErrors).toEqual([])
  })
})
