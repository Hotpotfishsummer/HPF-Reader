import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import PageTurnSettings from '@/features/settings/PageTurnSettings.vue'
import { useSettingsStore } from '@/stores/settings'

/**
 * 翻页设置区块的行为测试。
 *
 * ★ 重点锁三件事（都是"看起来能用、其实不能用"的高发区）：
 *   ① 默认值必须是「键盘开 + 鼠标关 + 右/下是下一页」；
 *   ② 录制键位后真的写进 store，且**跨方向冲突被拦下**；
 *   ③ 移除键位后不会留下一个"两边都空"的死状态。
 */
function mountSection() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })
  const wrapper = mount(PageTurnSettings, { global: { plugins: [pinia, i18n] } })
  return { wrapper, settings: useSettingsStore() }
}

/** 派发一次真实 keydown（录制走 window 捕获阶段）。 */
function pressKey(key: string, mods: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
}

describe('PageTurnSettings（翻页设置）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('★ 默认：键盘翻页开、鼠标翻页关、下一页是右/下、上一页是左/上', () => {
    const { settings } = mountSection()
    expect(settings.keyboardPageTurn).toBe(true)
    expect(settings.mousePageTurn).toBe('off')
    expect(settings.effectiveNextKeys).toEqual(['ArrowRight', 'ArrowDown'])
    expect(settings.effectivePrevKeys).toEqual(['ArrowLeft', 'ArrowUp'])
  })

  it('渲染出键盘开关与鼠标三个模式', () => {
    const { wrapper } = mountSection()
    expect(wrapper.find('[data-testid="keyboard-pageturn-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mouse-pageturn-off"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mouse-pageturn-single"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mouse-pageturn-double"]').exists()).toBe(true)
  })

  it('默认键位以芯片形式展示（方向键显示成箭头）', () => {
    const { wrapper } = mountSection()
    const chips = wrapper.findAll('[data-testid="next-keys-chip"]')
    expect(chips).toHaveLength(2)
    // 归一化空白：模板里的换行/缩进会变成多余空格，断言不该被排版细节绊住。
    expect(chips.map((c) => c.text().replace(/\s+/g, ' ').trim())).toEqual(['→ ✕', '↓ ✕'])
  })

  it('点击「添加按键」进入录制，按下新键后写入 store', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="next-keys-add"]').trigger('click')
    expect(wrapper.find('[data-testid="next-keys-recording"]').exists()).toBe(true)

    pressKey('PageDown')
    await wrapper.vm.$nextTick()

    expect(settings.nextKeys).toContain('PageDown')
    expect(settings.nextKeys).toHaveLength(3)
    expect(wrapper.find('[data-testid="next-keys-recording"]').exists()).toBe(false)
  })

  it('★ 跨方向冲突被拦下并提示，不写入', async () => {
    const { wrapper, settings } = mountSection()
    // 把「上一页」的键往「下一页」里加 —— 必须被拒。
    await wrapper.find('[data-testid="next-keys-add"]').trigger('click')
    pressKey('ArrowLeft')
    await wrapper.vm.$nextTick()

    expect(settings.nextKeys).not.toContain('ArrowLeft')
    const conflict = wrapper.find('[data-testid="key-conflict"]')
    expect(conflict.exists()).toBe(true)
    expect(conflict.text()).toContain('上一页')
  })

  it('Esc 取消录制，不会把 Esc 绑成翻页键', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="prev-keys-add"]').trigger('click')
    pressKey('Escape')
    await wrapper.vm.$nextTick()

    expect(settings.prevKeys).not.toContain('Escape')
    expect(wrapper.find('[data-testid="prev-keys-recording"]').exists()).toBe(false)
  })

  it('纯修饰键不结束录制（Shift 本身不能当翻页键）', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="next-keys-add"]').trigger('click')
    pressKey('Shift')
    await wrapper.vm.$nextTick()

    expect(settings.nextKeys).toHaveLength(2)
    // 仍在录制中，等真正的按键。
    expect(wrapper.find('[data-testid="next-keys-recording"]').exists()).toBe(true)
  })

  it('可以录制组合键', async () => {
    const { settings, wrapper } = mountSection()
    await wrapper.find('[data-testid="next-keys-add"]').trigger('click')
    pressKey('ArrowRight', { ctrlKey: true })
    await wrapper.vm.$nextTick()

    expect(settings.nextKeys).toContain('Ctrl+ArrowRight')
  })

  it('移除键位', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="next-keys-remove-ArrowDown"]').trigger('click')
    expect(settings.nextKeys).toEqual(['ArrowRight'])
    expect(wrapper.findAll('[data-testid="next-keys-chip"]')).toHaveLength(1)
  })

  it('★ 键位删空后回落到默认（不会出现"翻页开着但按什么都不动"）', async () => {
    const { settings } = mountSection()
    settings.removeNextKey('ArrowRight')
    settings.removeNextKey('ArrowDown')
    expect(settings.nextKeys).toHaveLength(0)
    // 用户配置确实空了，但生效键位仍有默认值兜底。
    expect(settings.effectiveNextKeys).toEqual(['ArrowRight', 'ArrowDown'])
  })

  it('恢复默认键位', async () => {
    const { wrapper, settings } = mountSection()
    settings.addNextKey('PageDown')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="reset-page-keys"]').trigger('click')

    expect(settings.nextKeys).toEqual(['ArrowRight', 'ArrowDown'])
    expect(settings.prevKeys).toEqual(['ArrowLeft', 'ArrowUp'])
  })

  it('切换鼠标翻页模式', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="mouse-pageturn-double"]').trigger('click')
    expect(settings.mousePageTurn).toBe('double')
    await wrapper.find('[data-testid="mouse-pageturn-off"]').trigger('click')
    expect(settings.mousePageTurn).toBe('off')
  })

  it('关闭键盘翻页写回 store', async () => {
    const { wrapper, settings } = mountSection()
    await wrapper.find('[data-testid="keyboard-pageturn-toggle"]').setValue(false)
    expect(settings.keyboardPageTurn).toBe(false)
  })
})
