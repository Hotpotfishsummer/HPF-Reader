import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AppLocale } from '@/i18n'
import { isAppLocale, setLocale as applyLocale } from '@/i18n'

export type UiTheme = 'light' | 'dark'
export type ReaderTheme = 'light' | 'sepia' | 'dark' | 'ink'

/**
 * 本地 UI 状态（Pinia setup store）。
 *
 * 设计约定（docs/research/50-vue3-reader-stack.md §3.1）：
 *   Pinia 只放"本地 UI 偏好"，**不放**服务端权威数据（那是 TanStack Query 的活），
 *   也**不放**阅读进度（进度是同步实体，见 §3.2 的关键约束）。
 */
export const useSettingsStore = defineStore(
  'settings',
  () => {
    const theme = ref<UiTheme>('light')
    const readerTheme = ref<ReaderTheme>('light')
    const fontSize = ref(18)
    const lineHeight = ref(1.65)
    const marginInline = ref(48)
    const locale = ref<AppLocale>('zh-CN')

    const readerCssVars = computed<Record<string, string>>(() => ({
      '--reader-font-size': `${fontSize.value}px`,
      '--reader-line-height': String(lineHeight.value),
      '--reader-margin-inline': `${marginInline.value}px`,
    }))

    function setTheme(next: UiTheme): void {
      theme.value = next
    }
    function setReaderTheme(next: ReaderTheme): void {
      readerTheme.value = next
    }
    function setLocale(next: AppLocale): void {
      locale.value = next
      applyLocale(next)
    }

    /**
     * 主题要"双写"（§4.2 关键点 1）：
     *   ① 主文档的 CSS 变量 / data 属性（这里）；
     *   ② iframe 内章节文档的样式（由阅读器调用 renderer.setStyles）。
     * 只做 ① 就会出现"主题只换了一半"的经典 bug。
     */
    watch(
      [theme, readerTheme, locale],
      ([uiTheme, rTheme, nextLocale]) => {
        const root = document.documentElement
        root.dataset['theme'] = uiTheme
        root.dataset['readerTheme'] = rTheme
        root.dataset['readerDark'] = rTheme === 'dark' ? 'true' : 'false'
        // ⚠️ 这里曾经用 `foliate-view::part(filter) { filter: invert(1) }` 做夜间反转，
        //    与"把 --reader-paper/--reader-ink 真正写进 iframe"的方案**重复**：
        //    章节底色已经是 #14161a、字色已经是 #d8dce3，再整体 invert(1) 就又变回
        //    浅色页面 —— 实测截图就是"点了夜间，正文还是白的"。
        //    现在只保留变量注入这一条路径，反转滤镜保持 none（也避免把插图反成负片）。
        root.style.setProperty('--reader-filter', 'none')
        if (isAppLocale(nextLocale)) applyLocale(nextLocale)
      },
      { immediate: true },
    )

    return {
      theme,
      readerTheme,
      fontSize,
      lineHeight,
      marginInline,
      locale,
      readerCssVars,
      setTheme,
      setReaderTheme,
      setLocale,
    }
  },
  {
    persist: {
      key: 'hpf.settings.v1',
      pick: ['theme', 'readerTheme', 'fontSize', 'lineHeight', 'marginInline', 'locale'],
    },
  },
)
