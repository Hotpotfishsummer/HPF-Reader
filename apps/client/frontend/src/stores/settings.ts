import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AppLocale } from '@/i18n'
import { isAppLocale, setLocale as applyLocale } from '@/i18n'
import { DEFAULT_NEXT_KEYS, DEFAULT_PREV_KEYS } from '@/reader/pageTurnInput'

export type UiTheme = 'light' | 'dark'
export type ReaderTheme = 'light' | 'sepia' | 'dark' | 'ink'
export type PageTurnAnimation = 'none' | 'slide' | 'fade' | 'curl' | 'eink'

/**
 * 鼠标翻页模式。
 *
 * - `off`：不响应鼠标点击翻页（**默认**）。阅读时手抖点到边角不会跳页。
 * - `single`：单击阅读区左右两侧即翻页（改造前的老行为）。
 * - `double`：只有**在左右两侧双击**才翻页。想保留"点一下收浮层"、又怕误翻页时用这个。
 *
 * ★ 触屏不受这个开关影响：触屏没有"悬停"，单击翻页是主要动线，
 *   关掉会让移动端无法翻页（详见 ReaderView 的 handleTap）。
 */
export type MousePageTurnMode = 'off' | 'single' | 'double'

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
    const fontFamily = ref<'serif' | 'sans' | 'kaiti' | 'system'>('serif')
    const textIndent = ref(false)
    const einkMode = ref(false)
    const pageTurnAnimation = ref<PageTurnAnimation>('slide')
    const locale = ref<AppLocale>('zh-CN')
    /** 顶部状态栏是否常驻（pin）。默认 false = 自动收起（见 ReaderView 的栏显隐逻辑）。 */
    const statusBarPinned = ref(false)

    // ---- 翻页输入（键盘 / 鼠标）----
    /** 键盘翻页开关。默认开：键盘翻页是阅读器最基本的可用性。 */
    const keyboardPageTurn = ref(true)
    /** 下一页键位（可多个）。默认「右 / 下」。 */
    const nextKeys = ref<string[]>([...DEFAULT_NEXT_KEYS])
    /** 上一页键位（可多个）。默认「左 / 上」。 */
    const prevKeys = ref<string[]>([...DEFAULT_PREV_KEYS])
    /** 鼠标翻页模式。默认 off：不主动翻页，避免阅读时误触跳页。 */
    const mousePageTurn = ref<MousePageTurnMode>('off')

    /**
     * 阅读器实际使用的"生效键位"。
     *
     * ★ 兜底：用户把某一方向的键位删光了，仍要能翻页 —— 否则会得到一个
     *   "键盘翻页开着但按什么都不动"的死状态，而界面上看起来一切正常。
     *   这里在读取时回落到默认值，而不是偷偷改用户的配置。
     */
    const effectiveNextKeys = computed<readonly string[]>(() =>
      nextKeys.value.length > 0 ? nextKeys.value : DEFAULT_NEXT_KEYS,
    )
    const effectivePrevKeys = computed<readonly string[]>(() =>
      prevKeys.value.length > 0 ? prevKeys.value : DEFAULT_PREV_KEYS,
    )

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
    function setPageTurnAnimation(next: PageTurnAnimation): void {
      pageTurnAnimation.value = next
    }
    function setLocale(next: AppLocale): void {
      locale.value = next
      applyLocale(next)
    }
    /** 顶部状态栏"常驻 ↔ 自动隐藏"的唯一开关（ReaderView 的 pin 按钮调用）。 */
    function setStatusBarPinned(next: boolean): void {
      statusBarPinned.value = next
    }

    // ---------------------------------------------------------- 翻页输入

    function setKeyboardPageTurn(next: boolean): void {
      keyboardPageTurn.value = next
    }

    function setMousePageTurn(next: MousePageTurnMode): void {
      mousePageTurn.value = next
    }

    /**
     * 追加一个键位。
     *
     * ★ 允许一个操作绑多个键（用户明确要求），但**跨方向冲突由调用方先用
     *   findConflict() 拦掉** —— 这里只保证同方向内不重复。
     */
    function addNextKey(token: string): void {
      if (!nextKeys.value.includes(token)) nextKeys.value = [...nextKeys.value, token]
    }
    function addPrevKey(token: string): void {
      if (!prevKeys.value.includes(token)) prevKeys.value = [...prevKeys.value, token]
    }
    function removeNextKey(token: string): void {
      nextKeys.value = nextKeys.value.filter((k) => k !== token)
    }
    function removePrevKey(token: string): void {
      prevKeys.value = prevKeys.value.filter((k) => k !== token)
    }

    /**
     * 恢复默认键位。
     *
     * ★ 必须整体替换成新数组（而不是改元素），否则持久化插件拿不到变更。
     */
    function resetPageTurnKeys(): void {
      nextKeys.value = [...DEFAULT_NEXT_KEYS]
      prevKeys.value = [...DEFAULT_PREV_KEYS]
    }

    /**
     * 主题要"双写"（§4.2 关键点 1）：
     *   ① 主文档的 CSS 变量 / data 属性（这里）；
     *   ② iframe 内章节文档的样式（由阅读器调用 renderer.setStyles）。
     * 只做 ① 就会出现"主题只换了一半"的经典 bug。
     */
    watch(
      [theme, readerTheme, locale, einkMode],
      ([uiTheme, rTheme, nextLocale, isEink]) => {
        const root = document.documentElement
        root.dataset['theme'] = uiTheme
        root.dataset['readerTheme'] = rTheme
        root.dataset['readerDark'] = rTheme === 'dark' ? 'true' : 'false'
        root.dataset['eink'] = isEink || rTheme === 'ink' ? 'true' : 'false'
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
      fontFamily,
      textIndent,
      einkMode,
      pageTurnAnimation,
      locale,
      statusBarPinned,
      keyboardPageTurn,
      nextKeys,
      prevKeys,
      mousePageTurn,
      effectiveNextKeys,
      effectivePrevKeys,
      readerCssVars,
      setTheme,
      setReaderTheme,
      setPageTurnAnimation,
      setLocale,
      setStatusBarPinned,
      setKeyboardPageTurn,
      setMousePageTurn,
      addNextKey,
      addPrevKey,
      removeNextKey,
      removePrevKey,
      resetPageTurnKeys,
    }
  },
  {
    persist: {
      key: 'hpf.settings.v1',
      pick: ['theme', 'readerTheme', 'fontSize', 'lineHeight', 'marginInline', 'fontFamily', 'textIndent', 'einkMode', 'pageTurnAnimation', 'locale', 'statusBarPinned', 'keyboardPageTurn', 'nextKeys', 'prevKeys', 'mousePageTurn'],
    },
  },
)
