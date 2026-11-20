import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationCreate, AnnotationDto } from '@/api/contract'
import {
  mergeRemoteWithLocal,
  newAnnotationId,
  pendingAnnotationIds,
  readLocalAnnotations,
  useAnnotations,
  type AnnotationEngineLike,
  type AnnotationItem,
} from '../annotationStore'

/**
 * task-4 验收项：标注走引擎 outbox —— 离线入队、pull 合并保留待推送本地条目、删除走 delete op。
 *
 * 全部使用注入的假引擎 / 假 storage，不打真网络。
 */

// ---------------- 夹具 ----------------

interface FakeEngineState {
  enqueued: { bookId: string; annotationId: string; input?: AnnotationCreate }[]
  runs: number
  localAnnotations: Record<string, AnnotationDto>
  outboxOps: { entity: string; entityId: string; kind: string; bookId?: string | null }[]
}

/**
 * 假引擎。
 *
 * `onRun` 模拟"同步 run 之后本地投影变成什么样"：
 * 默认什么都不做（模拟**离线**：推不上去也拉不下来）。
 */
function createFakeAnnotationEngine(options: {
  localAnnotations?: Record<string, AnnotationDto>
  outboxOps?: { entity: string; entityId: string; kind: string; bookId?: string | null }[]
  /** 引擎自报状态；缺省 = "投影可信"（测试假引擎语义）。 */
  status?: { phase: string; lastError: { code: string; message: string } | null }
  onRun?: (state: FakeEngineState) => void
} = {}) {
  const state: FakeEngineState = {
    enqueued: [],
    runs: 0,
    localAnnotations: options.localAnnotations ?? {},
    outboxOps: options.outboxOps ?? [],
  }
  const engine: AnnotationEngineLike = {
    enqueueAnnotation(bookId, annotationId, input) {
      state.enqueued.push({ bookId, annotationId, input })
      // ★ 真实引擎的 outbox 会立刻收下这条 op（enqueueAnnotation 内部 outbox.enqueue）。
      //   假引擎必须同样反映，否则 refresh 合并时 pendingIds 是空的，
      //   会把"刚本地新建、还没推上去"的条目当成"服务端已删除"丢掉。
      state.outboxOps.push({
        entity: 'annotation',
        entityId: annotationId,
        kind: input === undefined ? 'delete' : 'upsert',
        bookId,
      })
      return { bookId, annotationId }
    },
    async run() {
      state.runs += 1
      options.onRun?.(state)
      return {}
    },
    outbox: { list: () => state.outboxOps.map((op) => ({ op })) },
    local: { annotations: state.localAnnotations },
    ...(options.status ? { getStatus: () => options.status! } : {}),
  }
  return { engine, state }
}

const BOOK_ID = 'local-book-1'

function makeDto(overrides: Partial<AnnotationDto> = {}): AnnotationDto {
  return {
    id: 'remote-1',
    bookId: BOOK_ID,
    type: 'highlight',
    color: '#fef08a',
    text: '远端文本',
    note: null,
    locator: {
      href: 'chap1.xhtml',
      type: 'application/epub+zip',
      title: '第一章',
      locations: { fragments: ['cfi-remote-1'], progression: 0.2 },
    },
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  } as AnnotationDto
}

function makeItem(overrides: Partial<AnnotationItem> = {}): AnnotationItem {
  return {
    id: 'local-1',
    bookId: BOOK_ID,
    type: 'highlight',
    text: '本地文本',
    cfi: 'cfi-local-1',
    createdAt: '2026-11-02T00:00:00Z',
    ...overrides,
  }
}

/**
 * 让 `watch(getBookId, refresh, { immediate: true })` 发起的那次 refresh 跑完。
 *
 * 不这么做的话，"新建/修改"会与 setup 时的初始 refresh 交错，
 * 断言就变成了对微任务调度顺序的断言 —— 测试会变得难以理解且易碎。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  localStorage.clear()
})

// ---------------- 纯合并规则 ----------------

describe('mergeRemoteWithLocal（pull 合并规则）', () => {
  it('远端条目优先，远端没有且不在 outbox 的本地条目被丢弃（墓碑生效，不复活）', () => {
    const merged = mergeRemoteWithLocal({
      remoteItems: [makeItem({ id: 'r1', cfi: 'cfi-r1' })],
      localItems: [makeItem({ id: 'l-gone' })],
      pendingIds: new Set(),
    })
    expect(merged.map((it) => it.id)).toEqual(['r1'])
  })

  it('远端没有但仍在 outbox 待推送的本地条目必须保留（核心：不能丢离线新建）', () => {
    const merged = mergeRemoteWithLocal({
      remoteItems: [makeItem({ id: 'r1', cfi: 'cfi-r1' })],
      localItems: [makeItem({ id: 'l-pending' })],
      pendingIds: new Set(['l-pending']),
    })
    expect(merged.map((it) => it.id).sort()).toEqual(['l-pending', 'r1'])
  })

  it('远端里 cfi 为空的半成品不展示，但本地待推送副本保留', () => {
    const merged = mergeRemoteWithLocal({
      remoteItems: [
        makeItem({ id: 'r1', cfi: '' }),
        makeItem({ id: 'r2', cfi: 'cfi-r2' }),
      ],
      localItems: [makeItem({ id: 'l-pending' })],
      pendingIds: new Set(['l-pending']),
    })
    expect(merged.map((it) => it.id).sort()).toEqual(['l-pending', 'r2'])
  })

  it('同一 id 在远端与本地都有时只保留远端（服务端是权威）', () => {
    const merged = mergeRemoteWithLocal({
      remoteItems: [makeItem({ id: 'same', cfi: 'cfi-remote', text: '远端' })],
      localItems: [makeItem({ id: 'same', cfi: 'cfi-local', text: '本地' })],
      pendingIds: new Set(['same']),
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('远端')
  })
})

describe('pendingAnnotationIds', () => {
  it('只收 annotation 的 upsert，delete 与其它实体不算待推送 id', () => {
    const { engine } = createFakeAnnotationEngine({
      outboxOps: [
        { entity: 'annotation', entityId: 'a-upsert', kind: 'upsert' },
        { entity: 'annotation', entityId: 'a-delete', kind: 'delete' },
        { entity: 'progress', entityId: 'p', kind: 'upsert' },
      ],
    })
    const ids = pendingAnnotationIds(engine, BOOK_ID)
    expect([...ids]).toEqual(['a-upsert'])
  })

  it('op 带 bookId 时按书过滤，别的书的待推送条目不混进来', () => {
    const { engine } = createFakeAnnotationEngine({
      outboxOps: [
        { entity: 'annotation', entityId: 'mine', kind: 'upsert', bookId: BOOK_ID },
        { entity: 'annotation', entityId: 'other', kind: 'upsert', bookId: 'another-book' },
      ],
    })
    expect([...pendingAnnotationIds(engine, BOOK_ID)]).toEqual(['mine'])
  })
})

// ---------------- 组合式 API：离线入队 ----------------

describe('useAnnotations（离线入队 / 删除 op）', () => {
  it('add：先写本地 localStorage，再入队 upsert（id 与本地一致）', async () => {
    const { engine, state } = createFakeAnnotationEngine()
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await settle()

    const created = await store.add({ type: 'highlight', cfi: 'cfi-1', text: '重点', progression: 12 })

    // 1) 本地秒写
    const local = readLocalAnnotations(BOOK_ID)
    expect(local).toHaveLength(1)
    expect(local[0]?.id).toBe(created.id)

    // 2) outbox 入队，且 id 完全一致（服务端用 entityId 当主键）
    expect(state.enqueued).toHaveLength(1)
    expect(state.enqueued[0]?.bookId).toBe(BOOK_ID)
    expect(state.enqueued[0]?.annotationId).toBe(created.id)
    expect(state.enqueued[0]?.input?.type).toBe('highlight')
    expect(state.enqueued[0]?.input?.locator.locations?.fragments).toEqual(['cfi-1'])
    expect(state.enqueued[0]?.input?.locator.locations?.progression).toBeCloseTo(0.12)
  })

  it('新建 id 是 UUID（服务端 ValidateOp 要求 entityId 是 UUID）', async () => {
    const id = newAnnotationId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    const store = useAnnotations(() => BOOK_ID, undefined, {
      getEngine: () => createFakeAnnotationEngine().engine,
    })
    await settle()
    const bookmark = await store.add({ type: 'bookmark', cfi: 'cfi-bm' })
    expect(bookmark.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('update：本地更新并入队 upsert', async () => {
    const { engine, state } = createFakeAnnotationEngine()
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await settle()

    // ★ 字段语义（Lead 提醒过的坑）：highlight 的正文在被标注文字 `text`，
    //   `note` 是它上面的附加批注；type:'note' 才是"以正文为内容"的笔记。
    const created = await store.add({ type: 'highlight', cfi: 'cfi-hl', text: '被划线的原文' })
    const updated = await store.update(created.id, { note: '我的想法' })

    expect(updated?.note).toBe('我的想法')
    expect(updated?.text).toBe('被划线的原文')
    // 本地缓存里那条被**就地替换**（不产生第二条记录），且与返回的更新结果一致。
    const local = readLocalAnnotations(BOOK_ID)
    expect(local).toHaveLength(1)
    expect(local[0]).toEqual(updated)
    expect(state.enqueued).toHaveLength(2)
    expect(state.enqueued[1]?.annotationId).toBe(created.id)
    expect(state.enqueued[1]?.input?.note).toBe('我的想法')
    expect(state.enqueued[1]?.input?.text).toBe('被划线的原文')
  })

  it('用 type:note 记想法时，内容是 text 字段（不要把内容和批注搞反）', async () => {
    const { engine, state } = createFakeAnnotationEngine()
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await settle()

    const created = await store.add({ type: 'note', cfi: 'cfi-note', text: '这段写得真好' })
    expect(created.text).toBe('这段写得真好')
    // DTO 侧：内容进 locator.text.highlight + text 字段；note 保持 null（未附加批注）
    expect(state.enqueued[0]?.input?.type).toBe('note')
    expect(state.enqueued[0]?.input?.text).toBe('这段写得真好')
    expect(state.enqueued[0]?.input?.note).toBeUndefined()
    expect(state.enqueued[0]?.input?.locator.text?.highlight).toBe('这段写得真好')
  })

  it('remove：本地删除 + 入队 delete op（input 为 undefined）', async () => {
    const { engine, state } = createFakeAnnotationEngine()
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })

    await settle()
    const created = await store.add({ type: 'underline', cfi: 'cfi-u' })
    await store.remove(created.id)

    expect(store.items.value).toHaveLength(0)
    expect(readLocalAnnotations(BOOK_ID)).toHaveLength(0)
    expect(state.enqueued).toHaveLength(2)
    // 第二个参数缺省 = delete op → 服务端写 remove-wins 墓碑
    expect(state.enqueued[1]?.annotationId).toBe(created.id)
    expect(state.enqueued[1]?.input).toBeUndefined()
  })

  it('refresh：run 抛错（提交失败）时保留本地缓存，不清屏', async () => {
    const { engine } = createFakeAnnotationEngine()
    // 直接覆盖 run（不用 vi.spyOn：mock 生命周期不跨测试泄漏）
    engine.run = () => Promise.reject(new Error('offline'))

    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await store.add({ type: 'highlight', cfi: 'cfi-offline', text: '离线写的' })
    await store.refresh()

    expect(store.items.value).toHaveLength(1)
    expect(store.items.value[0]?.cfi).toBe('cfi-offline')
    expect(readLocalAnnotations(BOOK_ID)).toHaveLength(1)
  })

  it('refresh：引擎 phase=offline（run 不抛但投影陈旧）时也保留本地条目', async () => {
    const { engine } = createFakeAnnotationEngine({
      status: { phase: 'offline', lastError: { code: 'network', message: 'offline' } },
    })
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })

    await store.add({ type: 'highlight', cfi: 'cfi-stale', text: '离线写的高亮' })
    await store.refresh()

    expect(store.items.value.map((it) => it.cfi)).toEqual(['cfi-stale'])
    expect(readLocalAnnotations(BOOK_ID)).toHaveLength(1)
  })

  it('refresh：投影陈旧时，本地已有但 outbox 里没有的旧条目也不会被删', async () => {
    localStorage.setItem(
      `hpf.annotations.v1.${BOOK_ID}`,
      JSON.stringify([makeItem({ id: 'old-local', cfi: 'cfi-old' })]),
    )
    const { engine } = createFakeAnnotationEngine({
      status: { phase: 'offline', lastError: null },
    })
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })

    await store.refresh()
    expect(store.items.value.map((it) => it.id)).toEqual(['old-local'])
  })
})

// ---------------- 组合式 API：pull 合并 ----------------

describe('useAnnotations.refresh（拉取合并）', () => {
  it('本地待推送条目在 pull 之后**不被丢弃**', async () => {
    const pendingLocal = makeItem({ id: 'local-pending', cfi: 'cfi-pending', text: '还没推上去' })
    // 本地缓存里已有它，outbox 里也还在（= 上次离线新建的）
    localStorage.setItem(
      `hpf.annotations.v1.${BOOK_ID}`,
      JSON.stringify([pendingLocal]),
    )

    const dto = makeDto()
    const { engine } = createFakeAnnotationEngine({
      localAnnotations: { [dto.id]: dto },
      // outbox 里那条本地标注还没推成功
      outboxOps: [{ entity: 'annotation', entityId: pendingLocal.id, kind: 'upsert' }],
    })

    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await store.refresh()

    const ids = store.items.value.map((it) => it.id).sort()
    expect(ids).toEqual(['local-pending', 'remote-1'])
    // 合并结果写回本地缓存
    expect(readLocalAnnotations(BOOK_ID).map((it) => it.id).sort()).toEqual(['local-pending', 'remote-1'])
  })

  it('服务端已删除（本地有、远端没有、outbox 也没有）的条目不会复活', async () => {
    localStorage.setItem(
      `hpf.annotations.v1.${BOOK_ID}`,
      JSON.stringify([makeItem({ id: 'deleted-on-server', cfi: 'cfi-dead' })]),
    )
    const dto = makeDto()
    const { engine } = createFakeAnnotationEngine({ localAnnotations: { [dto.id]: dto } })

    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await store.refresh()

    expect(store.items.value.map((it) => it.id)).toEqual(['remote-1'])
  })

  it('远端条目转成展示模型（CFI / 章名 / 百分比）', async () => {
    const dto = makeDto()
    const { engine } = createFakeAnnotationEngine({ localAnnotations: { [dto.id]: dto } })
    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })

    await store.refresh()
    expect(store.items.value[0]?.cfi).toBe('cfi-remote-1')
    expect(store.items.value[0]?.chapterTitle).toBe('第一章')
    expect(store.items.value[0]?.progression).toBe(20)
  })

  it('refresh 只取本书的远端标注（按 bookId 过滤）', async () => {
    const mine = makeDto({ id: 'mine' })
    const other = makeDto({ id: 'other', bookId: 'another-book' })
    const { engine } = createFakeAnnotationEngine({ localAnnotations: { mine, other } })

    const store = useAnnotations(() => BOOK_ID, undefined, { getEngine: () => engine })
    await store.refresh()
    expect(store.items.value.map((it) => it.id)).toEqual(['mine'])
  })

  it('未登录时不碰引擎、不跑 run（纯本地）', async () => {
    const { engine, state } = createFakeAnnotationEngine({ localAnnotations: { 'remote-1': makeDto() } })
    const store = useAnnotations(() => BOOK_ID, undefined, {
      getEngine: () => engine,
      isLoggedIn: () => false,
    })

    await store.refresh()
    expect(state.runs).toBe(0)
    expect(store.items.value).toHaveLength(0)

    await store.add({ type: 'highlight', cfi: 'cfi-local-only' })
    expect(state.enqueued).toHaveLength(0)
    expect(readLocalAnnotations(BOOK_ID)).toHaveLength(1)
  })
})

// ---------------- 旧 REST 兜底路径保持可用 ----------------

describe('useAnnotations（无引擎时的旧 REST 行为）', () => {
  it('有 api 时 list / create 仍被调用（未接入同步引擎的宿主）', async () => {
    const api = {
      annotations: {
        list: vi.fn().mockResolvedValue([makeDto()]),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    }
    const store = useAnnotations(() => BOOK_ID, () => api as never)

    await store.refresh()
    expect(api.annotations.list).toHaveBeenCalledWith(BOOK_ID)
    expect(store.items.value).toHaveLength(1)

    await store.add({ type: 'bookmark', cfi: 'cfi-bm' })
    expect(api.annotations.create).toHaveBeenCalled()
  })

  it('完全没有 api 与引擎时，一切只落 localStorage', async () => {
    const store = useAnnotations(() => BOOK_ID)
    const created = await store.add({ type: 'highlight', cfi: 'cfi-pure-local' })
    expect(created.id).toBeTruthy()
    expect(readLocalAnnotations(BOOK_ID)).toHaveLength(1)
    expect(store.items.value).toHaveLength(1)
  })
})
