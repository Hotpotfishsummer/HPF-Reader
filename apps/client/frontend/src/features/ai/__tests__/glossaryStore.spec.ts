import { describe, expect, it } from 'vitest'
import type { GlossaryTerm } from '../../../api'
import { sortTerms, toTranslateGlossary, termIsOverridable } from '../glossaryStore'

/**
 * 术语表 store 的纯逻辑测试（task-24）。
 *
 * 重点：**来源优先级必须决定谁赢**。
 * 用户确认的译名被自动流水线的值覆盖，是"信任"级别的 bug ——
 * 用户会认为这个功能不可靠，再也不会手工确认任何术语。
 */

function term(over: Partial<GlossaryTerm> & { key: string }): GlossaryTerm {
  return {
    display: over.key,
    target: '译名-' + over.key,
    source: 'deterministic',
    ...over,
  }
}

describe('sortTerms（来源优先级排序）', () => {
  it('user_confirmed 排最前，deterministic 最后', () => {
    const input = [
      term({ key: 'c', source: 'deterministic' }),
      term({ key: 'a', source: 'user_confirmed' }),
      term({ key: 'b', source: 'llm_extracted' }),
    ]
    const out = sortTerms(input).map((t) => t.key)
    expect(out).toEqual(['a', 'b', 'c'])
  })

  it('同优先级按 display 字母序（稳定、可预期）', () => {
    const input = [
      term({ key: 'z', display: 'Zeta', source: 'user_confirmed' }),
      term({ key: 'a', display: 'Alpha', source: 'user_confirmed' }),
    ]
    expect(sortTerms(input).map((t) => t.display)).toEqual(['Alpha', 'Zeta'])
  })

  it('不修改入参（避免调用方数据被悄悄重排）', () => {
    const input = [term({ key: 'b' }), term({ key: 'a', source: 'user_confirmed' })]
    const snapshot = input.map((t) => t.key)
    sortTerms(input)
    expect(input.map((t) => t.key)).toEqual(snapshot)
  })
})

describe('toTranslateGlossary（display→target 映射）', () => {
  it('★ user_confirmed 的译名不能被低优先级覆盖', () => {
    // 同一个 display 出现两次，一条用户确认、一条自动规则。
    // 用户确认值必须赢 —— 否则用户改了译名又被流水线冲掉。
    const input = [
      term({ key: 'auto', display: 'Darcy', target: '自动译名', source: 'deterministic' }),
      term({ key: 'user', display: 'Darcy', target: '用户译名', source: 'user_confirmed' }),
    ]
    expect(toTranslateGlossary(input)).toEqual({ Darcy: '用户译名' })
  })

  it('★ 即使低优先级排在数组前面，也由高优先级赢（排序真的生效）', () => {
    const input = [
      term({ key: 'user', display: 'Darcy', target: '用户译名', source: 'user_confirmed' }),
      term({ key: 'llm', display: 'Darcy', target: 'LLM译名', source: 'llm_extracted' }),
    ]
    expect(toTranslateGlossary(input)).toEqual({ Darcy: '用户译名' })
  })

  it('aliases 也进映射（同一人物的其它写法都指向同一译名）', () => {
    const input = [
      term({ key: 'darcy', display: 'Mr. Darcy', target: '达西先生', source: 'user_confirmed', aliases: ['Darcy', '达西'] }),
    ]
    expect(toTranslateGlossary(input)).toEqual({
      'Mr. Darcy': '达西先生',
      Darcy: '达西先生',
      达西: '达西先生',
    })
  })

  it('空输入返回空对象', () => {
    expect(toTranslateGlossary([])).toEqual({})
  })
})

describe('termIsOverridable（会不会被自动流水线改）', () => {
  it('★ user_confirmed 不可覆盖（这是后端硬保证，UI 要据此提示）', () => {
    expect(termIsOverridable(term({ key: 'a', source: 'user_confirmed' }))).toBe(false)
  })

  it('llm_extracted / deterministic 可覆盖', () => {
    expect(termIsOverridable(term({ key: 'b', source: 'llm_extracted' }))).toBe(true)
    expect(termIsOverridable(term({ key: 'c', source: 'deterministic' }))).toBe(true)
  })
})