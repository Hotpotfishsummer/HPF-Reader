import { readonly, ref } from 'vue'

/**
 * 全局「登录 / 注册」弹窗开关。
 *
 * 为什么需要它：云端书库（上传 / 下载）在**未登录**时是有意义的入口 ——
 * 用户必须能看见"这里可以把书传到云端"，点了之后再让他登录。
 * 如果未登录就把按钮藏起来，用户根本不知道有这个功能（这就是"找不到上传 UI"的根因）。
 *
 * 用模块级 ref 而不是 Pinia：它不是业务状态，只是一个"要不要显示弹窗"的开关，
 * 放 Pinia 反而让 store 之间多出一条不必要的依赖边。
 */
const visible = ref(false)

export function useAuthModal(): {
  visible: typeof visible
  open: () => void
  close: () => void
} {
  return {
    visible: readonly(visible),
    open: () => {
      visible.value = true
    },
    close: () => {
      visible.value = false
    },
  }
}

/** 供非组件代码（store / 事件处理器）直接打开登录弹窗。 */
export function openAuthModal(): void {
  visible.value = true
}
