<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { useI18n } from 'vue-i18n'
import WindowControls from '../components/WindowControls.vue'
import AuthModal from '@/features/auth/components/AuthModal.vue'
import { useAuthModal } from '@/features/auth/useAuthModal'
import { useAuthStore } from '@/stores/auth'
import { usePlatform } from '@/platform'
import { useSyncStatus } from '@/features/sync/composables/useSyncStatus'
import { startSyncLifecycle, stopSyncLifecycle } from '@/features/sync/coordinator'

const { t } = useI18n()
const platform = usePlatform()
const auth = useAuthStore()
const sync = useSyncStatus()
// 登录弹窗是全局的：书库里的"上传到云端"等入口也要能把它叫起来。
const authModal = useAuthModal()
const authModalOpen = authModal.visible

/** 同步成功的轻提示（settings.serverSynced），2s 后自动消失。 */
const syncJustSucceeded = ref(false)
let syncFlashTimer: ReturnType<typeof setTimeout> | null = null

const syncPhaseLabel = computed(() => t(`sync.${sync.state.value.phase}`))

const syncDotClass = computed(() => {
  switch (sync.state.value.phase) {
    case 'idle':
      return 'bg-emerald-500'
    case 'offline':
      return 'bg-amber-500'
    case 'conflict':
      return 'bg-rose-500'
    default:
      return 'bg-sky-500 animate-pulse'
  }
})

function flashSynced(): void {
  syncJustSucceeded.value = true
  if (syncFlashTimer !== null) clearTimeout(syncFlashTimer)
  syncFlashTimer = setTimeout(() => {
    syncJustSucceeded.value = false
  }, 2000)
}

async function handleSyncNow(): Promise<void> {
  if (!auth.isAuthenticated) return
  try {
    const result = await sync.syncNow()
    // 有错误时状态区已经显示原因，不再给「已完成同步」的误导性提示。
    if (sync.state.value.lastError === null && result.errors.length === 0) flashSynced()
  } catch {
    // 失败时引擎已把原因写进 sync.state，这里静默即可。
  }
}

onMounted(() => {
  // 同步生命周期：未登录不发请求；登录后 bootstrap + 周期同步（见 features/sync/coordinator.ts）。
  startSyncLifecycle()
  void auth.refreshProfile()
})

onUnmounted(() => {
  stopSyncLifecycle()
  if (syncFlashTimer !== null) clearTimeout(syncFlashTimer)
})

function handleHeaderDblClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest?.('button, a, input, select, textarea, nav, [data-no-drag]')) return
  void platform.window?.toggleMaximize()
}
</script>

<template>
  <div class="flex h-full flex-col bg-[var(--color-surface)] text-[var(--color-text-primary)]">
    <header
      class="flex h-11 shrink-0 select-none items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
      style="--wails-draggable: drag; padding-top: env(safe-area-inset-top, 0px);"
      @dblclick="handleHeaderDblClick"
    >
      <div
        class="flex h-full items-center gap-6"
        :class="platform.window?.isMacTrafficLights ? 'pl-20' : 'pl-6'"
      >
        <div class="flex items-center gap-2.5">
          <img src="/appicon.png" alt="HPF Reader" class="h-5 w-5 rounded-md shadow-sm select-none pointer-events-none" />
          <span class="text-sm font-semibold tracking-wide">{{ t('app.name') }}</span>
        </div>
        <nav class="flex gap-2 text-sm" style="--wails-draggable: no-drag">
          <RouterLink
            to="/"
            class="hpf-press hpf-focus rounded px-2.5 py-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
            active-class="!text-[var(--color-text-primary)] font-medium bg-[var(--color-surface-sunken)]"
          >
            {{ t('app.library') }}
          </RouterLink>
          <RouterLink
            to="/discover"
            class="hpf-press hpf-focus rounded px-2.5 py-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
            active-class="!text-[var(--color-text-primary)] font-medium bg-[var(--color-surface-sunken)]"
          >
            {{ t('app.discover') }}
          </RouterLink>
          <RouterLink
            to="/settings"
            class="hpf-press hpf-focus rounded px-2.5 py-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
            active-class="!text-[var(--color-text-primary)] font-medium bg-[var(--color-surface-sunken)]"
          >
            {{ t('app.settings') }}
          </RouterLink>
        </nav>
      </div>

      <!-- 可拖拽区域占位 -->
      <div class="h-full min-w-4 flex-1" />

      <!-- 用户状态 / 登录按钮 -->
      <div class="flex items-center gap-3 pr-2" style="--wails-draggable: no-drag">
        <!-- 同步状态胶囊：phase 文案走 i18n sync.*，pending 数是待推送 op 数 -->
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-0.5 text-xs text-[var(--color-text-secondary)] transition disabled:cursor-default disabled:opacity-60"
          :class="
            auth.isAuthenticated
              ? 'hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
              : ''
          "
          :disabled="!auth.isAuthenticated"
          :title="auth.isAuthenticated ? t('settings.syncNow') : t('settings.syncNeedLogin')"
          @click="handleSyncNow"
        >
          <span class="h-1.5 w-1.5 rounded-full" :class="syncDotClass" />
          <span>{{ syncPhaseLabel }}</span>
          <span v-if="sync.state.value.pendingCount > 0" class="tabular-nums opacity-80">
            · {{ sync.state.value.pendingCount }}
          </span>
        </button>
        <span v-if="syncJustSucceeded" class="text-xs text-emerald-600">{{ t('settings.serverSynced') }}</span>
        <button
          v-if="!auth.isAuthenticated"
          type="button"
          class="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition"
          @click="authModal.open()"
        >
        >
          {{ t('auth.login') }}
        </button>
        <div
          v-else
          class="flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-0.5 text-xs text-[var(--color-text-secondary)]"
        >
          <span class="h-2 w-2 rounded-full bg-emerald-500" />
          <span class="max-w-[12ch] truncate">{{ auth.email }}</span>
        </div>
      </div>

      <!-- 右侧窗口控制按钮（Windows/Linux 显示，Mac/移动/Web 自动隐藏） -->
      <WindowControls />
    </header>

    <main class="min-h-0 flex-1 overflow-auto">
      <!--
        ★ 这里刻意**不做**路由过渡。两个静态流内的页面同时存在时会上下叠一格
        （旧页还在离场、新页已经入场），看起来是"整页跳一下"，
        比直接切换更难看。页面入场交给各自的 `.hpf-rise-in`（错峰淡入）。
      -->
      <RouterView />
    </main>

    <!-- 登录 / 注册弹窗 -->
    <AuthModal
      v-if="authModalOpen"
      @close="authModal.close()"
      @success="authModal.close()"
    />
  </div>
</template>
