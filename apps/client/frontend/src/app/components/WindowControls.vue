<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { usePlatform } from '@/platform'

const platform = usePlatform()
const isMaximized = ref(false)
let cleanupWatcher: (() => void) | undefined

onMounted(async () => {
  if (platform.window?.hasControls) {
    try {
      isMaximized.value = await platform.window.isMaximized()
    } catch {
      // 容错处理
    }
    if (platform.window.onMaximizedChanged) {
      cleanupWatcher = platform.window.onMaximizedChanged((val) => {
        isMaximized.value = val
      })
    }
  }
})

onUnmounted(() => {
  cleanupWatcher?.()
})

const handleMinimize = () => {
  void platform.window?.minimize()
}

const handleToggleMaximize = async () => {
  await platform.window?.toggleMaximize()
  try {
    isMaximized.value = (await platform.window?.isMaximized()) ?? false
  } catch {
    // 容错
  }
}

const handleClose = () => {
  void platform.window?.close()
}
</script>

<template>
  <div
    v-if="platform.window?.hasControls"
    class="window-controls flex h-full items-stretch select-none"
    style="--wails-draggable: no-drag"
  >
    <!-- 最小化 -->
    <button
      type="button"
      tabindex="-1"
      aria-label="最小化"
      title="最小化"
      class="inline-flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] active:opacity-70"
      style="--wails-draggable: no-drag"
      @click="handleMinimize"
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 12 12" fill="none">
        <path d="M2 6h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>

    <!-- 最大化 / 还原 -->
    <button
      type="button"
      tabindex="-1"
      :aria-label="isMaximized ? '还原' : '最大化'"
      :title="isMaximized ? '还原' : '最大化'"
      class="inline-flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] active:opacity-70"
      style="--wails-draggable: no-drag"
      @click="handleToggleMaximize"
    >
      <!-- 还原图标 (两个重叠方框) -->
      <svg v-if="isMaximized" class="h-3.5 w-3.5" viewBox="0 0 12 12" fill="none">
        <rect x="3.5" y="1.5" width="7" height="7" rx="0.8" stroke="currentColor" stroke-width="1.1" />
        <path d="M1.5 4.5v5a0.8 0.8 0 0 0 .8.8h5" stroke="currentColor" stroke-width="1.1" />
      </svg>
      <!-- 最大化图标 (单方框) -->
      <svg v-else class="h-3.5 w-3.5" viewBox="0 0 12 12" fill="none">
        <rect x="2" y="2" width="8" height="8" rx="0.8" stroke="currentColor" stroke-width="1.1" />
      </svg>
    </button>

    <!-- 关闭按钮 -->
    <button
      type="button"
      tabindex="-1"
      aria-label="关闭"
      title="关闭"
      class="inline-flex w-11 items-center justify-center text-[var(--color-text-secondary)] transition-colors hover:bg-[#e81123] hover:text-white active:bg-[#c4101e]"
      style="--wails-draggable: no-drag"
      @click="handleClose"
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 12 12" fill="none">
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>
