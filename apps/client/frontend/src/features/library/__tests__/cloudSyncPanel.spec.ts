import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setPlatformForTest } from '@/platform'
import { createTestPlatform } from '@/platform/test'
import CloudSyncPanel from '../components/CloudSyncPanel.vue'
import { useLibraryStore, type UploadTask } from '../stores/libraryStore'

/**
 * 云端同步面板的渲染契约。
 *
 * ★ 用户反馈的原话是"点击之后按钮变灰，卡了很久，也不知道状况怎么样"。
 *   所以这块 UI 的验收标准不是"有个转圈"，而是：
 *   - 进行中：看得见百分比与总进度；
 *   - 失败：原因就地可见（面板在页面顶部，不用滚），并且能重试；
 *   - 进行中：能取消。
 */

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params) return `${key}:${JSON.stringify(params)}`
      return key
    },
  }),
}))

function task(over: Partial<UploadTask> = {}): UploadTask {
  return {
    bookId: 'b1',
    title: '测试书',
    sizeBytes: 1000,
    state: 'uploading',
    loaded: 250,
    total: 1000,
    bytesPerSecond: 512,
    startedAt: Date.now(),
    ...over,
  }
}

let library: ReturnType<typeof useLibraryStore>

beforeEach(() => {
  setActivePinia(createPinia())
  // store 初始化会读本地书库 ⇒ 必须先注入平台实现。
  setPlatformForTest(createTestPlatform({ books: [], bytes: {} }))
  library = useLibraryStore()
})

describe('CloudSyncPanel.vue', () => {
  it('没有任务时不渲染（不占页面空间）', () => {
    const wrapper = mount(CloudSyncPanel)
    expect(wrapper.find('[data-testid="cloud-sync-panel"]').exists()).toBe(false)
  })

  it('上传中：显示进度条、百分比与取消按钮', () => {
    library.uploadTasks = [task()]
    const wrapper = mount(CloudSyncPanel)

    expect(wrapper.find('[data-testid="cloud-sync-panel"]').exists()).toBe(true)
    const bar = wrapper.find('[data-testid="cloud-sync-task-bar"]')
    expect(bar.exists()).toBe(true)
    // 250/1000 = 25%
    expect(String((bar.attributes('style') ?? '')).includes('25%')).toBe(true)
    expect(wrapper.text()).toContain('25%')
    expect(wrapper.find('[data-testid="cloud-sync-cancel"]').exists()).toBe(true)
  })

  it('失败：原因就地可见，并且有重试按钮', () => {
    library.uploadTasks = [
      task({ state: 'failed', errorCode: 'stall_timeout', error: 'no upload progress for 60s' }),
    ]
    const wrapper = mount(CloudSyncPanel)

    const err = wrapper.find('[data-testid="cloud-sync-task-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('library.cloudUploadStall')
    expect(wrapper.find('[data-testid="cloud-sync-task-retry"]').exists()).toBe(true)
  })

  it('网络错误显示网络文案（而不是原始异常）', () => {
    library.uploadTasks = [task({ state: 'failed', errorCode: 'network_error', error: 'boom' })]
    const wrapper = mount(CloudSyncPanel)
    expect(wrapper.find('[data-testid="cloud-sync-task-error"]').text()).toContain(
      'library.cloudUploadNetwork',
    )
  })

  it('点取消会调用 store 的 cancelUpload', async () => {
    library.uploadTasks = [task()]
    const spy = vi.spyOn(library, 'cancelUpload')
    const wrapper = mount(CloudSyncPanel)

    await wrapper.find('[data-testid="cloud-sync-cancel"]').trigger('click')
    expect(spy).toHaveBeenCalled()
  })

  it('全部结束后显示"知道了"（清理按钮），不再显示取消', () => {
    library.uploadTasks = [task({ state: 'done', loaded: 1000 })]
    const wrapper = mount(CloudSyncPanel)

    expect(wrapper.find('[data-testid="cloud-sync-cancel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="cloud-sync-dismiss"]').exists()).toBe(true)
  })

  it('秒传命中显示"已跳过"（不是失败）', () => {
    library.uploadTasks = [task({ state: 'skipped', loaded: 1000, total: 1000 })]
    const wrapper = mount(CloudSyncPanel)
    expect(wrapper.text()).toContain('library.cloudUploadSkipped')
    expect(wrapper.find('[data-testid="cloud-sync-task-error"]').exists()).toBe(false)
  })
})
