import { describe, expect, it } from 'vitest'
import { QuotaError } from '../../../api'
import {
  describeQuota,
  formatCount,
  formatCountdown,
  formatQuotaMessage,
  formatResetTime,
  isExhausted,
  quotaFromError,
  usedPercent,
} from '../quota'
import type { AiUsage } from '../../../api'

/**
 * 配额文案测试（task-23 的第一个易错点）。
 *
 * 断言的不是"有没有文案"，而是**文案有没有说对**：
 *   - 必须区分 calls / tokens 维度（否则用户不知道是什么用完了）
 *   - 必须给出恢复时间（否则用户只能干等或盲目重试）
 *   - 必须**不**出现"重试/网络"这类误导性措辞（重试永远不会成功）
 */

function quota(overrides: Partial<{ dimension: 'calls' | 'tokens'; limit: number; used: number; resetAt: string }> = {}): QuotaError {
  return new QuotaError({
    dimension: overrides.dimension ?? 'calls',
    limit: overrides.limit ?? 100,
    used: overrides.used ?? 100,
    resetAt: overrides.resetAt ?? '2026-12-01T00:00:00Z',
  })
}

describe('QuotaError', () => {
  it('保留结构化字段（不是拼好的字符串）', () => {
    const err = quota({ dimension: 'tokens', limit: 500_000, used: 500_000 })
    expect(err.dimension).toBe('tokens')
    expect(err.limit).toBe(500_000)
    expect(err.used).toBe(500_000)
    expect(err.name).toBe('QuotaError')
  })

  it('msUntilReset 计算到重置时刻的毫秒数', () => {
    const err = quota({ resetAt: '2026-12-01T00:00:00Z' })
    const now = Date.parse('2026-11-15T00:00:00Z')
    expect(err.msUntilReset(now)).toBe(16 * 24 * 3600 * 1000)
  })

  it('resetAt 已过期时 msUntilReset 返回 0（不返回负数）', () => {
    const err = quota({ resetAt: '2026-01-01T00:00:00Z' })
    expect(err.msUntilReset(Date.parse('2026-12-01T00:00:00Z'))).toBe(0)
  })

  it('resetAt 无法解析时 msUntilReset 返回 0 而不是 NaN', () => {
    const err = quota({ resetAt: 'not-a-date' })
    expect(err.msUntilReset()).toBe(0)
  })
})

describe('quotaFromError', () => {
  it('QuotaError 原样返回', () => {
    const err = quota()
    expect(quotaFromError(err)).toBe(err)
  })

  it('普通 Error / null / 字符串都返回 null（不能被当成配额错误）', () => {
    expect(quotaFromError(new Error('network down'))).toBeNull()
    expect(quotaFromError(null)).toBeNull()
    expect(quotaFromError('quota')).toBeNull()
  })
})

describe('describeQuota（结构化文案）', () => {
  it('★ calls 维度说「调用次数」，不说「token」', () => {
    const parts = describeQuota(quota({ dimension: 'calls' }), Date.parse('2026-11-15T00:00:00Z'))
    expect(parts.title).toContain('调用次数')
    expect(parts.title).not.toContain('token')
  })

  it('★ tokens 维度说「token 额度」，不说「调用次数」', () => {
    const parts = describeQuota(quota({ dimension: 'tokens' }), Date.parse('2026-11-15T00:00:00Z'))
    expect(parts.title).toContain('token')
    expect(parts.title).not.toContain('调用次数')
  })

  it('detail 里带恢复时间与用量', () => {
    const parts = describeQuota(
      quota({ dimension: 'calls', limit: 200, used: 200, resetAt: '2026-12-01T00:00:00Z' }),
      Date.parse('2026-11-15T00:00:00Z'),
    )
    expect(parts.detail).toContain('200')
    expect(parts.detail).toMatch(/恢复|继续/)
  })

  it('★ 文案里不出现「重试」「网络」这类误导措辞', () => {
    for (const dimension of ['calls', 'tokens'] as const) {
      const msg = formatQuotaMessage(quota({ dimension }), Date.parse('2026-11-15T00:00:00Z'))
      expect(msg).not.toContain('重试')
      expect(msg).not.toContain('网络')
      expect(msg).not.toContain('请稍后')
    }
  })
})

describe('时间格式化', () => {
  it('formatResetTime 输出 MM-DD HH:mm', () => {
    const out = formatResetTime('2026-12-01T00:00:00Z')
    expect(out).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('formatResetTime 对坏输入原样返回（不抛、不显示 Invalid Date）', () => {
    expect(formatResetTime('bogus')).toBe('bogus')
    expect(formatResetTime('bogus')).not.toContain('NaN')
  })

  it('formatCountdown 给出人类可读时长', () => {
    const now = Date.parse('2026-11-30T00:00:00Z')
    // 5 小时 → 小时级；24 小时以上 → 天级（边界在 24h，正好 24h 算「天」）
    expect(formatCountdown('2026-11-30T05:00:00Z', now)).toContain('小时')
    expect(formatCountdown('2026-12-05T00:00:00Z', now)).toContain('天')
  })

  it('formatCountdown 不到 1 小时时说「不到 1 小时」', () => {
    const now = Date.parse('2026-11-30T00:00:00Z')
    expect(formatCountdown('2026-11-30T00:30:00Z', now)).toContain('不到 1 小时')
  })

  it('formatCountdown 已过期时说「即将恢复」', () => {
    expect(formatCountdown('2026-01-01T00:00:00Z', Date.parse('2026-12-01T00:00:00Z'))).toBe('即将恢复')
  })
})

describe('配额展示工具', () => {
  it('usedPercent 正常计算', () => {
    expect(usedPercent({ used: 50, quota: 100, remaining: 50 })).toBe(50)
    expect(usedPercent({ used: 100, quota: 100, remaining: 0 })).toBe(100)
  })

  it('★ quota 为 0 时不产生 NaN（除零保护）', () => {
    const pct = usedPercent({ used: 0, quota: 0, remaining: 0 })
    expect(Number.isNaN(pct)).toBe(false)
    expect(pct).toBe(100)
  })

  it('formatCount 把大数字转成「万」', () => {
    expect(formatCount(12_000)).toBe('1.2万')
    expect(formatCount(1_000_000)).toBe('100万')
    expect(formatCount(500)).toBe('500')
  })

  it('isExhausted：任一维度用满即耗尽', () => {
    const base: AiUsage = {
      periodStart: '2026-11-01T00:00:00Z',
      resetAt: '2026-12-01T00:00:00Z',
      calls: { used: 10, quota: 100, remaining: 90 },
      tokens: { used: 1000, quota: 5000, remaining: 4000 },
    }
    expect(isExhausted(base)).toBe(false)
    expect(isExhausted({ ...base, calls: { used: 100, quota: 100, remaining: 0 } })).toBe(true)
    expect(isExhausted({ ...base, tokens: { used: 5000, quota: 5000, remaining: 0 } })).toBe(true)
  })
})