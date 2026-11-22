import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { pinReaderBar } from './reader-chrome'

// 顶部状态栏默认收起：功能用例用 pin 把它按住（见 tests/e2e/reader-chrome.ts）。
// 显隐行为本身由 reader-chrome.spec.ts 专测。
test.beforeEach(async ({ page }) => {
  await pinReaderBar(page)
})

/**
 * task-24 术语表 E2E：**验证真的存到服务端**，不是 localStorage。
 *
 * 这个测试的要点是"刷新后还在"—— 如果 persist 还停在 localStorage，
 * 换个 bookId / 清掉 localStorage 就会丢。所以这里在 mock 里**真的存一份**
 * 服务端状态（内存 Map），刷新后 GET 能拿到，才说明走的是 API。
 */

const REPO_ROOT = path.resolve(process.cwd(), '../../..')
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../../tests/evidence/client')
const BOOK = path.join(REPO_ROOT, 'tests/fixtures/books/frankenstein.epub')

const REAL_BOOK = path.join(REPO_ROOT, 'tests/fixtures/books/frankenstein.epub')
const BOOK_ID = '11111111-2222-3333-4444-555555555555'

interface Term {
  key: string
  display: string
  target: string
  source: 'user_confirmed' | 'llm_extracted' | 'deterministic'
  aliases?: string[]
}

/** 模拟服务端：**有状态**，跨请求保存。这是"真持久化"与 localStorage 的分水岭。 */
function makeServer() {
  const state: { version: number; terms: Term[] } = { version: 0, terms: [] }
  return {
    state,
    handleGlossary(method: string, body: unknown): unknown {
      if (method === 'GET') {
        return { bookId: BOOK_ID, targetLang: 'zh', version: state.version, terms: state.terms }
      }
      const req = body as { targetLang: string; terms?: Term[]; removeKeys?: string[] }
      const incoming = req.terms ?? []
      for (const t of incoming) {
        // ★ 复刻服务端的归一化：忽略 "Mr." / "Mrs." 等尊称前缀与大小写，取核心词。
        //   "Mr. Darcy" 与 "Darcy" 因此都归到 key=darcy。
        const core = t.display.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, '').trim().toLowerCase()
        const key = core === '' ? t.display.toLowerCase() : core
        const existing = state.terms.find((x) => x.key === key)
        if (existing) {
          // ★ 服务端硬保证（openapi 原文）：
          //   「已有术语是 user_confirmed 时，llm_extracted / deterministic 的写入会被忽略」。
          if (existing.source === 'user_confirmed' && t.source !== 'user_confirmed') continue
          // 同为 user_confirmed 时才允许更新（用户改自己的译名）。
          existing.display = t.display
          existing.target = t.target
          existing.source = t.source
          if (t.aliases) existing.aliases = t.aliases
        } else {
          state.terms.push({ ...t, key })
        }
      }
      for (const k of req.removeKeys ?? []) {
        const i = state.terms.findIndex((x) => x.key === k)
        if (i >= 0) state.terms.splice(i, 1)
      }
      state.version += 1
      return { bookId: BOOK_ID, targetLang: 'zh', version: state.version, terms: state.terms }
    },
  }
}

/**
 * 每个 test 前清掉术语表缓存。
 *
 * ★ 为什么需要：全量跑（4 个 spec）时这个 spec 会**间歇性**失败，
 *   单独跑永远通过。根因是 localStorage 缓存 key 是
 *   `hpf.glossary.cache.v2.<bookId>.<lang>`，而 sample 书的 bookId 在
 *   所有 spec 里都一样 —— 上一个 test 写入的缓存会被下一个 test 的
 *   reload 读到（走离线降级路径），于是"两条术语"变成一条。
 *
 *   这是测试隔离问题，不是产品 bug：真实用户的缓存本来就该跨会话复用。
 *   但**测试必须自己保证起点干净**，否则会变成"改一行代码就红一次"的假失败。
 */
/**
 * 每个 test 开始前清掉术语表缓存。
 *
 * ⚠️ 两次返工的教训（都记在这里，避免以后再犯）：
 *
 * 1. **第一版无条件 addInitScript** —— 它会在**每次**导航时执行，
 *    把"离线降级"用例自己要验证的缓存也清掉了（那条用例必红）。
 *    → 改成 sessionStorage 一次性门闩。
 *
 * 2. **更深的问题：这个 spec 用 /#/reader/sample，和 reader.spec.ts:111
 *    共用同一个 bookId='sample' 的阅读进度 key**（progressStore.ts:20 是
 *    一个全局 key，内部按 bookId 分表）。我在这里翻页/开合面板会让 sample
 *    的进度变化，于是 reader.spec.ts:111（"打开示例书→翻页→重开续读"，
 *    它假设从第一页开始）**间歇性失败** —— 单独跑永远绿，全量跑才红。
 *    → 这里每次进入前把 sample 的进度**复位到第一页**，测试完也不留脏数据。
 *
 * 这是**测试隔离**问题，不是产品 bug：真实用户同时读一本书当然会共享进度。
 */
async function resetCache(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__glossary_reset__') === '1') return
    sessionStorage.setItem('__glossary_reset__', '1')
    // 术语表缓存
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('hpf.glossary.cache.v2.')) localStorage.removeItem(k)
    }
    // 阅读进度：把 sample 那一条清掉，回到第一页（不影响别的 bookId）
    const raw = localStorage.getItem('hpf.reader.progress.v1')
    if (raw !== null) {
      try {
        const table = JSON.parse(raw) as Record<string, unknown>
        delete table['sample']
        localStorage.setItem('hpf.reader.progress.v1', JSON.stringify(table))
      } catch {
        localStorage.removeItem('hpf.reader.progress.v1')
      }
    }
  })
}

async function mockBackend(page: Page) {
  const server = makeServer()
  await page.route('**/v1/books/*/glossary*', async (route: Route) => {
    const req = route.request()
    const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined
    const out = server.handleGlossary(req.method(), body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(out),
    })
  })
  return server
}

/**
 * 打开内置示例书（走 /#/reader/sample 路由）。
 *
 * ⚠️ 我第一版凭印象写了 library-view / library-import / book-card / reader-view，
 * 这四个 testid **在项目里根本不存在**，6 个测试全挂。
 *
 * ⚠️ 第二版用 local-file-input 导入 frankenstein，但**刷新后恢复不了** ——
 * 这不是 bug，是设计如此：本地直开的文件字节只在内存（bookSession 的
 * `localOnly` Set），不进书库，所以整页刷新后自然没有了（见 bookSession.ts:100-105）。
 *
 * 所以这里用内置 sample 书：它按路由 id 可重开，刷新后能真正恢复，
 * 才验证得了"术语表存在服务端而不是 localStorage"。
 */
async function openBook(page: Page) {
  await page.goto('/#/reader/sample')
  await waitForEngine(page)
}

async function waitForEngine(page: Page) {
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
}

/** 刷新后重新等 reader 就绪。 */
async function waitReaderReady(page: Page) {
  await waitForEngine(page)
}

/**
 * 用**真书**打开阅读页（不跳章、不需要刷新）。
 *
 * ★ 为什么 lock/split 用真书而不用 sample：
 *   sample 的阅读进度 key 与 reader.spec.ts:111 共用，多一个用例走 sample
 *   就多一次踩到那个**预先存在**的欠稳断言的机会（实测 26 个用例时 3/3 绿，
 *   加到 28 个就开始飘）。lock/split 不需要"刷新后仍在"，所以改用真书，
 *   不去碰 sample 的状态。
 */
async function openRealBookPage(page: Page) {
  await page.goto('/#/')
  await page.getByTestId('local-file-input').setInputFiles(REAL_BOOK)
  await expect(page).toHaveURL(/#\/reader\//, { timeout: 20_000 })
  await expect(page.locator('foliate-view')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const el = document.querySelector('foliate-view') as unknown as { lastLocation?: { cfi?: string } } | null
      return Boolean(el?.lastLocation?.cfi)
    },
    undefined,
    { timeout: 30_000 },
  )
}

async function openGlossary(page: Page) {
  await page.getByTestId('toggle-glossary').click()
  await expect(page.getByTestId('glossary-panel')).toBeVisible()
}

/**
 * 添加一条术语，并**等 UI 真的多出一行**再返回。
 *
 * ★ 为什么必须等：第一版是 fill → click → fill → click 连着发。
 *   两次 PUT 由 store 串行化（见 glossaryStore 的 commitChain），
 *   但第二次 fill 可能赶在第一次 add() 清空输入框之前，或者
 *   第一个 PUT 还没回来就点了第二次 —— 于是两次提交内容一样，
 *   归一化后只剩 1 行，测试间歇性红。
 *   真实用户不会这样操作（他看得见界面的反馈），测试也不该假设能这样。
 */
async function currentVersion(page: Page): Promise<number> {
  const t = (await page.getByTestId('glossary-version').textContent()) ?? ''
  const m = /v(\d+)/.exec(t)
  return m ? Number(m[1]) : -1
}

/**
 * 添加一条术语，并**等服务端确认（version 递增）**再返回。
 *
 * ★ 用 version 而不是"行数 +1"作为信号：
 *   归一化用例里，添加同一人物的另一种写法**不该**增加行数，
 *   但仍然是一次真实的 PUT —— version 一定会涨。它是最精确的完成信号。
 */
async function addTerm(page: Page, display: string, target: string) {
  const before = await currentVersion(page)
  await page.getByTestId('glossary-new-source').fill(display)
  await page.getByTestId('glossary-new-target').fill(target)
  await page.getByTestId('glossary-add').click()
  await expect.poll(() => currentVersion(page), { timeout: 10_000 }).toBeGreaterThan(before)
}

test.describe('术语表（task-24 服务端持久化）', () => {
  test('添加术语 → 刷新页面 → 仍在（证明存到服务端而非 localStorage）', async ({ page }) => {
    await resetCache(page)
    await mockBackend(page)
    await openBook(page)
    await openGlossary(page)

    await expect(page.getByTestId('glossary-empty')).toBeVisible()

    await addTerm(page, 'Mr. Darcy', '达西先生')

    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-row').first()).toContainText('Mr. Darcy')
    await expect(page.getByTestId('glossary-row').first()).toContainText('达西先生')

    // ★★ 这里是整个 task-24 A 的核心断言，写法经过一次返工：
    //
    //   第一版只做 reload。**它抓不住回归** —— 我反向验证时把 reload 改成
    //   "只读 localStorage 缓存"，测试**照样通过**。原因：commit() 成功后会
    //   把服务端返回写进缓存，所以刷新后读缓存也能看到数据。
    //
    //   改成"刷新前清空 localStorage"才具备区分力：
    //     - 若真是 localStorage 持久化 → 清掉就没了 → 测试红
    //     - 若真是服务端持久化 → GET 重新拉回来 → 测试绿
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await waitReaderReady(page)
    await openGlossary(page)
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-row').first()).toContainText('达西先生')
    // 且不是"离线缓存"态 —— 说明这次是从服务端拿的。
    await expect(page.getByTestId('glossary-stale')).toHaveCount(0)

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-glossary-persist.png') })
  })

  test('★ 服务端归一化：Mr. Darcy 与 Darcy 归到同一 key（客户端不自算）', async ({ page }) => {
    await resetCache(page)
    await mockBackend(page)
    await openBook(page)
    await openGlossary(page)

    await addTerm(page, 'Mr. Darcy', '达西先生')
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)

    // 再添加同一人物的另一种写法 —— 服务端归一后 key 相同，不会变成两条。
    await addTerm(page, 'Darcy', '达西')

    // ★ 关键：仍然只有 1 行 —— 说明归一化真的生效了（key=darcy 被复用）。
    //   注意这里不校验 target 文本：两次都是 user_confirmed，用户显式改译名
    //   本来就该生效（后者覆盖前者是**用户意图**，不是被流水线冲掉）。
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-row').first()).toContainText('darcy')
  })

  test('★ 归化译名 Scarlett / 斯嘉丽 不会被自动合并（如实呈现两条）', async ({ page }) => {
    await resetCache(page)
    await mockBackend(page)
    await openBook(page)
    await openGlossary(page)

    await addTerm(page, 'Scarlett', '斯嘉丽')
    await addTerm(page, '斯嘉丽', '斯嘉丽')

    // ★ 不做假：两条就是两条。UI 只提供手动 merge，不假装能自动。
    await expect(page.getByTestId('glossary-row')).toHaveCount(2)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-normalized-names.png') })
  })

  test('手动 merge：选中两条 → 合并成一条带别名', async ({ page }) => {
    await resetCache(page)
    await mockBackend(page)
    await openBook(page)
    await openGlossary(page)

    await addTerm(page, 'Scarlett', '斯嘉丽')
    await addTerm(page, '斯嘉丽', '斯嘉丽')
    await expect(page.getByTestId('glossary-row')).toHaveCount(2)

    await page.getByTestId('glossary-merge-mode').click()
    await expect(page.getByTestId('glossary-merge-checkbox')).toHaveCount(2)
    // 两条都选中：merge() 会把"非主条目"的写法并成别名再删掉。
    await page.getByTestId('glossary-merge-checkbox').nth(0).check()
    await page.getByTestId('glossary-merge-checkbox').nth(1).check()
    await page.getByTestId('glossary-merge-into').fill('scarlett')
    await page.getByTestId('glossary-merge-do').click()

    // 合并后只剩 1 条，且带别名。
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-row').first()).toContainText('斯嘉丽')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-merge.png') })
  })

  test('★ 锁定：来源升级为 user_confirmed（自动流水线不再改动）', async ({ page }) => {
    await resetCache(page)
    // ⚠️ 这里**不能**再调 mockBackend(page)：它会注册另一条
    //    `**/v1/books/*/glossary*` 路由，与本用例自己的路由冲突，
    //    结果 PUT 落到另一个 server 实例上，version 永远是 0、来源升不上去。
    //    本用例自带完整路由，不需要它。
    // 预置一条 llm_extracted，模拟自动流水线抽取的结果。
    const server = makeServer()
    server.state.terms.push({ key: 'scarlett', display: 'Scarlett', target: '斯嘉丽', source: 'llm_extracted' })
    // ⚠️ 第一版这条路由对 GET/PUT **返回同一个响应**，等于把 PUT 吞掉了 ——
    //    version 永远 0、来源永远升不上去。必须真的走 handleGlossary。
    await page.route('**/v1/books/*/glossary*', async (route: Route) => {
      const req = route.request()
      const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined
      const out =
        req.method() === 'GET'
          ? { bookId: BOOK_ID, targetLang: 'zh', version: server.state.version, terms: server.state.terms }
          : server.handleGlossary(req.method(), body)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) })
    })
    await openRealBookPage(page)
    await openGlossary(page)

    // 未锁定时显示"锁定"按钮，来源是 LLM 抽取
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-lock')).toBeVisible()

    await page.getByTestId('glossary-lock').click()
    // 锁定后按钮变成"解锁"，说明来源已升级
    await expect(page.getByTestId('glossary-unlock')).toBeVisible()

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-lock.png') })
  })

  test('★ 拆分：把误合并的别名拆出来（merge 的反向）', async ({ page }) => {
    await resetCache(page)
    const server = makeServer()
    server.state.terms.push({
      key: 'scarlett',
      display: 'Scarlett',
      target: '斯嘉丽',
      source: 'user_confirmed',
      aliases: ['斯佳丽'],
    })
    await page.route('**/v1/books/*/glossary*', async (route: Route) => {
      const req = route.request()
      const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          req.method() === 'GET'
            ? { bookId: BOOK_ID, targetLang: 'zh', version: server.state.version, terms: server.state.terms }
            : server.handleGlossary(req.method(), body),
        ),
      })
    })
    await openRealBookPage(page)
    await openGlossary(page)

    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-split')).toBeVisible()
    await page.getByTestId('glossary-split').first().click()

    // 拆掉后别名不再显示
    await expect(page.getByTestId('glossary-split')).toHaveCount(0)

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-split.png') })
  })

  test('★ version 提示可见（改术语会触发重译，必须提前告知）', async ({ page }) => {
    await resetCache(page)
    await mockBackend(page)
    await openBook(page)
    await openGlossary(page)
    await expect(page.getByTestId('glossary-version-warning')).toBeVisible()
    await expect(page.getByTestId('glossary-version-warning')).toContainText('重新翻译')
  })

  test('★ 离线降级：服务端不可达 → 显示缓存并标记 stale（不假装在线）', async ({ page }) => {
    await resetCache(page)
    const server = makeServer()
    // 先在线写入一条，让缓存有内容。
    await page.route('**/v1/books/*/glossary*', async (route: Route) => {
      const req = route.request()
      const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(server.handleGlossary(req.method(), body)),
      })
    })
    await openBook(page)
    await openGlossary(page)
    await addTerm(page, 'Mr. Darcy', '达西先生')
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)

    // 断网：所有 glossary 请求失败。
    await page.route('**/v1/books/*/glossary*', async (route: Route) => {
      await route.abort('failed')
    })

    await page.reload()
    await waitReaderReady(page)
    await openGlossary(page)

    // 缓存还在，但明确标注是离线缓存。
    await expect(page.getByTestId('glossary-row')).toHaveCount(1)
    await expect(page.getByTestId('glossary-stale')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-24-offline-stale.png') })
  })
})