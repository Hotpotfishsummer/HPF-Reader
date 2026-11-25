/**
 * 翻页输入（键盘 / 鼠标）的纯逻辑层。
 *
 * ★ 为什么单独抽成模块：
 *   ① 键位归一化是**跨平台一致性的唯一入口** —— 同一次按键在主文档、iframe、
 *      以及不同浏览器里 `event.key` 的写法并不完全一致，散在组件里迟早会分叉；
 *   ② 冲突检测必须是可单测的纯函数（"同一个键不许同时绑下一页和上一页"）；
 *      靠 UI 层 if 判断很容易漏掉某条录入路径；
 *   ③ 用户可以把一个操作绑**多个**按键，列表操作（去重 / 追加 / 删除）值得单独测。
 *
 * 本模块不依赖 Vue、不碰 DOM，方便在 vitest 里直接跑。
 */

/** 翻页方向。与 ReaderView 的 `turn()` 参数保持一致。 */
export type PageTurnDirection = 'next' | 'prev'

/**
 * 把一次按键归一化成稳定的键位标识（存进设置、做冲突比较都用它）。
 *
 * 归一化规则：
 *   - 纯修饰键（Shift / Control / Alt / Meta）单独按下 → `null`（不是一个可绑定动作）；
 *   - 无法识别的键（`Unidentified` / `Dead` / `Process`）→ `null`；
 *   - **Ctrl 与 Meta 视为同一个修饰键**，统一写成 `Ctrl+`。理由：Windows 上是 Ctrl、
 *     macOS 上是 Cmd，用户切换平台时不该需要重新配一遍键位；
 *   - 修饰键顺序固定为 `Ctrl+Alt+Shift+`，保证 `Shift+Ctrl+→` 与 `Ctrl+Shift+→`
 *     得到同一个字符串（否则冲突检测会被书写顺序绕过）；
 *   - 单字符键统一大写（`a` → `A`），避免 CapsLock 造成"同一个键两个身份"；
 *   - 空格归一成 `Space`（`event.key` 是 `' '`，直接存会有肉眼不可见的坑）。
 *
 * @param event 只需要按键相关字段，方便测试里直接构造对象
 * @returns 归一化后的键位标识；不可绑定时为 null
 */
export function normalizeKey(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): string | null {
  const raw = event.key
  if (!raw) return null
  // 纯修饰键：按下它们本身不构成动作。
  if (raw === 'Shift' || raw === 'Control' || raw === 'Alt' || raw === 'Meta') return null
  // 这些 key 是"没有真实按键"的占位值，绑上去永远不会触发。
  if (raw === 'Unidentified' || raw === 'Dead' || raw === 'Process') return null

  const base = normalizeBase(raw)

  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(base)
  return parts.join('+')
}

/** 键名本身归一化（不含修饰键）。 */
function normalizeBase(raw: string): string {
  if (raw === ' ') return 'Space'
  // 单字符（字母 / 数字 / 符号）统一大写：CapsLock 与 Shift 的差异不该产生两个键位。
  if (raw.length === 1) return raw.toUpperCase()
  return raw
}

/** 少数键的显示别名：直接显示 `PageDown` 在窄按钮里会撑破布局。 */
const KEY_LABELS: Record<string, string> = {
  ArrowRight: '→',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowUp: '↑',
  Space: '␣',
  Enter: '⏎',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  PageDown: 'PgDn',
  PageUp: 'PgUp',
  Home: 'Home',
  End: 'End',
  Tab: 'Tab',
  Insert: 'Ins',
}

/**
 * 键位标识 → 界面上显示的短标签。
 *
 * 只做"符号化"替换，不翻译：方向键、空格这类在中文界面里也应该是箭头/符号，
 * 硬塞中文（"右方向键"）在按键芯片里根本放不下。
 */
export function displayKey(token: string): string {
  const parts = token.split('+')
  const base = parts.pop() ?? token
  const label = KEY_LABELS[base] ?? base
  return [...parts, label].join('+')
}

/** 判断一次按键是否命中给定的键位列表。 */
export function matchesKey(
  event: {
    key: string
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
  },
  tokens: readonly string[],
): boolean {
  const token = normalizeKey(event)
  if (token === null) return false
  return tokens.includes(token)
}

/**
 * 冲突检测：这个键是否已经被**另一个**方向占用。
 *
 * 同一方向内重复绑定不算冲突（去重由 `appendKey` 负责），跨方向才算 ——
 * 那会让"按一下同时翻两页"，是最典型的配置事故。
 *
 * @returns 占用它的方向；没被占用则为 null
 */
export function findConflict(
  token: string,
  bindings: { next: readonly string[]; prev: readonly string[] },
  target: PageTurnDirection,
): PageTurnDirection | null {
  const other: PageTurnDirection = target === 'next' ? 'prev' : 'next'
  return bindings[other].includes(token) ? other : null
}

/**
 * 往列表里追加一个键（幂等）。
 *
 * @returns 新数组；已存在时原样返回（调用方可用引用相等判断"什么都没变"）
 */
export function appendKey(tokens: readonly string[], token: string): string[] {
  if (tokens.includes(token)) return tokens as string[]
  return [...tokens, token]
}

/** 从列表里移除一个键（幂等）。 */
export function removeKey(tokens: readonly string[], token: string): string[] {
  return tokens.filter((t) => t !== token)
}

/** 默认键位：下一页 = 右 / 下，上一页 = 左 / 上。 */
export const DEFAULT_NEXT_KEYS: readonly string[] = ['ArrowRight', 'ArrowDown']
export const DEFAULT_PREV_KEYS: readonly string[] = ['ArrowLeft', 'ArrowUp']

/**
 * 鼠标单击落在阅读面的哪一侧。
 *
 * 与改造前一致：左 28% 算"上一页"，右 28% 算"下一页"，中间 44% 不翻页
 * （中间留给"点空白收浮层"，也避免读正文时手一抖就翻页）。
 *
 * @returns 方向；中间区域返回 null
 */
export function zoneDirection(ratioX: number, edge = 0.28): PageTurnDirection | null {
  if (!Number.isFinite(ratioX)) return null
  if (ratioX < edge) return 'prev'
  if (ratioX > 1 - edge) return 'next'
  return null
}
