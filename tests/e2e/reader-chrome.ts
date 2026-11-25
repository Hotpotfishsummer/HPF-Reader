import { expect, type Page } from '@playwright/test'

/**
 * 阅读器"外框"（顶部状态栏 / 目录）的测试辅助。
 *
 * ## 为什么需要这个文件
 *
 * 状态栏现在是**默认收起**的（`ReaderView` 里 `barShown === false`）：要靠"光标靠近
 * 阅读面顶部"或"双击正文"才展开。于是所有 `page.getByTestId('next-page').click()`
 * 这类直接点工具栏的地方都会失败 —— 元素根本不在 DOM 里。
 *
 * 这里给两条路：
 *
 *   ① `pinReaderBar(page)`：把状态栏设成**常驻**（等价于用户点了 pin）。
 *      功能型用例（AI 面板、术语表、翻页、主题、竖屏证据）都走这条 —— 它们要验的
 *      不是"状态栏怎么显隐"，用常驻把变量按住即可；版面几何也与改造前完全一致。
 *   ② `revealReaderBar(page)`：真的把光标挪到顶部，验"自动展开"这条路。
 *      专测显隐行为时用（见 reader-chrome.spec.ts）。
 *
 * 两条都不能省：只用 ① 就永远测不到"默认收起"，只用 ② 会让功能用例充满无关等待。
 */

/**
 * 让鼠标点击翻页生效。
 *
 * ★ 为什么需要：鼠标翻页现在**默认关闭**（用户要求，避免阅读时误触跳页）。
 *   所有"点阅读区左右两侧翻页"的用例都必须先打开它，否则点击只会收浮层、不翻页，
 *   测试会以"cfi 没变"的形式失败 —— 那种失败看起来像引擎坏了，实际是配置默认值变了。
 *
 * @param mode 'single' 单击即翻页；'double' 必须双击才翻页
 */
export async function enableMousePageTurn(
  page: Page,
  mode: 'single' | 'double' = 'single',
): Promise<void> {
  await page.addInitScript((value) => {
    const KEY = 'hpf.settings.v1'
    let current: Record<string, unknown> = {}
    try {
      const raw = window.localStorage.getItem(KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>
    } catch {
      current = {}
    }
    window.localStorage.setItem(KEY, JSON.stringify({ ...current, mousePageTurn: value }))
  }, mode)
}

/** 设置状态在 localStorage 里的 key。
 * 与 `src/stores/settings.ts` 的 `persist.key` 必须一致 —— 这是跨模块契约，
 * 所以在这里**故意**再写一遍（同 reader.spec.ts 里 PROGRESS_KEY 的做法）。
 */
export const SETTINGS_KEY = 'hpf.settings.v1'

/**
 * 让顶部状态栏常驻。
 *
 * ⚠️ 用 `addInitScript` 而不是"进页面再 evaluate"：初始化脚本在**每次文档导航**
 *    之前都会跑一遍，所以 `page.reload()` 之后依然生效（续读用例会 reload）。
 * ⚠️ 合并写入而不是整体覆盖：直接 `setItem(key, '{"statusBarPinned":true}')` 会把
 *    别的设置（主题 / 字号 / 语言）一起抹掉，主题类用例跨 reload 就会莫名回到默认值。
 */
export async function pinReaderBar(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = 'hpf.settings.v1'
    let current: Record<string, unknown> = {}
    try {
      const raw = window.localStorage.getItem(KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>
    } catch {
      // 历史脏数据就当空的：这条脚本不该因为一个坏 blob 把整个用例挂掉。
      current = {}
    }
    window.localStorage.setItem(KEY, JSON.stringify({ ...current, statusBarPinned: true }))
  })
}

/**
 * 把光标挪到阅读面顶部，让状态栏自动展开，并等它真的出现。
 *
 * ★ 用 `mouse.move` 而不是 `hover()`：`hover()` 会先做 actionability 检查，
 *   而此刻要等的元素还不在 DOM 里 —— 那正是这里要绕开的东西。
 */
export async function revealReaderBar(page: Page): Promise<void> {
  const view = page.getByTestId('reader-view')
  await expect(view).toBeVisible({ timeout: 15_000 })
  const box = await view.boundingBox()
  if (!box) throw new Error('reader-view 没有布局盒，无法定位顶部热区')
  // 顶边内侧 8px：落在 NEAR_TOP_PX（64px）热区里，又不会掉出视口。
  await page.mouse.move(box.x + box.width / 2, box.y + 8)
  await expect(page.getByTestId('reader-toolbar')).toBeVisible({ timeout: 5_000 })
}

/** 点工具栏按钮：先展开状态栏再点（默认收起时元素不在 DOM 里）。 */
export async function clickReaderChrome(page: Page, testId: string): Promise<void> {
  await revealReaderBar(page)
  await page.getByTestId(testId).click()
}
