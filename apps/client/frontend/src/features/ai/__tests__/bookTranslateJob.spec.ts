import { describe, expect, it } from 'vitest'
import type { AiJob } from '../../../api'
import {
  bookTranslateResult,
  isJobPaused,
  jobProgress,
  mapJobStatus,
  shouldPollJob,
  type JobPhase,
} from '../jobState'

/**
 * 整书翻译任务状态机测试（task-23 的**第二个**易错点）。
 *
 * ★ 这里 import 的是**真实实现**（../jobState），不是复制一份逻辑来测自己。
 * 之前那一版把 mapStatus/isPaused 抄在测试里，那种测试永远不会红 ——
 * 实现改坏了它照样通过。这是本轮自查抓到的一个假测试。
 *
 * 核心断言：**`paused` 必须与 `failed` 区分开**。
 * 说成 failed → 用户以为任务坏了会重新发起 → 重复花钱；
 * 已完成块级译文其实好好躺在库里。
 */

function job(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: 'j1',
    kind: 'book_translate',
    status: 'running',
    ...overrides,
  } as AiJob
}

describe('mapJobStatus（真实实现）', () => {
  it('★ paused 映射成 paused，不是 failed', () => {
    expect(mapJobStatus('paused')).toBe('paused')
    expect(mapJobStatus('paused')).not.toBe('failed')
  })

  it('failed 才是 failed', () => {
    expect(mapJobStatus('failed')).toBe('failed')
  })

  it('六个状态都能正确映射（契约里的完整枚举）', () => {
    const all: AiJob['status'][] = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'paused']
    for (const status of all) {
      expect(mapJobStatus(status)).toBe(status)
    }
  })

  it('未知状态兜底为 running（不误报失败，也继续轮询）', () => {
    expect(mapJobStatus('weird' as AiJob['status'])).toBe('running')
  })
})

describe('isJobPaused（真实实现）', () => {
  it('phase = paused → 是暂停', () => {
    expect(isJobPaused('paused', null)).toBe(true)
  })

  it('★ result.paused = true 也算暂停（worker 可能在块结算时写入）', () => {
    expect(isJobPaused('running', job({ result: { paused: true } }))).toBe(true)
  })

  it('★ failed 即使 result.paused 为 true 也不算暂停（失败优先）', () => {
    expect(isJobPaused('failed', job({ status: 'failed', result: { paused: true } }))).toBe(false)
  })

  it('正常运行且无 paused 标记 → 不是暂停', () => {
    expect(isJobPaused('running', job({ result: { paused: false } }))).toBe(false)
  })

  it('result 为 null / 非对象时不崩', () => {
    expect(isJobPaused('running', job({ result: null }))).toBe(false)
    expect(isJobPaused('running', job({ result: undefined }))).toBe(false)
  })
})

describe('shouldPollJob（真实实现）', () => {
  it('★ paused 仍然要轮询（额度恢复后任务会自己继续）', () => {
    expect(shouldPollJob('paused')).toBe(true)
  })

  it('queued / running 要轮询', () => {
    expect(shouldPollJob('queued')).toBe(true)
    expect(shouldPollJob('running')).toBe(true)
  })

  it('终态不再轮询', () => {
    for (const phase of ['succeeded', 'failed', 'canceled', 'idle', 'submitting'] as JobPhase[]) {
      expect(shouldPollJob(phase)).toBe(false)
    }
  })
})

describe('jobProgress（真实实现）', () => {
  it('来自服务端 progress 字段', () => {
    expect(jobProgress(job({ progress: 0.42 }))).toBe(0.42)
  })

  it('缺失 / NaN / 越界都被夹到 [0,1]', () => {
    expect(jobProgress(null)).toBe(0)
    expect(jobProgress(job())).toBe(0)
    expect(jobProgress(job({ progress: Number.NaN }))).toBe(0)
    expect(jobProgress(job({ progress: 1.5 }))).toBe(1)
    expect(jobProgress(job({ progress: -0.3 }))).toBe(0)
  })

  it('★ paused 时进度**不归零**（已完成的块保留，进度必须还在）', () => {
    expect(jobProgress(job({ status: 'paused', progress: 0.6 }))).toBe(0.6)
  })
})

describe('bookTranslateResult（真实实现）', () => {
  it('取出块级明细', () => {
    const r = bookTranslateResult(job({
      result: { targetLang: 'zh-CN', model: 'x', totalChunks: 10, doneChunks: 4, translatedChars: 1000, reusedChunks: 2 },
    }))
    expect(r?.totalChunks).toBe(10)
    expect(r?.doneChunks).toBe(4)
    expect(r?.reusedChunks).toBe(2)
  })

  it('result 缺失时返回 null（不返回空对象，避免 UI 显示 0/0）', () => {
    expect(bookTranslateResult(job({ result: null }))).toBeNull()
    expect(bookTranslateResult(null)).toBeNull()
  })
})
