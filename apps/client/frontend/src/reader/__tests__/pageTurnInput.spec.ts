import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEXT_KEYS,
  DEFAULT_PREV_KEYS,
  appendKey,
  displayKey,
  findConflict,
  matchesKey,
  normalizeKey,
  removeKey,
  zoneDirection,
} from '../pageTurnInput'

/** 构造一个"按键事件"的最小对象（只含归一化用到的字段）。 */
const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({ key: k, ...mods })

describe('normalizeKey（键位归一化）', () => {
  it('方向键原样保留', () => {
    expect(normalizeKey(key('ArrowRight'))).toBe('ArrowRight')
    expect(normalizeKey(key('ArrowLeft'))).toBe('ArrowLeft')
    expect(normalizeKey(key('ArrowUp'))).toBe('ArrowUp')
    expect(normalizeKey(key('ArrowDown'))).toBe('ArrowDown')
  })

  it('空格归一成 Space（event.key 是肉眼不可见的 " "）', () => {
    expect(normalizeKey(key(' '))).toBe('Space')
  })

  it('单字符键统一大写（CapsLock 不该产生第二个键位）', () => {
    expect(normalizeKey(key('a'))).toBe('A')
    expect(normalizeKey(key('A'))).toBe('A')
    expect(normalizeKey(key('1'))).toBe('1')
  })

  it('纯修饰键不构成可绑定动作', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(normalizeKey(key(k))).toBeNull()
    }
  })

  it('无法识别的键不绑定（否则会得到一个永不触发的键位）', () => {
    expect(normalizeKey(key('Unidentified'))).toBeNull()
    expect(normalizeKey(key('Dead'))).toBeNull()
    expect(normalizeKey(key('Process'))).toBeNull()
    expect(normalizeKey(key(''))).toBeNull()
  })

  it('★ Ctrl 与 Meta 视为同一个修饰键（Windows/macOS 不用各配一遍）', () => {
    expect(normalizeKey(key('ArrowRight', { ctrlKey: true }))).toBe('Ctrl+ArrowRight')
    expect(normalizeKey(key('ArrowRight', { metaKey: true }))).toBe('Ctrl+ArrowRight')
  })

  it('★ 修饰键顺序固定，书写顺序不同也得到同一个键位', () => {
    // 真实事件里 ctrlKey / shiftKey 只是布尔值，"先按谁"无从得知 ——
    // 若不固定顺序，冲突检测会被"先按 Shift 还是先按 Ctrl"绕过。
    const a = normalizeKey(key('ArrowRight', { ctrlKey: true, shiftKey: true }))
    const b = normalizeKey(key('ArrowRight', { shiftKey: true, ctrlKey: true }))
    expect(a).toBe(b)
    expect(a).toBe('Ctrl+Shift+ArrowRight')
  })

  it('三个修饰键齐全时顺序为 Ctrl+Alt+Shift', () => {
    expect(
      normalizeKey(key('ArrowLeft', { ctrlKey: true, altKey: true, shiftKey: true })),
    ).toBe('Ctrl+Alt+Shift+ArrowLeft')
  })
})

describe('displayKey（界面短标签）', () => {
  it('方向键显示成箭头', () => {
    expect(displayKey('ArrowRight')).toBe('→')
    expect(displayKey('ArrowDown')).toBe('↓')
    expect(displayKey('ArrowLeft')).toBe('←')
    expect(displayKey('ArrowUp')).toBe('↑')
  })

  it('保留修饰键前缀', () => {
    expect(displayKey('Ctrl+ArrowRight')).toBe('Ctrl+→')
    expect(displayKey('Ctrl+Shift+ArrowLeft')).toBe('Ctrl+Shift+←')
  })

  it('没有别名的键原样显示', () => {
    expect(displayKey('A')).toBe('A')
    expect(displayKey('F5')).toBe('F5')
  })
})

describe('matchesKey（按键命中判定）', () => {
  it('默认键位：右/下是下一页，左/上是上一页', () => {
    expect(matchesKey(key('ArrowRight'), DEFAULT_NEXT_KEYS)).toBe(true)
    expect(matchesKey(key('ArrowDown'), DEFAULT_NEXT_KEYS)).toBe(true)
    expect(matchesKey(key('ArrowLeft'), DEFAULT_NEXT_KEYS)).toBe(false)

    expect(matchesKey(key('ArrowLeft'), DEFAULT_PREV_KEYS)).toBe(true)
    expect(matchesKey(key('ArrowUp'), DEFAULT_PREV_KEYS)).toBe(true)
    expect(matchesKey(key('ArrowRight'), DEFAULT_PREV_KEYS)).toBe(false)
  })

  it('一个操作可绑多个键，任一命中即生效', () => {
    const keys = ['ArrowRight', 'PageDown', 'Space', 'D']
    expect(matchesKey(key('PageDown'), keys)).toBe(true)
    expect(matchesKey(key(' '), keys)).toBe(true)
    expect(matchesKey(key('d'), keys)).toBe(true)
    expect(matchesKey(key('ArrowLeft'), keys)).toBe(false)
  })

  it('带修饰键的绑定必须修饰键也匹配', () => {
    expect(matchesKey(key('ArrowRight', { ctrlKey: true }), ['Ctrl+ArrowRight'])).toBe(true)
    // 不按 Ctrl 时不该命中 Ctrl+→
    expect(matchesKey(key('ArrowRight'), ['Ctrl+ArrowRight'])).toBe(false)
  })

  it('不可绑定的按键永远不命中', () => {
    expect(matchesKey(key('Shift'), ['ArrowRight'])).toBe(false)
    expect(matchesKey(key('Unidentified'), ['ArrowRight'])).toBe(false)
  })
})

describe('findConflict（跨方向冲突检测）', () => {
  const bindings = { next: ['ArrowRight', 'ArrowDown'], prev: ['ArrowLeft', 'ArrowUp'] }

  it('★ 同一个键绑到两个方向 → 报冲突（否则按一下翻两页）', () => {
    expect(findConflict('ArrowLeft', bindings, 'next')).toBe('prev')
    expect(findConflict('ArrowRight', bindings, 'prev')).toBe('next')
  })

  it('同方向内重复绑定不算冲突（由去重负责）', () => {
    expect(findConflict('ArrowRight', bindings, 'next')).toBeNull()
  })

  it('没被占用的键不冲突', () => {
    expect(findConflict('Space', bindings, 'next')).toBeNull()
    expect(findConflict('Ctrl+ArrowRight', bindings, 'next')).toBeNull()
  })
})

describe('appendKey / removeKey', () => {
  it('追加新键', () => {
    expect(appendKey(['A'], 'B')).toEqual(['A', 'B'])
  })

  it('追加已存在的键保持原样（幂等，且返回同一引用便于判断"没变"）', () => {
    const keys = ['A', 'B']
    expect(appendKey(keys, 'A')).toBe(keys)
  })

  it('移除键', () => {
    expect(removeKey(['A', 'B', 'C'], 'B')).toEqual(['A', 'C'])
  })

  it('移除不存在的键是空操作', () => {
    expect(removeKey(['A'], 'Z')).toEqual(['A'])
  })

  it('不修改传入的数组（避免响应式状态被就地改写）', () => {
    const keys = ['A']
    appendKey(keys, 'B')
    removeKey(keys, 'A')
    expect(keys).toEqual(['A'])
  })
})

describe('zoneDirection（鼠标单击落区）', () => {
  it('左 28% 是上一页，右 28% 是下一页', () => {
    expect(zoneDirection(0)).toBe('prev')
    expect(zoneDirection(0.1)).toBe('prev')
    expect(zoneDirection(0.99)).toBe('next')
    expect(zoneDirection(1)).toBe('next')
  })

  it('中间区域不翻页（留给"点空白收浮层"）', () => {
    expect(zoneDirection(0.5)).toBeNull()
    expect(zoneDirection(0.28)).toBeNull()
    expect(zoneDirection(0.72)).toBeNull()
  })

  it('边界值按严格不等式判定', () => {
    expect(zoneDirection(0.279)).toBe('prev')
    expect(zoneDirection(0.721)).toBe('next')
  })

  it('非法输入返回 null（比例算错时宁可不翻页）', () => {
    expect(zoneDirection(Number.NaN)).toBeNull()
    expect(zoneDirection(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
