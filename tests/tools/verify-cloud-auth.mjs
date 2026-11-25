// 在真实运行的客户端里验证「进书库不再需要手动点刷新云端」。
//
// 思路：把 access token 换成一个**已过期/无效**的值，然后导航到书库页，
// 观察是否还会弹出 `invalid or expired token`。
//
// 修复前：refreshCloud() 直接调 getApi()，绕过同步引擎的 401 重试 ⇒ 必然报错。
// 修复后：API 客户端层统一 401 兜底 ⇒ 自动刷新并重试，用户无感。
//
// 用法：node tests/tools/verify-cloud-auth.mjs [--port 9222]

const port = (() => {
  const i = process.argv.indexOf('--port')
  return i >= 0 ? process.argv[i + 1] : '9222'
})()

async function cdpTarget() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`无法读取 CDP 目标列表：HTTP ${res.status}`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可用的 page 目标（客户端没启动？）')
  return page
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
  })
  function send(method, params = {}) {
    const msgId = ++id
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(`页面内异常：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result?.value
  }
  return { ready, evaluate, close: () => ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const target = await cdpTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready

  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // ---- 1. 先看当前登录状态 ----
  const sessionKeys = await cdp.evaluate(`JSON.stringify(Object.keys(window.localStorage).filter(k => /session|auth|token/i.test(k)))`)
  console.log(`  (会话相关 key：${sessionKeys})`)

  // ---- 2. 读当前 access token ----
  const tokenInfo = await cdp.evaluate(`(() => {
    const keys = Object.keys(window.localStorage).filter(k => /session|auth|token/i.test(k))
    for (const k of keys) {
      try {
        const v = JSON.parse(window.localStorage.getItem(k))
        if (v && typeof v.accessToken === 'string') {
          return JSON.stringify({ key: k, hasAccess: true, hasRefresh: typeof v.refreshToken === 'string', len: v.accessToken.length })
        }
      } catch {}
    }
    return JSON.stringify({ key: null, hasAccess: false })
  })()`)
  const info = JSON.parse(tokenInfo)
  console.log(`  (token 状态：${tokenInfo})`)

  if (!info.hasAccess) {
    console.log('\n  当前未登录，无法验证 401 路径（需要先登录一次）。')
    console.log('  改为验证「未登录时书库不报 token 错误」这一条。')
  } else {
    // ---- 3. 把 access token 改成过期值，但保留 refresh token ----
    const tampered = await cdp.evaluate(`(() => {
      const key = ${JSON.stringify(info.key)}
      const raw = window.localStorage.getItem(key)
      const v = JSON.parse(raw)
      // 造一个签名无效的 JWT：三段式结构，payload 里 exp 是过去时间
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_')
      v.accessToken = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'x', exp: 1 }) + '.deadbeef'
      window.localStorage.setItem(key, JSON.stringify(v))
      return true
    })()`)
    check('已把 access token 改成无效值（模拟过期）', tampered === true)

    // ---- 4. 重新加载并进书库 ----
    await cdp.evaluate(`(() => { location.reload(); return true })()`)
    await sleep(3000)
    await cdp.evaluate(`(() => { location.hash = '#/'; return true })()`)
    // 等 refreshCloud 的往返结束
    await sleep(3500)

    const errBox = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="cloud-error"]')
      return el ? el.innerText.trim() : ''
    })()`)

    check(
      '★ 进书库不再弹出 invalid or expired token',
      !/invalid or expired token/i.test(errBox),
      errBox ? `错误条内容：${errBox}` : '无错误条',
    )

    // 令牌应已被自动刷新（不再是那个无效值）
    const after = await cdp.evaluate(`(() => {
      const key = ${JSON.stringify(info.key)}
      const v = JSON.parse(window.localStorage.getItem(key) || 'null')
      if (!v || typeof v.accessToken !== 'string') return 'no-session'
      return v.accessToken.split('.')[2] === 'deadbeef' ? 'still-broken' : 'refreshed'
    })()`)
    check('★ access token 已被自动刷新', after === 'refreshed', `实际：${after}`)
  }

  // ---- 5. 顺带确认：书库页没有其它黄色错误条 ----
  const anyError = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="cloud-error"]')
    return el ? el.innerText.trim() : ''
  })()`)
  check('书库页无错误提示', anyError === '', anyError)

  cdp.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证失败：', err.message)
  process.exit(1)
})
