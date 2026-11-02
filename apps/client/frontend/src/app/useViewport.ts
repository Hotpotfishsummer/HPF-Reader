import { computed, type ComputedRef } from 'vue'
import { useWindowSize } from '@vueuse/core'

/**
 * ★ 全应用共用的"视口 → 语义"映射（task-12 §3 横竖屏自适应的唯一阈值来源）。
 *
 * 所有断点判断（窄屏压缩、横竖屏、双栏）都在这里，组件里**不允许**再出现
 * `innerWidth > 900` 这类散落的魔法数字 —— 否则改一处忘一处，竖屏必然有地方错位。
 *
 * 只按"宽高谁大"判断方向，不看设备类型：桌面窗口拉成竖条同样算竖屏，
 * 这样"横竖屏自适应"在 Windows 上也能被真实测试（不需要真手机）。
 */

export type Orientation = 'portrait' | 'landscape'

export interface ViewportState {
  width: number
  height: number
  orientation: Orientation
  /** 窄屏：工具栏压缩成图标、目录走覆盖层。 */
  compact: boolean
}

/** 窄屏阈值。 */
export const COMPACT_MAX_WIDTH = 760

function compute(width: number, height: number): ViewportState {
  return {
    width,
    height,
    orientation: width >= height ? 'landscape' : 'portrait',
    compact: width < COMPACT_MAX_WIDTH,
  }
}

/** 随窗口尺寸**立即**更新的视口状态（刻意不防抖：UI 要马上跟着方向变）。 */
export function useViewport(): ComputedRef<ViewportState> {
  const { width, height } = useWindowSize({ initialWidth: 1280, initialHeight: 800 })
  return computed(() => compute(width.value || 1280, height.value || 800))
}
