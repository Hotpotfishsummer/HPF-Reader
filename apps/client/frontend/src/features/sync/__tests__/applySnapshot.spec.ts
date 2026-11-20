import { describe, expect, it } from 'vitest'
import { normalizeAnnotation } from '../apply'

/**
 * 标注投影的规范化（回归测试）。
 *
 * 背景：服务端 sync 快照里的标注载荷**不含 id**（id 在表主键 / op 的 entityId 上）。
 * 之前 applySnapshot 直接 `state.annotations[annotation.id] = annotation`，
 * 于是新设备首同步会写出一条 key 为 'undefined' 的幽灵标注：
 * 按 id 查不到、删不掉、UI 里还多一行。集成测试 BF-08 复现过。
 *
 * 这里锁死两条不变量：
 *  1. 规范化结果的身份**永远取自入参 annotationId**（不依赖载荷里有没有 id）；
 *  2. 缺字段时要有确定性的兜底（type 默认 highlight、locator 不能是 null、
 *     时间戳要有值），因为 UI 与后续合并都直接读这些字段。
 */
describe('normalizeAnnotation', () => {
  it('身份取入参 id，即便载荷里没有 id（快照路径的真实形态）', () => {
    const result = normalizeAnnotation('ann-1', {
      type: 'note',
      bookId: 'book-1',
      text: '笔记正文',
      locator: { href: 'OEBPS/ch1.xhtml', type: 'application/xhtml+xml' },
    })
    expect(result.id).toBe('ann-1')
    expect(result.bookId).toBe('book-1')
    expect(result.type).toBe('note')
    expect(result.text).toBe('笔记正文')
    expect(result.locator.href).toBe('OEBPS/ch1.xhtml')
    expect(result.createdAt).toBeTruthy()
    expect(result.updatedAt).toBeTruthy()
  })

  it('缺字段时有确定性兜底：type=highlight、locator 非空、颜色/批注为 null', () => {
    const result = normalizeAnnotation('ann-2', {})
    expect(result.id).toBe('ann-2')
    expect(result.type).toBe('highlight')
    expect(result.locator).not.toBeNull()
    expect(result.color).toBeNull()
    expect(result.note).toBeNull()
    expect(result.text).toBeNull()
  })

  it('载荷里的显式字段覆盖兜底值，并用 fallback 保留已知元数据', () => {
    const fallback = normalizeAnnotation('ann-3', { type: 'highlight', color: '#ff5500', createdAt: '2026-01-01T00:00:00.000Z' })
    const updated = normalizeAnnotation('ann-3', { note: '后来补的批注' }, fallback)
    expect(updated.type).toBe('highlight')
    expect(updated.color).toBe('#ff5500')
    expect(updated.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(updated.note).toBe('后来补的批注')
  })
})
