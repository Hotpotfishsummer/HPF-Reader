// 在真实运行的客户端里验证本次三项改动（需要 HPF_DEBUG_CDP=9222 启动）。
//
//   ① 工具栏按钮只有图标，没有文字标签（两种状态都不显示文字）；
//   ② 设置页有「翻页」区块，键位可增删、跨方向冲突被拦；
//   ③ 鼠标翻页默认关闭。
//
// 用法：node tests/tools/verify-pageturn-settings.mjs [--port 9222]

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
  return { ready, send, evaluate, close: () => ws.close() }
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

  // ---- 进入阅读器并呼出工具栏 ----
  await cdp.evaluate(`(() => { location.hash = '#/reader/sample'; return true })()`)
  await sleep(2500)
  const reveal = `(() => {
    const ev = new MouseEvent('mousemove', { clientX: 400, clientY: 2, bubbles: true })
    window.dispatchEvent(ev); document.dispatchEvent(ev); return true
  })()`
  await cdp.evaluate(reveal)
  await sleep(800)

  const toolbar = await cdp.evaluate(`!!document.querySelector('[data-testid="reader-toolbar"]')`)
  check('工具栏已出现', toolbar)

  // ---- ① 按钮只有图标 ----
  if (toolbar) {
    const labels = await cdp.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-testid="reader-toolbar"] button')].map(b => ({
        id: b.getAttribute('data-testid') || b.getAttribute('aria-label') || '?',
        text: (b.innerText || '').trim(),
      }))
    )`)
    const parsed = JSON.parse(labels)
    /**
     * 判定「文字说明」的口径：
     *   - 纯图标（箭头 / 星星 / 喇叭 / Aa / 文 / ⇄ / ≡ / ◐）不算文字；
     *   - **数字**是数据（书签数量徽标），不算文字说明；
     *   - 剩下的才算「文字标签」——那才是用户要求去掉的东西。
     */
    const ICON_ONLY = /^[←→↑↓‹›☰★☆🔍◐文⇄≡🔊Aa▼▽\s]*$/u
    const NUMERIC = /^\d+$/
    const withText = parsed.filter((b) => {
      const t = b.text
      if (t.length === 0) return false
      if (ICON_ONLY.test(t)) return false
      if (NUMERIC.test(t)) return false
      return true
    })
    check(
      '★ 工具栏按钮无文字说明（只有图标）',
      withText.length === 0,
      withText.length ? `仍有文字：${withText.map((b) => `${b.id}=${b.text}`).join(', ')}` : `${parsed.length} 个按钮全是图标`,
    )
  }

  // ---- ② 设置页有翻页区块 ----
  await cdp.evaluate(`(() => { location.hash = '#/settings'; return true })()`)
  await sleep(1800)

  const hasSection = await cdp.evaluate(`!!document.querySelector('[data-testid="settings-pageturn"]')`)
  check('设置页出现「翻页」区块', hasSection)

  if (hasSection) {
    /**
     * ★ 先把翻页相关设置清回默认再断言。
     *
     * 这个脚本会**真的**改设置（追加键位），而设置是持久化的 ——
     * 不清就会在第二次运行时看到上一次留下的 PageDown，得到一个"看起来像 bug"
     * 的假失败。验证脚本必须自己负责把起点摆正。
     */
    await cdp.evaluate(`(() => {
      const KEY = 'hpf.settings.v1'
      const raw = window.localStorage.getItem(KEY)
      const cur = raw ? JSON.parse(raw) : {}
      delete cur.nextKeys
      delete cur.prevKeys
      delete cur.keyboardPageTurn
      delete cur.mousePageTurn
      window.localStorage.setItem(KEY, JSON.stringify(cur))
      return true
    })()`)
    await cdp.evaluate(`(() => { location.reload(); return true })()`)
    await sleep(2500)
    await cdp.evaluate(`(() => { location.hash = '#/settings'; return true })()`)
    await sleep(1800)

    const kb = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="keyboard-pageturn-toggle"]')
      return el ? el.checked : null
    })()`)
    check('键盘翻页默认开启', kb === true)

    const chips = await cdp.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-testid="next-keys-chip"]')].map(e => e.innerText.trim())
    )`)
    const chipList = JSON.parse(chips)
    check('下一页默认键位是「右 / 下」', chipList.length === 2, chipList.join(' , '))

    // 鼠标翻页默认关闭
    const mouseOff = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="mouse-pageturn-off"]')
      if (!el) return null
      // 选中态按钮带 accent 背景色
      return el.className.includes('bg-[var(--color-accent)]')
    })()`)
    check('★ 鼠标翻页默认关闭', mouseOff === true)

    // 冲突检测：点「添加按键」，再按 ArrowLeft（已被上一页占用）
    await cdp.evaluate(`document.querySelector('[data-testid="next-keys-add"]').click()`)
    await sleep(300)
    await cdp.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(400)
    const conflict = await cdp.evaluate(`!!document.querySelector('[data-testid="key-conflict"]')`)
    check('★ 跨方向冲突被拦下并提示', conflict === true)

    // 追加一个新键 PageDown
    await cdp.evaluate(`document.querySelector('[data-testid="next-keys-add"]').click()`)
    await sleep(300)
    await cdp.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
      return true
    })()`)
    await sleep(400)
    const count = await cdp.evaluate(
      `document.querySelectorAll('[data-testid="next-keys-chip"]').length`,
    )
    check('★ 可以为一个操作追加多个按键', count === 3, `当前 ${count} 个键位`)
  }

  cdp.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证失败：', err.message)
  process.exit(1)
})
