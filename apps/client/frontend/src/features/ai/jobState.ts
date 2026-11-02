import type { AiJob, BookTranslateResult } from '../../api'

/**
 * 整书翻译任务的**纯状态逻辑**（task-23）。
 *
 * 刻意从 composable 里抽出来：这段逻辑是"paused 不能显示成 failed"的落点，
 * 必须能被直接单测。写在 composable 里就只能靠渲染测试间接验证，
 * 而渲染测试很难断言"文案语义对不对"。
 */

export type JobPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled'

/** 服务端 status → 本地 phase。六个状态都必须显式映射（不要 default 兜成 running）。 */
export function mapJobStatus(status: AiJob['status']): JobPhase {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    case 'paused':
      return 'paused'
    default:
      // 未知状态：当作"仍在进行"最安全（不会误报失败，也会继续轮询）。
      return 'running'
  }
}

/** 从 result 里安全地取 paused 标记（result 是 json.RawMessage，结构未知）。 */
export function resultPaused(job: AiJob | null): boolean {
  const raw = job?.result
  if (typeof raw !== 'object' || raw === null) return false
  return (raw as { paused?: unknown }).paused === true
}

/**
 * ★ 是否应按"暂停（可续跑）"呈现。
 *
 * 判据：phase 已是 paused，**或** result.paused === true 且不是 failed。
 * 关键约束：**failed 永远优先** —— 真失败就是失败，不能被 paused 标记掩盖。
 */
export function isJobPaused(phase: JobPhase, job: AiJob | null): boolean {
  if (phase === 'failed') return false
  if (phase === 'paused') return true
  return resultPaused(job)
}

/**
 * 是否应继续轮询。
 *
 * ★ paused **要**继续轮询：额度恢复后任务会自动往下跑，
 * 如果停了轮询，用户就永远看不到它恢复。
 */
export function shouldPollJob(phase: JobPhase): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'paused'
}

/** 服务端进度，夹到 [0,1]；缺失/NaN 都当 0（进度条不能画到框外）。 */
export function jobProgress(job: AiJob | null): number {
  const p = job?.progress
  if (typeof p !== 'number' || Number.isNaN(p)) return 0
  return Math.max(0, Math.min(1, p))
}

/** 安全地取 book_translate 的 result（不是对象就返回 null）。 */
export function bookTranslateResult(job: AiJob | null): BookTranslateResult | null {
  const raw = job?.result
  if (typeof raw !== 'object' || raw === null) return null
  return raw as BookTranslateResult
}
