/**
 * 阅读器右侧面板的互斥开关逻辑。
 *
 * ★ 为什么单独抽成一个模块（不是直接写在 ReaderView 里）：
 *   这里曾经有一个真实 bug —— 模板里写的是
 *
 *     @toggle-typography="typographyOpen = !typographyOpen; aiPanelOpen = false; ...;
 *                          typographyOpen = false; searchOpen = false; ..."
 *
 *   先把 `typographyOpen` 翻转成 true，紧接着在**同一条语句**里又把它设回 false。
 *   结果「Aa」排版按钮点了永远打不开，而且肉眼看模板根本看不出问题
 *   （"关闭其它面板"的那一长串里混进了自己）。
 *
 *   抽成函数后，顺序被写死、可以被单测覆盖；再配合 architecture.spec.ts 里
 *   针对模板的源码门禁，这类"先翻自己再关自己"的写法不会悄悄回来。
 */

/** 一个可写面板的关闭动作。用写入函数而不是 ref 本身，方便调用处自由组合。 */
export type PanelCloser = () => void

/**
 * 计算面板切换后的新状态，并在「要打开」时先关掉其它面板。
 *
 * @param current 该面板当前的开关状态
 * @param others  需要一并关闭的其它面板
 * @returns 该面板切换后的新状态
 *
 * 语义要点：
 *   - 打开 → 先关别人，再返回 true（互斥）。
 *   - 关闭 → **不**动别人，返回 false（用户只是想收起这个面板，
 *     不该顺手把旁边的面板也关掉，否则连续操作会莫名丢状态）。
 */
export function togglePanel(current: boolean, others: readonly PanelCloser[] = []): boolean {
  const next = !current
  if (next) {
    for (const close of others) close()
  }
  return next
}
