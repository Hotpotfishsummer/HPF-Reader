import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProgressInput } from '@/features/sync/types'
import {
  PROGRESS_SYNC_DELTA,
  PROGRESS_SYNC_INTERVAL_MS,
  buildReaderLocator,
  clearFlushedProgress,
  createProgressSync,
  lookupServerBookId,
  remoteIsPreferred,
  shouldFlushProgress,
} from '../progressSync'
import {
  normalizeContentHash,
  progressionToPercent,
  resolveReaderProgress,
  resolveRemoteProgress,
  type ProgressLocatorLike,
} from '../progressStore'

/**
 * task-4 验收项：进度入队的节流 / explicitRewind / 无映射不发请求 / 远端进度优先。
 *
 * 全部使用注入的假引擎与假时钟 —— 不打真网络，也不依赖真实单例。
 */

// ---------------- 夹具 ----------------

const SERVER_BOOK_ID = '11111111-2222-4333-8444-555555555555'
const CONTENT_HASH = 'a'.repeat(64)

/** 假引擎：只记录 enqueueProgress 的入参。 */
function createFakeEngine(options: {
  contentHash?: string | null
  serverBookId?: string
  progress?: { locator: ProgressLocatorLike | null; totalProgression: number } | null
} = {}) {
  const enqueued: ProgressInput[] = []
  const hash = options.contentHash === undefined ? CONTENT_HASH : options.contentHash
  const bookId = options.serverBookId ?? SERVER_BOOK_ID
  const progress = options.progress === undefined
    ? {
        locator: {
          href: 'text/chapter3.xhtml',
          type: 'application/epub+zip',
          locations: { fragments: ['epubcfi(/6/8[chap3]!/4/2/1:0)'], progression: 0.42 },
        },
        totalProgression: 0.42,
      }
    : options.progress
  return {
    enqueued,
    local: {
      books: hash === null ? {} : { [bookId]: { id: bookId, contentHash: hash } },
      progress: progress === undefined || progress === null ? {} : { [bookId]: progress },
    },
    enqueueProgress(input: ProgressInput) {
      enqueued.push(input)
      return input
    },
  }
}

function createClock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance(ms: number) {
      value += ms
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  clearFlushedProgress()
})

// ---------------- 纯节流判定 ----------------

describe('shouldFlushProgress（纯节流规则）', () => {
  it('首次（无历史）一定通过', () => {
    expect(shouldFlushProgress({ sinceLastMs: null, percentDelta: 0, explicit: false })).toBe(true)
  })

  it('≥2s 通过；<2s 且进度变化 <0.5% 被节流', () => {
    expect(
      shouldFlushProgress({ sinceLastMs: PROGRESS_SYNC_INTERVAL_MS, percentDelta: 0, explicit: false }),
    ).toBe(true)
    expect(
      shouldFlushProgress({ sinceLastMs: PROGRESS_SYNC_INTERVAL_MS - 1, percentDelta: 0.001, explicit: false }),
    ).toBe(false)
  })

  it('进度变化达到阈值（0.5%）通过，即使还在时间窗口内', () => {
    expect(
      shouldFlushProgress({ sinceLastMs: 10, percentDelta: PROGRESS_SYNC_DELTA, explicit: false }),
    ).toBe(true)
    expect(
      shouldFlushProgress({ sinceLastMs: 10, percentDelta: -PROGRESS_SYNC_DELTA, explicit: false }),
    ).toBe(true)
  })

  it('用户显式跳转永远立即通过', () => {
    expect(shouldFlushProgress({ sinceLastMs: 1, percentDelta: 0, explicit: true })).toBe(true)
  })
})

// ---------------- 节流 / explicitRewind / 无映射 ----------------

describe('createProgressSync（入队节流与显式回退）', () => {
  it('2s 内的自然翻页被节流，时间到了才入队', () => {
    const engine = createFakeEngine()
    const clock = createClock()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      now: clock.now,
    })

    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.1, index: 0 })).not.toBeNull()
    expect(engine.enqueued).toHaveLength(1)

    clock.advance(500)
    expect(sync.handleRelocate('local-book', { cfi: 'cfi-2', fraction: 0.101, index: 1 })).toBeNull()
    expect(engine.enqueued).toHaveLength(1)

    clock.advance(1600) // 累计 2100ms ≥ 2000ms
    expect(sync.handleRelocate('local-book', { cfi: 'cfi-3', fraction: 0.102, index: 2 })).not.toBeNull()
    expect(engine.enqueued).toHaveLength(2)
  })

  it('节流窗口内进度跳变 ≥0.5% 时立即入队', () => {
    const engine = createFakeEngine()
    const clock = createClock()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      now: clock.now,
    })

    sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.1 })
    clock.advance(200)
    sync.handleRelocate('local-book', { cfi: 'cfi-2', fraction: 0.12 }) // +2%
    expect(engine.enqueued).toHaveLength(2)
  })

  it('无映射（书还没上传到云端）时不发请求，也不伪造 serverBookId', () => {
    const engine = createFakeEngine({ contentHash: null })
    const onSkip = vi.fn()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      onSkip,
    })

    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.3 })).toBeNull()
    expect(engine.enqueued).toHaveLength(0)
    expect(onSkip).toHaveBeenCalledWith('unmapped')
  })

  it('contentHash 对不上任何云端书时同样跳过', () => {
    const engine = createFakeEngine({ contentHash: 'b'.repeat(64) })
    const sync = createProgressSync({ getContentHash: () => CONTENT_HASH, getEngine: () => engine })

    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.3 })).toBeNull()
    expect(engine.enqueued).toHaveLength(0)
  })

  it('节流跳过的请求不污染节流窗口：后续映射成功的请求仍能发出', () => {
    const engine = createFakeEngine({ contentHash: null })
    const clock = createClock()
    let hash: string | null = CONTENT_HASH
    const sync = createProgressSync({
      getContentHash: () => hash,
      getEngine: () => engine,
      now: clock.now,
    })

    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.3 })).toBeNull()
    hash = CONTENT_HASH
    engine.local.books[SERVER_BOOK_ID] = { id: SERVER_BOOK_ID, contentHash: CONTENT_HASH }
    // 位置没变也应发出（上一次跳过了，没有"已发送"记录）。
    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.3 })).not.toBeNull()
    expect(engine.enqueued).toHaveLength(1)
  })

  it('显式跳转立即入队，且真实回退时带 explicitRewind: true', () => {
    const engine = createFakeEngine()
    const clock = createClock()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      now: clock.now,
    })

    sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.5 })
    expect(engine.enqueued[0]?.explicitRewind).toBe(false)

    clock.advance(100)
    sync.markExplicitJump()
    sync.handleRelocate('local-book', { cfi: 'cfi-back', fraction: 0.2 })
    expect(engine.enqueued).toHaveLength(2)
    expect(engine.enqueued[1]?.explicitRewind).toBe(true)
    expect(engine.enqueued[1]?.bookId).toBe(SERVER_BOOK_ID)
    expect(engine.enqueued[1]?.contentHash).toBe(CONTENT_HASH)
  })

  it('显式向前跳转不带 explicitRewind（不能让服务端放开最远进度）', () => {
    const engine = createFakeEngine()
    const clock = createClock()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      now: clock.now,
    })

    sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.1 })
    clock.advance(100)
    sync.markExplicitJump()
    sync.handleRelocate('local-book', { cfi: 'cfi-9', fraction: 0.9 })
    expect(engine.enqueued[1]?.explicitRewind).toBe(false)
  })

  it('未登录时不碰引擎（纯本地）', () => {
    const engine = createFakeEngine()
    const onSkip = vi.fn()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      isLoggedIn: () => false,
      onSkip,
    })

    expect(sync.handleRelocate('local-book', { cfi: 'cfi-1', fraction: 0.3 })).toBeNull()
    expect(engine.enqueued).toHaveLength(0)
    expect(onSkip).toHaveBeenCalledWith('not-logged-in')
  })

  it('reset 之后换书：旧位置不会被带到新书', () => {
    const engine = createFakeEngine()
    const clock = createClock()
    const sync = createProgressSync({
      getContentHash: () => CONTENT_HASH,
      getEngine: () => engine,
      now: clock.now,
    })

    sync.handleRelocate('book-a', { cfi: 'cfi-a', fraction: 0.3 })
    expect(sync.hasPending()).toBe(true)
    sync.reset()
    expect(sync.hasPending()).toBe(false)
    expect(sync.flush()).toBeNull()
    expect(engine.enqueued).toHaveLength(1)
  })
})

describe('lookupServerBookId（contentHash → server bookId 映射）', () => {
  it('归一化 sha256: 前缀与大小写后仍能匹配', () => {
    const engine = createFakeEngine({ contentHash: 'sha256:' + CONTENT_HASH.toUpperCase() })
    expect(lookupServerBookId(CONTENT_HASH, engine)).toBe(SERVER_BOOK_ID)
    expect(normalizeContentHash('sha256:ABCD')).toBe('abcd')
  })

  it('没有 contentHash / 没有引擎时返回 null', () => {
    const engine = createFakeEngine()
    expect(lookupServerBookId(null, engine)).toBeNull()
    expect(lookupServerBookId(CONTENT_HASH, undefined)).toBeNull()
  })
})

describe('buildReaderLocator', () => {
  it('CFI 放进 locations.fragments，href 用章节序号占位', () => {
    const locator = buildReaderLocator({ cfi: 'epubcfi(/6/4!/4/2)', fraction: 0.25, index: 2 })
    expect(locator.type).toBe('application/epub+zip')
    expect(locator.locations?.fragments).toEqual(['epubcfi(/6/4!/4/2)'])
    expect(locator.locations?.progression).toBe(0.25)
    expect(locator.href).toContain('2')
  })
})

// ---------------- 远端进度解析与优先级 ----------------

describe('resolveRemoteProgress / progressionToPercent', () => {
  it('按 contentHash 匹配 server bookId 并取出 locator 与 totalProgression', () => {
    const engine = createFakeEngine()
    const remote = resolveRemoteProgress(CONTENT_HASH, engine)
    expect(remote?.serverBookId).toBe(SERVER_BOOK_ID)
    expect(remote?.locator.href).toBe('text/chapter3.xhtml')
    expect(remote?.progression).toBe(42)
  })

  it('投影里没有进度 / locator 缺 href 时按"没有云端进度"处理', () => {
    const noProgress = createFakeEngine({ progress: null })
    expect(resolveRemoteProgress(CONTENT_HASH, noProgress)).toBeNull()

    const brokenLocator = createFakeEngine({
      progress: { locator: { href: undefined as unknown as string, type: 'x' }, totalProgression: 0.3 },
    })
    expect(resolveRemoteProgress(CONTENT_HASH, brokenLocator)).toBeNull()
  })

  it('progressionToPercent 夹在 0..100 且四舍五入', () => {
    expect(progressionToPercent(0.421)).toBe(42)
    expect(progressionToPercent(-1)).toBe(0)
    expect(progressionToPercent(2)).toBe(100)
    expect(progressionToPercent(Number.NaN)).toBe(0)
  })
})

describe('resolveReaderProgress（打开书时的进度优先级）', () => {
  const remoteEngine = createFakeEngine()

  it('本地没有记录时用云端权威进度', async () => {
    const resolved = await resolveReaderProgress({
      bookId: 'local-book',
      contentHash: CONTENT_HASH,
      engine: remoteEngine,
    })
    expect(resolved.source).toBe('remote')
    expect(resolved.locator).toBe('epubcfi(/6/8[chap3]!/4/2/1:0)')
    expect(resolved.fraction).toBe(42)
    expect(resolved.remote?.serverBookId).toBe(SERVER_BOOK_ID)
  })

  it('云端比本地更远时用云端（跨设备续读）', async () => {
    const resolved = await resolveReaderProgress({
      bookId: 'local-book',
      contentHash: CONTENT_HASH,
      engine: remoteEngine,
      readLocal: () => 'epubcfi(/6/2!/4/2)',
      readFraction: () => 10,
    })
    expect(resolved.source).toBe('remote')
    expect(resolved.locator).toBe('epubcfi(/6/8[chap3]!/4/2/1:0)')
  })

  it('本地更远时保留本地（刚翻的一页不能被云端回退）', async () => {
    const resolved = await resolveReaderProgress({
      bookId: 'local-book',
      contentHash: CONTENT_HASH,
      engine: remoteEngine,
      readLocal: () => 'epubcfi(/6/20!/4/2)',
      readFraction: () => 80,
    })
    expect(resolved.source).toBe('local')
    expect(resolved.locator).toBe('epubcfi(/6/20!/4/2)')
  })

  it('云端与本地都没有时读 platform，再没有就从头打开', async () => {
    const engineWithNoProgress = createFakeEngine({ progress: null })
    const platform = {
      library: {
        getProgress: vi.fn().mockResolvedValue('epubcfi(/6/2!/4/2)'),
      },
    } as never

    const fromPlatform = await resolveReaderProgress({
      bookId: 'local-book',
      contentHash: CONTENT_HASH,
      engine: engineWithNoProgress,
      platform,
    })
    expect(fromPlatform.source).toBe('platform')
    expect(fromPlatform.locator).toBe('epubcfi(/6/2!/4/2)')

    const empty = await resolveReaderProgress({
      bookId: 'local-book',
      contentHash: null,
      engine: undefined,
    })
    expect(empty.source).toBe('local')
    expect(empty.locator).toBe('')
  })
})

describe('remoteIsPreferred（辅助判定）', () => {
  it('本地无记录或云端更远时返回 true', () => {
    const remote = resolveRemoteProgress(CONTENT_HASH, createFakeEngine())
    expect(remoteIsPreferred(remote, 0)).toBe(true)
    expect(remoteIsPreferred(remote, 41)).toBe(true)
    expect(remoteIsPreferred(remote, 42)).toBe(false)
    expect(remoteIsPreferred(null, 0)).toBe(false)
  })
})
