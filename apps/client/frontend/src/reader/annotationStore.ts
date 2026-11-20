import { ref, watch, type Ref } from 'vue'
import type { AnnotationCreate, AnnotationDto } from '@/api/contract'
import type { Api } from '@/api'

/**
 * ★ task-4：标注（高亮 / 下划线 / 笔记 / 书签）统一走同步引擎的 outbox。
 *
 * 之前的行为（必须记住，否则会改回去）：
 *   add/update/remove 都是 fire-and-forget REST（`.catch(() => {})`），
 *   离线时注释里写着"以后同步重试"，但**根本没有重试机制** —— 那条标注就此丢失。
 *
 * 现在的三条不变量：
 *   1. **本地优先**：先同步写 localStorage（秒开、离线可用），再入队。
 *      任何一步失败都不影响另一条路径。
 *   2. **id 本地生成且与服务端一致**：新建用 `crypto.randomUUID()`。
 *      服务端 `POST /v1/books/{id}/annotations` 是**服务端生成 id**（httpapi/annotations.go:108
 *      `idgen.NewUUID()`，请求体里没有 id 字段），所以那条 REST 路径拿不到"本地 id"。
 *      但 **sync push 路径用 `entityId` 作为主键**（internal/store/sync_store.go:365
 *      `INSERT INTO annotations (id, ...) VALUES ($1, ...)`，$1 = op.EntityID），
 *      且 ValidateOp 只要求 entityId 是 UUID（internal/sync/engine.go:237）。
 *      → 客户端生成 UUID 经 outbox 推送后，服务端主键**就是**本地 id，
 *        多设备/多端收敛时不产生"同一条标注两个 id"。
 *   3. **未登录 / 无引擎时行为与以前完全一致**：纯本地，不碰网络。
 *
 * 拉取合并（refresh）见下方 `mergeRefresh`：远端集合 + 本地**仍在 outbox 待推送**的条目，
 * 绝不因为 pull 结果里没有就把还没推上去的本地条目丢掉。
 */

export interface AnnotationItem {
  id: string
  bookId: string
  type: 'highlight' | 'underline' | 'note' | 'bookmark'
  color?: string
  text?: string
  note?: string
  cfi: string
  createdAt: string
  chapterTitle?: string
  progression?: number
  style?: 'solid' | 'squiggly' | 'strikethrough'
}

/** 同步引擎里我们用到的部分（便于单测注入假引擎，不依赖真单例）。 */
export interface AnnotationEngineLike {
  enqueueAnnotation(bookId: string, annotationId: string, input?: AnnotationCreate): unknown
  run(): Promise<unknown>
  outbox: {
    list(): { op: { entity: string; entityId: string; kind: string; bookId?: string | null } }[]
  }
  local: { annotations: Record<string, AnnotationDto> }
  /** 引擎自报状态（可选：测试假引擎可以不给 → 视为"投影可信"）。 */
  getStatus?(): { phase: string; lastError: { code: string; message: string } | null }
}

export interface AnnotationStoreOptions {
  /** 惰性取引擎（服务器地址变更后是新实例 → 每次都重新 get）。 */
  getEngine?: () => AnnotationEngineLike | undefined
  /** 已登录才推/拉。未登录时纯本地。 */
  isLoggedIn?: () => boolean
}

function storageKey(bookId: string): string {
  return `hpf.annotations.v1.${bookId}`
}

export function readLocalAnnotations(bookId: string): AnnotationItem[] {
  if (typeof localStorage === 'undefined' || !bookId) return []
  try {
    const raw = localStorage.getItem(storageKey(bookId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as AnnotationItem[]) : []
  } catch {
    return []
  }
}

export function writeLocalAnnotations(bookId: string, items: AnnotationItem[]): void {
  if (typeof localStorage === 'undefined' || !bookId) return
  try {
    localStorage.setItem(storageKey(bookId), JSON.stringify(items))
  } catch {
    // 忽略 localStorage 配额错误
  }
}

/** 新建标注 id：优先 crypto.randomUUID（服务端要求 UUID），退化路径只在极老 WebView 出现。 */
export function newAnnotationId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return 'annot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

function dtoToItem(dto: AnnotationDto): AnnotationItem {
  return {
    id: dto.id,
    bookId: dto.bookId,
    type: dto.type,
    color: dto.color ?? undefined,
    text: dto.text ?? undefined,
    note: dto.note ?? undefined,
    cfi: dto.locator?.locations?.fragments?.[0] ?? '',
    chapterTitle: dto.locator?.title ?? undefined,
    progression:
      dto.locator?.locations?.progression != null
        ? Math.round(dto.locator.locations.progression * 100)
        : undefined,
    createdAt: dto.createdAt,
  }
}

function itemToCreateDto(item: Omit<AnnotationItem, 'id' | 'createdAt'>): AnnotationCreate {
  return {
    type: item.type,
    color: item.color,
    text: item.text,
    note: item.note,
    locator: {
      href: '',
      type: 'application/epub+zip',
      title: item.chapterTitle,
      locations: {
        fragments: item.cfi ? [item.cfi] : [],
        progression: item.progression != null ? item.progression / 100 : undefined,
      },
      text: item.text ? { highlight: item.text } : undefined,
    },
  }
}

/**
 * outbox 里该书的 annotation **新建/编辑** 条目 id 集合。
 *
 * 为什么需要它：pull 用的是服务端游标，而 outbox 里还没推上去的条目服务端根本不知道。
 * 合并时若直接"以远端为准"，这些本地条目就被删掉了 —— 这正是要防的丢数据。
 */
export function pendingAnnotationIds(
  engine: AnnotationEngineLike | undefined,
  bookId: string,
): Set<string> {
  const pending = new Set<string>()
  if (!engine || !bookId) return pending
  try {
    for (const entry of engine.outbox.list()) {
      const op = entry?.op
      if (!op || op.entity !== 'annotation') continue
      if (op.kind !== 'upsert') continue
      // op 上带 bookId 时按书过滤（同一本书的本地条目才不会互相影响）。
      if (op.bookId !== undefined && op.bookId !== null && op.bookId !== '' && op.bookId !== bookId) {
        continue
      }
      pending.add(op.entityId)
    }
  } catch {
    // outbox 不可读（测试用假引擎可能没有）→ 视为没有待推送条目
  }
  return pending
}

/**
 * 合并远端与本地缓存（**纯函数**，单测重点覆盖）。
 *
 * 规则：
 *   1. 远端条目按 id 覆盖（服务端是权威）；
 *   2. 远端没有、但本地有 **且仍在 outbox 待推送** 的条目 → 保留；
 *   3. 远端没有、本地有、**且不在 outbox** 的条目 → 说明服务端已删除（墓碑生效），丢弃。
 *
 * 规则 3 是必须的：否则删除操作会在本机"复活"（pull 回来后本地那条又冒出来）。
 */
export function mergeRemoteWithLocal(input: {
  remoteItems: AnnotationItem[]
  localItems: AnnotationItem[]
  pendingIds: Set<string>
  /** 远端里存在但 cfi 为空的条目（服务端半成品）视为无效，不展示。 */
}): AnnotationItem[] {
  const remoteItems = input.remoteItems.filter((item) => item.cfi)
  const remoteIds = new Set(remoteItems.map((item) => item.id))
  const combined = [...remoteItems]
  for (const local of input.localItems) {
    if (remoteIds.has(local.id)) continue
    if (!input.pendingIds.has(local.id)) continue
    combined.push(local)
  }
  return combined
}

/**
 * 本地投影此刻能不能当作权威？
 *
 * 判据只有一条：**上一次同步是不是真的连上了服务端**。
 * offline / lastError 非空 → 投影可能是任意旧快照，此时它"没有某条标注"
 * 只说明我们看不到，而不是服务端删了。拿它当权威会把本地数据删掉。
 */
function remoteProjectionTrusted(engine: AnnotationEngineLike): boolean {
  const status = engine.getStatus?.()
  if (!status) return true
  if (status.lastError) return false
  return status.phase !== 'offline'
}

export function useAnnotations(
  getBookId: () => string,
  getApi?: () => Api | undefined,
  options: AnnotationStoreOptions = {},
) {
  const items: Ref<AnnotationItem[]> = ref([])
  const loading = ref(false)
  /**
   * 本地写入版本号：每次 add / update / remove 自增。
   *
   * 为什么需要它：`watch(getBookId, refresh, { immediate: true })` 的 refresh 是异步的，
   * 它可能在用户"新建标注"的 await 间隙里恢复执行。如果这时拿**旧快照**合并写回，
   * 就会把刚新建的条目覆盖掉（实测：新建后 storage 变成 `[]`）。
   * 版本号变化 = 期间有本地写入，本轮合并作废。
   */
  let localVersion = 0

  function engine(): AnnotationEngineLike | undefined {
    return options.getEngine?.()
  }

  /** 引擎可用 + 已登录时才做同步；否则纯本地（行为与 task-12 一致）。 */
  function syncUsable(): AnnotationEngineLike | undefined {
    const e = engine()
    if (!e) return undefined
    if (options.isLoggedIn && !options.isLoggedIn()) return undefined
    return e
  }

  /**
   * 远端 DTO → 展示用 item；优先走引擎投影，没有引擎时退回 REST 列表。
   *
   * 返回 `null` 的语义是**"远端状态未知"**：调用方必须保留本地缓存、只展示不改写。
   * 这是防止离线时"合并出一个空数组"把本地标注清掉的关键（刷新永远不许删本地数据）。
   */
  async function loadRemoteDtos(bookId: string): Promise<AnnotationDto[] | null> {
    const e = syncUsable()
    if (e) {
      try {
        // 一次 run = 先推 outbox（含刚入队的本地标注），再拉到 head。
        await e.run()
      } catch {
        // 离线/401：远端状态未知 → 保留本地，不清屏。
        return null
      }
      // 引擎把连接失败**吞进 status**（run 不抛），所以还要看 phase。
      // 离线 / 上次同步有错时，local 投影是陈旧快照，不能当作权威来删本地条目。
      if (!remoteProjectionTrusted(e)) return null
      return Object.values(e.local.annotations).filter((dto) => dto.bookId === bookId)
    }

    const api = getApi?.()
    if (!api) return null
    try {
      return await api.annotations.list(bookId)
    } catch {
      return null
    }
  }

  async function refresh(): Promise<void> {
    const bookId = getBookId()
    if (!bookId) {
      items.value = []
      return
    }

    // 先走同步 localStorage 缓存：保证秒开、离线可用
    const cached = readLocalAnnotations(bookId)
    items.value = cached

    if (!syncUsable() && !getApi?.()) return

    try {
      loading.value = true
      const dtos = await loadRemoteDtos(bookId)
      if (dtos === null) {
        // ★ 远端状态未知：只展示本地缓存，**绝不写回**。
        //   写回会把"刚在 await 期间新建/修改的条目"覆盖掉（竞态：watch immediate
        //   触发的 refresh 与用户新建在同一帧里交错）。
        items.value = readLocalAnnotations(bookId)
        return
      }

      // ★ 合并必须在本地状态稳定时落地。await 期间用户可能已经新建 / 修改 / 删除；
      //   直接写回旧结果会覆盖掉这些动作。重新读 items 与 storage，
      //   直到一轮里没有新的本地写入（localVersion 不变）为止。
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const version = localVersion
        const local = readLocalAnnotations(bookId)
        const inMemory = items.value
        const localItems = [
          ...inMemory,
          ...local.filter((it) => !inMemory.some((m) => m.id === it.id)),
        ]
        const combined = mergeRemoteWithLocal({
          remoteItems: dtos.map(dtoToItem),
          localItems,
          pendingIds: pendingAnnotationIds(syncUsable(), bookId),
        })
        if (version !== localVersion) continue
        items.value = combined
        writeLocalAnnotations(bookId, combined)
        break
      }
    } finally {
      loading.value = false
    }
  }

  async function add(
    item: Omit<AnnotationItem, 'id' | 'createdAt' | 'bookId'> & { bookId?: string },
  ): Promise<AnnotationItem> {
    const bookId = item.bookId ?? getBookId()
    const created: AnnotationItem = {
      ...item,
      id: newAnnotationId(),
      bookId,
      createdAt: new Date().toISOString(),
    }

    const next = [created, ...items.value]
    items.value = next
    writeLocalAnnotations(bookId, next)
    localVersion += 1

    const e = syncUsable()
    if (e) {
      // 本地 id 直接作为服务端主键（见文件头注释第 2 条）。
      e.enqueueAnnotation(bookId, created.id, itemToCreateDto(created))
      return created
    }

    // 未登录 / 无引擎：保持旧的 REST 行为（服务端会分配它自己的 id）。
    const api = getApi?.()
    if (api) {
      void api.annotations.create(bookId, itemToCreateDto(created)).catch(() => {
        // 离线时静默（旧行为）
      })
    }

    return created
  }

  async function remove(id: string): Promise<void> {
    const bookId = getBookId()
    const next = items.value.filter((it) => it.id !== id)
    items.value = next
    writeLocalAnnotations(bookId, next)
    localVersion += 1

    const e = syncUsable()
    if (e) {
      // 第二个参数为 undefined = delete op → 服务端写 remove-wins 墓碑。
      e.enqueueAnnotation(bookId, id)
      return
    }

    const api = getApi?.()
    if (api) {
      void api.annotations.remove(id).catch(() => {})
    }
  }

  async function update(id: string, patch: Partial<AnnotationItem>): Promise<AnnotationItem | null> {
    const bookId = getBookId()
    const idx = items.value.findIndex((it) => it.id === id)
    if (idx === -1) return null
    const existing = items.value[idx]!
    const updated: AnnotationItem = {
      ...existing,
      ...patch,
    }
    const next = [...items.value]
    next[idx] = updated
    items.value = next
    writeLocalAnnotations(bookId, next)
    localVersion += 1

    const e = syncUsable()
    if (e) {
      e.enqueueAnnotation(bookId, updated.id, itemToCreateDto(updated))
      return updated
    }

    const api = getApi?.()
    if (api) {
      void api.annotations.update(id, itemToCreateDto(updated)).catch(() => {})
    }
    return updated
  }

  watch(getBookId, () => {
    void refresh()
  }, { immediate: true })

  return {
    items,
    loading,
    refresh,
    add,
    update,
    remove,
  }
}
