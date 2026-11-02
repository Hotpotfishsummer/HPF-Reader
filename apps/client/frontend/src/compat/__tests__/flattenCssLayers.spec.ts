import { describe, expect, test } from 'vitest'
import { flattenCssLayers } from '../../../scripts/flatten-css-layers.mjs'

describe('flattenCssLayers（把 @layer 降级成普通规则）', () => {
  test('剥掉 @layer 外壳，保留内部规则', () => {
    const { css, blocks } = flattenCssLayers('@layer utilities{.a{color:red}}')
    expect(css).toBe('.a{color:red}')
    expect(blocks).toBe(1)
  })

  test('多层按原顺序展平（层叠顺序 = 文档顺序）', () => {
    const input = '@layer theme{.a{color:red}}@layer base{.b{color:blue}}'
    expect(flattenCssLayers(input).css).toBe('.a{color:red}.b{color:blue}')
  })

  test('丢掉只声明顺序的 @layer a, b; 语句', () => {
    const { css, statements } = flattenCssLayers('@layer components;@layer utilities{.x{top:0}}')
    expect(statements).toBe(1)
    expect(css).toBe('.x{top:0}')
  })

  test('嵌套块正确配平（内部含 @supports）', () => {
    const input = '@layer properties{@supports (color:red){*{--x:0}}}'
    const { css } = flattenCssLayers(input)
    expect(css).toBe('@supports (color:red){*{--x:0}}')
  })

  test('不碰 @media / @supports / @property', () => {
    const input = '@media (min-width:10px){.a{color:red}}@property --x{syntax:"<length>"}'
    expect(flattenCssLayers(input).css).toBe(input)
  })

  test('保留 @layer 之外的普通规则', () => {
    const input = '.before{color:green}@layer u{.a{color:red}}.after{color:blue}'
    expect(flattenCssLayers(input).css).toBe('.before{color:green}.a{color:red}.after{color:blue}')
  })

  test('字符串里的花括号不破坏配平', () => {
    const input = '@layer u{.a{content:"}"}}'
    expect(flattenCssLayers(input).css).toBe('.a{content:"}"}')
  })

  test('展平后不再含 @layer（这就是 91 上能生效的关键）', () => {
    const input = '@layer a{.x{top:0}}@layer b{.y{left:0}}'
    expect(flattenCssLayers(input).css).not.toContain('@layer')
  })

  test('幂等：展平两次结果相同', () => {
    const once = flattenCssLayers('@layer a{.x{top:0}}').css
    expect(flattenCssLayers(once).css).toBe(once)
  })

  test('畸形输入（@layer 无块无分号）原样保留，不吞内容', () => {
    const input = '.ok{color:red}@layer'
    expect(flattenCssLayers(input).css).toContain('.ok{color:red}')
  })
})