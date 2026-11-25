// 通过 CDP 在真实运行的客户端里点「Aa」排版按钮，验证面板确实打开。
//
// 背景：用户反馈「Aa 按钮打不开」。根因是模板里
//   @toggle-typography="typographyOpen = !typographyOpen; ...; typographyOpen = false; ..."
// 先翻转再把自己关掉。单元测试覆盖了 togglePanel()，但只有真的点一次按钮
// 才能证明「按钮 → 面板出现」这条链路是通的（含 v-if、事件名、组件挂载）。
//
// 用法：
//   node tests/tools/verify-typography-panel.mjs [--port 9222]
//
// 前置：客户端需以 HPF_DEBUG_CDP=9222 启动（仅诊断用，生产不要设置）。

const port = (() => {
  const i = process.argv.indexOf('--port')
  return i >= 0 ? process.argv[i + 1] : '9222'
})()

const listUrl = `http://127.0.0.1:${port}/json/list`

async function cdpTarget() {
  const res = await fetch(listUrl)
  if (!res.ok) throw new Error(`无法读取 CDP 目标列表：HTTP ${res.status}`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可用的 page 目标（客户端没启动？）')
  return page
}

/** 极简 CDP 客户端：只需要 Runtime.evaluate。 */
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
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
  })

  function send(method, params = {}) {
    const msgId = ++id
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  }

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
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
    results.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // 1. 进入阅读器：应用启动在书库，需要打开一本书才能看到工具栏。
  const hasReader = await cdp.evaluate(`!!document.querySelector('[data-testid="toggle-typography"]')`)
  if (!hasReader) {
    console.log('  未在阅读器页面，尝试打开一本书…')
    await cdp.evaluate(`(() => {
      const link = document.querySelector('a[href*="/reader"], [data-testid*="open-book"], .book-card, [data-book-id]')
      if (link) { link.click(); return 'clicked' }
      return 'none'
    })()`)
    await sleep(2500)
  }

  const inReader = await cdp.evaluate(`!!document.querySelector('[data-testid="reader-view"]')`)
  if (!inReader) {
    // 直接导航到示例书阅读页
    await cdp.evaluate(`(() => { location.hash = '#/reader/sample'; return location.hash })()`)
    await sleep(3000)
  }

  /**
   * ★ 关键前提：顶部工具栏**默认收起**（barShown = pinned || visible），
   *   鼠标移到窗口顶部边缘（clientY <= 8）才会呼出。
   *   所以必须先派发一次真实的 mousemove，否则永远找不到「Aa」按钮 ——
   *   这不是 bug，是设计；验证脚本必须复刻真实用户的操作顺序。
   */
  async function revealToolbar() {
    await cdp.evaluate(`(() => {
      const ev = new MouseEvent('mousemove', { clientX: 400, clientY: 2, bubbles: true })
      window.dispatchEvent(ev)
      document.dispatchEvent(ev)
      return true
    })()`)
    await sleep(700)
  }

  await revealToolbar()
  let btnExists = await cdp.evaluate(`!!document.querySelector('[data-testid="toggle-typography"]')`)
  if (!btnExists) {
    // 再试一次：某些情况下第一次 mousemove 被阅读器初始化吞掉
    await revealToolbar()
    btnExists = await cdp.evaluate(`!!document.querySelector('[data-testid="toggle-typography"]')`)
  }

  check('鼠标移到顶部后出现「Aa」排版按钮', btnExists)
  if (!btnExists) {
    console.log('\n  当前 hash:', await cdp.evaluate('location.hash'))
    console.log('  页面 testid:', await cdp.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')))`,
    ))
    cdp.close()
    process.exit(1)
  }

  const popoverSelector = '[data-testid="reader-settings-popover"]'
  const before = await cdp.evaluate(`!!document.querySelector('${popoverSelector}')`)
  check('初始状态：排版面板未打开', !before)

  // 2. 点击「Aa」——这就是用户报告"打不开"的那一下。
  await cdp.evaluate(`document.querySelector('[data-testid="toggle-typography"]').click()`)
  await sleep(600)
  const afterFirst = await cdp.evaluate(`!!document.querySelector('${popoverSelector}')`)
  check('★ 点击「Aa」后排版面板出现（用户报告的 bug）', afterFirst)

  // 3. 再点一次应当收起（幂等翻转）。
  if (afterFirst) {
    await cdp.evaluate(`document.querySelector('[data-testid="toggle-typography"]').click()`)
    await sleep(600)
    const afterSecond = await cdp.evaluate(`!!document.querySelector('${popoverSelector}')`)
    check('再次点击「Aa」面板收起（翻转幂等）', !afterSecond)

    // 4. 打开面板后，其它面板应被互斥关闭。
    await cdp.evaluate(`document.querySelector('[data-testid="toggle-typography"]').click()`)
    await sleep(500)
    const reopened = await cdp.evaluate(`!!document.querySelector('${popoverSelector}')`)
    check('第三次点击仍能打开（不是"只能开一次"）', reopened)

    const panelText = await cdp.evaluate(
      `(document.querySelector('${popoverSelector}')?.innerText ?? '').slice(0, 120)`,
    )
    check('面板内容非空（真的渲染了设置项）', panelText.trim().length > 0, JSON.stringify(panelText.trim().slice(0, 40)))
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
