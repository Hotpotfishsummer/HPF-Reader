import { QuotaError } from '../../api'
import type { AiUsage, QuotaDimension } from '../../api'

/**
 * 配额文案（task-23 的**第一个**易错点）。
 *
 * 硬规则：**429 不能显示成网络错误**。
 *   - "网络出错，请重试" → 用户会一直重试，但重试**永远不会成功**
 *     （后端契约写得很清楚：这不是限流，必须等 resetAt 或提高配额）。
 *   - 正确文案要回答两个问题：**哪个维度**没了、**什么时候**恢复。
 *
 * 维度差异也必须说清楚，否则用户看不懂：
 *   - `calls`：调用次数用完（高频小请求，比如反复划词）
 *   - `tokens`：token 额度用完（通常是跑了整书翻译这种大任务）
 */

/** 从任意错误里提取配额信息；不是配额错误就返回 null。 */
export function quotaFromError(error: unknown): QuotaError | null {
  if (error instanceof QuotaError) return error
  return null
}

/** 把 ISO 时间格式化成"本地时间 MM-DD HH:mm"。无法解析时原样返回。 */
export function formatResetTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 距重置的粗粒度时长（"约 3 天"/"约 2 小时"），用于一眼可读。 */
export function formatCountdown(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const ms = at - now
  if (ms <= 0) return '即将恢复'
  const hours = ms / 3_600_000
  if (hours < 1) return '不到 1 小时'
  if (hours < 24) return `约 ${Math.ceil(hours)} 小时`
  return `约 ${Math.ceil(hours / 24)} 天`
}

export interface QuotaMessageParts {
  /** 一句话标题："本月翻译次数已用完" / "本月 token 额度已用完"。 */
  title: string
  /** 补充说明：什么时候恢复 + 恢复后能做什么。 */
  detail: string
}

/** 结构化文案（组件用；便于测试断言，不用去解析整段字符串）。 */
export function describeQuota(error: QuotaError, now: number = Date.now()): QuotaMessageParts {
  const dimensionLabel = error.dimension === 'calls' ? '调用次数' : 'token 额度'
  const reset = formatResetTime(error.resetAt)
  const countdown = formatCountdown(error.resetAt, now)
  const title = `本周期${dimensionLabel}已用完`
  const detail =
    (countdown ? `${countdown}后自动恢复（${reset}）` : `将于 ${reset} 恢复`)
    + `；已用 ${error.used} / ${error.limit}`
  return { title, detail }
}

/** 单行版本（气泡里空间有限，一行说清）。 */
export function formatQuotaMessage(error: QuotaError, now: number = Date.now()): string {
  const { title, detail } = describeQuota(error, now)
  return `${title}：${detail}`
}

/**
 * 配额条用的百分比。`quota <= 0` 时按 100%（用满），避免除零得到 NaN 宽度。
 */
export function usedPercent(dimension: QuotaDimension): number {
  if (dimension.quota <= 0) return 100
  const pct = (dimension.used / dimension.quota) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/** 展示用的紧凑数字（12000 → "1.2万"），中文语境比 12,000 更好读。 */
export function formatCount(n: number): string {
  if (n >= 10_000) {
    const wan = n / 10_000
    return `${wan >= 10 ? Math.round(wan) : Number(wan.toFixed(1))}万`
  }
  return String(n)
}

/** 配额是否已耗尽（任一维度用满）。 */
export function isExhausted(usage: AiUsage): boolean {
  return usage.calls.remaining <= 0 || usage.tokens.remaining <= 0
}
