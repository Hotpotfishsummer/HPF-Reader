import { TestHarness } from './runner'
import { uuidv7 } from '../../apps/client/frontend/src/features/sync/uuid'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import { createSyncEngine } from '../../apps/client/frontend/src/features/sync/engine'
import { createMemoryStorage } from '../../apps/client/frontend/src/features/sync/storage'
import { createAnnotationsApi } from '../../apps/client/frontend/src/api/endpoints'
import type { UploadedBooks } from './suite-books-upload'

function locator(chapter: string, progression: number) {
  return {
    href: `OEBPS/${chapter}.xhtml`,
    type: 'application/xhtml+xml',
    title: chapter,
    locations: { progression, totalProgression: progression },
  }
}

export async function runSyncAnnotationsSuite(
  harness: TestHarness,
  deviceA: ReturnType<typeof createSyncRuntime>,
  deviceB: ReturnType<typeof createSyncRuntime>,
  books: UploadedBooks,
): Promise<void> {
  const SUITE = 'Sync-Annotations'
  console.log(`\n=== [Suite 5] 划线标注同步、墓碑删除与抗复活裁决验证 ===`)

  const bookId = books.alice.book.id
  const engineA = deviceA.engine
  const engineB = deviceB.engine
  const annotationId = uuidv7()

  const annInput = {
    locator: locator('chapter-02', 0.18) as never,
    type: 'highlight' as const,
    color: '#ffdd00',
    text: 'Curiouser and curiouser!',
    note: 'Classic Alice exclamation',
  }

  // 1. 设备 A 创建划线标注
  engineA.enqueueAnnotation(bookId, annotationId, annInput)
  const pushRes = await harness.runStep(
    SUITE,
    'AN-01',
    '设备 A 创建高亮划线标注并推送到服务端',
    () => engineA.run(),
    (res) => {
      const annInA = engineA.local.annotations[annotationId]
      return {
        ok: res.applied === 1 && annInA !== undefined && annInA.text === annInput.text,
        detail: `applied: ${res.applied}, text: "${annInA?.text}"`,
      }
    },
  )

  // 2. 设备 B 增量拉取
  await harness.runStep(
    SUITE,
    'AN-02',
    '设备 B 增量 pull：捕获设备 A 新建的划线标注',
    () => engineB.pullOnce(),
    () => {
      const annInB = engineB.local.annotations[annotationId]
      return {
        ok: annInB !== undefined && annInB.note === annInput.note,
        detail: `Device B got annotation: ${annInB?.id}`,
      }
    },
  )

  // 3. 设备 A 更新标注内容
  const updatedInput = { ...annInput, color: '#ff5500', note: 'Updated note on wonderland' }
  engineA.enqueueAnnotation(bookId, annotationId, updatedInput)
  await engineA.run()

  await harness.runStep(
    SUITE,
    'AN-03',
    '设备 A 修改标注颜色与笔记，设备 B 增量 pull 获取最新内容',
    () => engineB.pullOnce(),
    () => {
      const annInB = engineB.local.annotations[annotationId]
      return {
        ok: annInB !== undefined && annInB.color === '#ff5500' && annInB.note === 'Updated note on wonderland',
        detail: `Color: ${annInB?.color}, note: "${annInB?.note}"`,
      }
    },
  )

  // 4. 设备 A 删除标注（生成墓碑 tombstone）
  engineA.enqueueAnnotation(bookId, annotationId) // 无 payload 为 delete
  await harness.runStep(
    SUITE,
    'AN-04',
    '设备 A 软删除标注（写入 tombstone 墓碑标记）',
    () => engineA.run(),
  )

  // 5. 设备 B 拉取删除事件，本地移除该标注
  await harness.runStep(
    SUITE,
    'AN-05',
    '设备 B 增量 pull：墓碑生效，本地投影移除该标注',
    () => engineB.pullOnce(),
    () => ({
      ok: engineB.local.annotations[annotationId] === undefined,
      detail: `Annotation successfully cleared from local state`,
    }),
  )

  // 6. 抗复活防线（Remove-Wins）：慢设备尝试用陈旧 HLC 重新提交该标注
  const engineSlow = createSyncEngine(
    { baseUrl: harness.baseUrl, deviceId: engineA.deviceId },
    { client: deviceA.client, storage: createMemoryStorage(), now: () => Date.now() - 7200_000 },
  )
  engineSlow.enqueueAnnotation(bookId, annotationId, annInput)
  const resurrectRes = await harness.runStep(
    SUITE,
    'AN-06',
    '抗复活防御 (Remove-Wins)：陈旧写入无法复活已被墓碑删除的标注',
    () => engineSlow.pushOnce(),
    (res) => ({
      ok: res.reasons.includes('tombstone_wins'),
      detail: `Server adjudication: ${JSON.stringify(res.reasons)}`,
    }),
  )
  engineSlow.dispose()

  // 7. 服务端 REST 接口创建标注后，客户端能够无缝 pull 收到
  const restAnn = await harness.runStep(
    SUITE,
    'AN-07',
    '服务端直接通过 REST API 创建批注，被客户端增量同步无缝捕获',
    async () => {
      const api = createAnnotationsApi(deviceA.client)
      return api.create(bookId, {
        locator: locator('chapter-04', 0.35) as never,
        type: 'note',
        note: 'Note added from Server REST direct endpoint',
      } as never)
    },
  )

  await harness.runStep(
    SUITE,
    'AN-08',
    '设备 A pull 获取服务端直建批注并成功合并',
    () => engineA.pullOnce(),
    () => ({
      ok: engineA.local.annotations[restAnn.id] !== undefined,
      detail: `Annotation ID: ${restAnn.id}`,
    }),
  )
}
