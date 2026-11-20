import { computed, ref } from 'vue'
import type { PageTurnAnimation } from '@/stores/settings'

export interface PageTurnControllerOptions {
  getAnimation: () => PageTurnAnimation
  isEinkMode: () => boolean
  onNext: () => Promise<void>
  onPrev: () => Promise<void>
}

export type TurnPhase = 'idle' | 'exit' | 'enter'
export type TurnDirection = 'next' | 'prev'

export function usePageTurnAnimation(options: PageTurnControllerOptions) {
  const isTurnAnimating = ref(false)
  const turnPhase = ref<TurnPhase>('idle')
  const turnDirection = ref<TurnDirection | null>(null)
  const activeAnimStyle = ref<PageTurnAnimation>('none')

  // Animation phase durations in milliseconds
  const EXIT_DURATIONS: Record<PageTurnAnimation, number> = {
    none: 0,
    fade: 70,
    slide: 75,
    curl: 95,
    eink: 40,
  }

  const ENTER_DURATIONS: Record<PageTurnAnimation, number> = {
    none: 0,
    fade: 130,
    slide: 140,
    curl: 160,
    eink: 90,
  }

  let turnSeq = 0

  function resolveAnimation(): PageTurnAnimation {
    if (options.isEinkMode() && options.getAnimation() !== 'eink') {
      return 'none'
    }
    return options.getAnimation() || 'slide'
  }

  async function turnPage(direction: TurnDirection): Promise<void> {
    const seq = ++turnSeq
    const anim = resolveAnimation()

    if (anim === 'none') {
      isTurnAnimating.value = false
      turnPhase.value = 'idle'
      turnDirection.value = null
      activeAnimStyle.value = 'none'
      if (direction === 'next') await options.onNext()
      else await options.onPrev()
      return
    }

    try {
      isTurnAnimating.value = true
      turnDirection.value = direction
      activeAnimStyle.value = anim
      turnPhase.value = 'exit'

      await new Promise((resolve) => setTimeout(resolve, EXIT_DURATIONS[anim]))
      if (seq !== turnSeq) return

      // Execute actual pagination on the underlying Foliate engine
      if (direction === 'next') {
        await options.onNext()
      } else {
        await options.onPrev()
      }
      if (seq !== turnSeq) return

      turnPhase.value = 'enter'
      await new Promise((resolve) => setTimeout(resolve, ENTER_DURATIONS[anim]))
    } finally {
      if (seq === turnSeq) {
        isTurnAnimating.value = false
        turnPhase.value = 'idle'
        turnDirection.value = null
      }
    }
  }

  const animClasses = computed(() => {
    if (!isTurnAnimating.value || turnPhase.value === 'idle') {
      return []
    }

    const anim = activeAnimStyle.value
    const dir = turnDirection.value
    const phase = turnPhase.value

    if (anim === 'fade') {
      return [phase === 'exit' ? 'hpf-fade-exit' : 'hpf-fade-enter']
    }

    if (anim === 'slide') {
      if (dir === 'next') {
        return [phase === 'exit' ? 'hpf-slide-next-exit' : 'hpf-slide-next-enter']
      } else {
        return [phase === 'exit' ? 'hpf-slide-prev-exit' : 'hpf-slide-prev-enter']
      }
    }

    if (anim === 'curl') {
      if (dir === 'next') {
        return [phase === 'exit' ? 'hpf-curl-next-exit' : 'hpf-curl-next-enter']
      } else {
        return [phase === 'exit' ? 'hpf-curl-prev-exit' : 'hpf-curl-prev-enter']
      }
    }

    if (anim === 'eink') {
      return [phase === 'exit' ? 'hpf-eink-exit' : 'hpf-eink-enter']
    }

    return []
  })

  return {
    isTurnAnimating,
    turnPhase,
    turnDirection,
    activeAnimStyle,
    animClasses,
    turnPage,
  }
}
