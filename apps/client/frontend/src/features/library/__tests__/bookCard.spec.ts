import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import BookCard from '../components/BookCard.vue'
import type { BookRecord } from '@/platform'

/**
 * 书卡底部操作区的渲染契约。
 *
 * ★ 用户反馈（附截图）：
 *   「这个书籍排版下面的按钮和文字为什么又横又竖的？而且提示已上传到云端，
 *     为什么还显示上传按钮？未上传的时候显示一个上传图标，上传完成后就显示一个
 *     完成图标就可以了，不用文字描述」
 *
 * 根因有两条，都必须锁住：
 *   ① 布局：底部用了 `justify-between` + 会折行的容器，「阅读」在左、
 *      长中文「已上传到云端」和「上传」在右，窗口一窄就整体折行 ⇒ 又横又竖。
 *   ② 状态：`v-if="inCloud"` 的「已上传到云端」文字和 `v-if="canUpload"` 的上传按钮
 *      **各自独立判断**，所以"已上传"时两者同时出现 —— 正是用户看到的矛盾。
 */

vi.mock('vue-router', () => ({
  RouterLink: {
    name: 'RouterLink',
    props: ['to'],
    template: '<a :href="String(to)"><slot /></a>',
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params) return `${key}:${JSON.stringify(params)}`
      return key
    },
  }),
}))

function book(over: Partial<BookRecord> = {}): BookRecord {
  return {
    id: 'b1',
    title: '小狗钱钱',
    author: '舍费尔',
    format: 'epub',
    sizeBytes: 1024 * 1024,
    contentHash: 'abc123',
    ...over,
  } as BookRecord
}

const baseProps = { book: book(), canUpload: true }

describe('BookCard 底部操作区', () => {
  it('已上传时：只显示完成图标，不再出现上传按钮', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: true } })

    // 完成图标存在
    expect(w.find('[data-testid="book-in-cloud"]').exists()).toBe(true)
    // ★ 关键回归：上传按钮必须**消失**（以前两者会同时出现）
    expect(w.find('[data-testid="book-upload"]').exists()).toBe(false)
  })

  it('未上传时：显示上传图标，不显示完成图标', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: false } })

    expect(w.find('[data-testid="book-upload-icon"]').exists()).toBe(true)
    expect(w.find('[data-testid="book-in-cloud"]').exists()).toBe(false)
  })

  it('上传中：图标换成转圈，且按钮被禁用', () => {
    const w = mount(BookCard, { props: { ...baseProps, uploading: true, uploadPercent: 42 } })

    expect(w.find('[data-testid="book-upload-spinner"]').exists()).toBe(true)
    // 转圈时不显示静态云图标，避免两个图标叠在一起
    expect(w.find('[data-testid="book-upload-icon"]').exists()).toBe(false)
    expect(w.find('[data-testid="book-upload"]').attributes('disabled')).toBeDefined()
  })

  it('★ 视觉上不再有"已上传到云端"这类文字描述', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: true } })
    const text = w.text()

    // i18n 被 mock 成返回 key，所以这里查的是 key 本身
    expect(text).not.toContain('library.cloudUploaded')
    // 也不该出现"上传"字样的可见文案（只剩「阅读」和「移除」这类主操作文字）
    expect(text).not.toContain('library.cloudUploadShort')
    expect(text).not.toContain('library.cloudUploadNeedLogin')
  })

  it('★ 图标按钮都有无障碍名（去掉文字不等于变成无标签按钮）', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: false } })

    const upload = w.find('[data-testid="book-upload"]')
    expect(upload.attributes('aria-label')).toBeTruthy()
    expect(upload.attributes('title')).toBeTruthy()

    const remove = w.find('[data-testid="book-remove"]')
    expect(remove.exists()).toBe(true)
    expect(remove.attributes('aria-label')).toBeTruthy()
  })

  it('未登录时上传图标仍然可见（入口不能藏起来）', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: false, needLogin: true } })

    const upload = w.find('[data-testid="book-upload"]')
    expect(upload.exists()).toBe(true)
    // 提示语指向"需要登录"，而不是静默失败
    expect(upload.attributes('title')).toContain('library.cloudNeedLogin')
  })

  it('底部操作区不折行：容器不带 flex-wrap', () => {
    const w = mount(BookCard, { props: { ...baseProps, inCloud: false } })
    const row = w.find('.mt-3')

    // ★ 这是"又横又竖"的直接原因：flex-wrap 会让长文案把整行挤成多行
    expect(row.classes()).not.toContain('flex-wrap')
    expect(row.classes()).toContain('items-center')
  })
})
