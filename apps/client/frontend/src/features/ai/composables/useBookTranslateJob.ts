import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { AiJob, BookTranslateResult } from '../../../api'
import { getAiApi } from '../runtime'
import { formatQuotaMessage, quotaFromError } from '../quota'
import {
  bookTranslateResult,
  isJobPaused,
  jobProgress,
  mapJobStatus,
  shouldPollJob,
  type JobPhase,
} from '../jobState'

/**
 * 整书翻译任务的状态机（task-23 的**第二个**易错点）。
 *
 * 核心区分：
 *
 *   `paused` ≠ `failed`
 *
 *   - `paused`：**额度不足**，已完成块级译文全部保留，下个周期自动继续。
 *     UI 必须说"暂停 / 额度恢复后自动继续"，**不能**说失败 ——
 *     说失败会吓到用户，还会让他以为要重新花钱。
 *   - `failed`：真出错了，需要用户重新发起。
 *
 * 进度必须来自服务端的 `progress`（已完成块数 / 总块数），
 * 不能用前端定时器假装推进 —— 那种假进度条在 paused 时还会继续爬，最误导人。
 */

export type { JobPhase }

/** 轮询间隔：任务通常跑几分钟到几十分钟，2s 足够且不会打爆后端。 */
const POLL_INTERVAL_MS = 2_000
/** 连续失败多少次后停止轮询（避免网络断了还在无限请求）。 */
const MAX_POLL_FAILURES = 5

export function useBookTranslateJob() {
  const job = shallowRef<AiJob | null>(null)
  const phase = ref<JobPhase>('idle')
  const errorText = ref('')
  const quotaMessage = ref('')
  const pollFailures = ref(0)

  let timer: ReturnType<typeof setTimeout> | null = null
  /** 组件卸载 / 重新开始时作废在途轮询。 */
  let generation = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  onScopeDispose(() => {
    generation += 1
    clearTimer()
  })

  /** 服务端进度（0~1）。没有任务时为 0。 */
  const progress = computed(() => jobProgress(job.value))

  const progressPercent = computed(() => Math.round(progress.value * 100))

  /** book_translate 的 result（块数、复用数、一致性扫描）。 */
  const result = computed<BookTranslateResult | null>(() => bookTranslateResult(job.value))

  /**
   * ★ 是否为"暂停"（可续跑）。判据见 jobState.ts（那里有单测）。
   */
  const isPaused = computed(() => isJobPaused(phase.value, job.value))

  const isFailed = computed(() => phase.value === 'failed')

  /** 是否应该继续轮询。paused 也要继续轮询 —— 额度恢复后任务会自己继续。 */
  const shouldPoll = computed(() => shouldPollJob(phase.value))

  function applyJob(next: AiJob): void {
    job.value = next
    phase.value = mapJobStatus(next.status)
    if (next.status === 'failed' && next.error) errorText.value = next.error
    if (next.status === 'succeeded') errorText.value = ''
  }

  async function poll(gen: number): Promise<void> {
    const current = job.value
    if (!current || gen !== generation) return
    try {
      const next = await getAiApi().getJob(current.id)
      if (gen !== generation) return
      pollFailures.value = 0
      applyJob(next)
      if (shouldPoll.value) schedulePoll(gen)
    } catch (error) {
      if (gen !== generation) return
      const quota = quotaFromError(error)
      if (quota) {
        // 轮询本身也可能 429（虽然概率低）：按配额呈现，不当作网络错误。
        phase.value = 'paused'
        quotaMessage.value = formatQuotaMessage(quota)
        schedulePoll(gen)
        return
      }
      pollFailures.value += 1
      if (pollFailures.value >= MAX_POLL_FAILURES) {
        errorText.value = error instanceof Error ? error.message : String(error)
        return
      }
      schedulePoll(gen)
    }
  }

  function schedulePoll(gen: number): void {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void poll(gen)
    }, POLL_INTERVAL_MS)
  }

  /** 提交任务并开始轮询。 */
  async function start(bookId: string, targetLang: string): Promise<void> {
    clearTimer()
    generation += 1
    const gen = generation
    phase.value = 'submitting'
    errorText.value = ''
    quotaMessage.value = ''
    job.value = null
    pollFailures.value = 0

    try {
      const created = await getAiApi().createBookTranslateJob(bookId, targetLang)
      if (gen !== generation) return
      applyJob(created)
      if (shouldPoll.value) schedulePoll(gen)
    } catch (error) {
      if (gen !== generation) return
      const quota = quotaFromError(error)
      if (quota) {
        // ★ 创建任务时额度不足：任务**没有被创建**（契约写明 429 = 任务未被创建）。
        phase.value = 'paused'
        quotaMessage.value = formatQuotaMessage(quota)
        return
      }
      phase.value = 'failed'
      errorText.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** 停止轮询（不取消服务端任务）。 */
  function stopPolling(): void {
    generation += 1
    clearTimer()
  }

  function reset(): void {
    stopPolling()
    job.value = null
    phase.value = 'idle'
    errorText.value = ''
    quotaMessage.value = ''
    pollFailures.value = 0
  }

  return {
    job,
    phase,
    progress,
    progressPercent,
    result,
    isPaused,
    isFailed,
    shouldPoll,
    errorText,
    quotaMessage,
    start,
    stopPolling,
    reset,
  }
}

export type BookTranslateJobController = ReturnType<typeof useBookTranslateJob>