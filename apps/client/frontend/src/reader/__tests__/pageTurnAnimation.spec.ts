import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePageTurnAnimation } from '../usePageTurnAnimation'
import { useSettingsStore, type PageTurnAnimation } from '@/stores/settings'
import ReaderSettingsPopover from '../components/ReaderSettingsPopover.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        if (params) return `${key}:${JSON.stringify(params)}`
        return key
      },
    }),
  }
})

describe('usePageTurnAnimation', () => {
  let onNext: Mock<() => Promise<void>>
  let onPrev: Mock<() => Promise<void>>

  beforeEach(() => {
    onNext = vi.fn().mockResolvedValue(undefined)
    onPrev = vi.fn().mockResolvedValue(undefined)
  })

  it('none 动画：立即调用底层 engine，不触发 exit/enter 动画状态', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'none',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    expect(controller.isTurnAnimating.value).toBe(false)
    expect(controller.turnPhase.value).toBe('idle')

    await controller.turnPage('next')
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(controller.isTurnAnimating.value).toBe(false)
    expect(controller.turnPhase.value).toBe('idle')
    expect(controller.animClasses.value).toEqual([])
  })

  it('slide 动画：正确经历 exit -> onNext -> enter -> idle 生命周期与样式类', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'slide',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    const turnPromise = controller.turnPage('next')

    // 此时处于 exit 阶段
    expect(controller.isTurnAnimating.value).toBe(true)
    expect(controller.turnPhase.value).toBe('exit')
    expect(controller.turnDirection.value).toBe('next')
    expect(controller.animClasses.value).toContain('hpf-slide-next-exit')

    await turnPromise

    // 翻页完成后回到 idle
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(controller.isTurnAnimating.value).toBe(false)
    expect(controller.turnPhase.value).toBe('idle')
    expect(controller.animClasses.value).toEqual([])
  })

  it('fade 动画：翻页时产生 Kindle 风格淡入淡出类', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'fade',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    const turnPromise = controller.turnPage('next')
    expect(controller.animClasses.value).toContain('hpf-fade-exit')

    await turnPromise
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(controller.isTurnAnimating.value).toBe(false)
  })

  it('curl 动画：向前与向后翻页分别产生左右 3D 卷页样式类', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'curl',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    const turnNext = controller.turnPage('next')
    expect(controller.animClasses.value).toContain('hpf-curl-next-exit')
    await turnNext
    expect(onNext).toHaveBeenCalledTimes(1)

    const turnPrev = controller.turnPage('prev')
    expect(controller.animClasses.value).toContain('hpf-curl-prev-exit')
    await turnPrev
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('eink 动画：产生墨水屏刷新微闪类', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'eink',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    const turnPromise = controller.turnPage('next')
    expect(controller.animClasses.value).toContain('hpf-eink-exit')

    await turnPromise
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('墨水屏优化模式：当开启 einkMode 时，常规动画降级为 none，但显式指定 eink 保留微闪', async () => {
    let currentAnim: PageTurnAnimation = 'slide'
    const controller = usePageTurnAnimation({
      getAnimation: () => currentAnim,
      isEinkMode: () => true,
      onNext,
      onPrev,
    })

    // slide 在 einkMode 下降级为 none
    await controller.turnPage('next')
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(controller.animClasses.value).toEqual([])

    // 显式指定 eink 则保持 eink 刷新
    currentAnim = 'eink'
    const einkTurn = controller.turnPage('prev')
    expect(controller.animClasses.value).toContain('hpf-eink-exit')
    await einkTurn
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('快速连击翻页：后一次调用递增序号，不产生未处理异常或死锁', async () => {
    const controller = usePageTurnAnimation({
      getAnimation: () => 'slide',
      isEinkMode: () => false,
      onNext,
      onPrev,
    })

    // 快速触发两次
    const firstTurn = controller.turnPage('next')
    const secondTurn = controller.turnPage('next')

    await Promise.all([firstTurn, secondTurn])
    expect(controller.isTurnAnimating.value).toBe(false)
    expect(controller.turnPhase.value).toBe('idle')
  })
})

describe('settings store pageTurnAnimation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('设置默认翻页动画为 slide，支持通过 setPageTurnAnimation 修改', () => {
    const settings = useSettingsStore()
    expect(settings.pageTurnAnimation).toBe('slide')

    settings.setPageTurnAnimation('fade')
    expect(settings.pageTurnAnimation).toBe('fade')

    settings.setPageTurnAnimation('curl')
    expect(settings.pageTurnAnimation).toBe('curl')
  })
})

describe('ReaderSettingsPopover.vue 翻页动画选择', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('渲染 5 种翻页动画按钮，点击可切换动画设置', async () => {
    const settings = useSettingsStore()
    const wrapper = mount(ReaderSettingsPopover, {
      props: { open: true },
    })

    const slideBtn = wrapper.find('[data-testid="anim-btn-slide"]')
    const fadeBtn = wrapper.find('[data-testid="anim-btn-fade"]')
    const curlBtn = wrapper.find('[data-testid="anim-btn-curl"]')
    const einkBtn = wrapper.find('[data-testid="anim-btn-eink"]')
    const noneBtn = wrapper.find('[data-testid="anim-btn-none"]')

    expect(slideBtn.exists()).toBe(true)
    expect(fadeBtn.exists()).toBe(true)
    expect(curlBtn.exists()).toBe(true)
    expect(einkBtn.exists()).toBe(true)
    expect(noneBtn.exists()).toBe(true)

    // 点击 fade
    await fadeBtn.trigger('click')
    expect(settings.pageTurnAnimation).toBe('fade')

    // 点击 curl
    await curlBtn.trigger('click')
    expect(settings.pageTurnAnimation).toBe('curl')

    // 点击 none
    await noneBtn.trigger('click')
    expect(settings.pageTurnAnimation).toBe('none')
  })
})
