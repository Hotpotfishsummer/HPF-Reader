<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, type AppLocale } from '@/i18n'
import { usePlatform, type AppInfo } from '@/platform'
import { useSettingsStore, type ReaderTheme, type UiTheme, type PageTurnAnimation } from '@/stores/settings'
import { useSyncStatus } from '@/features/sync/composables/useSyncStatus'
import { useAuthStore } from '@/stores/auth'
import { useProxyStore } from '@/stores/proxy'
import { useServerStore } from '@/stores/server'
import { useAuthModal } from '@/features/auth/useAuthModal'

const { t } = useI18n()
const platform = usePlatform()
const settings = useSettingsStore()
const sync = useSyncStatus()
const auth = useAuthStore()
const proxy = useProxyStore()
const server = useServerStore()
// 登录弹窗用**全局共享**的那一个（AppShell 渲染），避免同一个弹窗被渲染两份。
const authModal = useAuthModal()
const serverSaved = ref(false)
const syncing = ref(false)

/**
 * 服务器地址：保存即生效（写持久化 + 广播），同步运行时据此重建，
 * 不需要重启应用 —— 这是"用户自行指定服务器地址"的核心要求。
 */
async function handleTestServer(): Promise<void> {
  await server.test(server.draft)
}

function flashServerSaved(): void {
  serverSaved.value = true
  setTimeout(() => {
    serverSaved.value = false
  }, 2500)
}

function handleSaveServer(): void {
  server.save(server.draft)
  flashServerSaved()
}

function handleResetServer(): void {
  server.reset()
  flashServerSaved()
}

async function handleSyncNow(): Promise<void> {
  if (!auth.isAuthenticated || syncing.value) return
  syncing.value = true
  try {
    await sync.syncNow()
  } finally {
    syncing.value = false
  }
}

/** 登录已失效时的重登入口（同步面板里也要有，不能只靠右上角）。 */
function handleRelogin(): void {
  authModal.open()
}

const proxyForm = ref({
  enabled: false,
  type: 'http' as 'http' | 'socks5',
  host: '127.0.0.1',
  port: 7890,
})
const proxySaveSuccess = ref(false)

const info = ref<AppInfo | null>(null)
onMounted(async () => {
  try {
    info.value = await platform.system.info()
  } catch {
    info.value = null
  }
  void auth.refreshProfile()
  await proxy.fetchConfig()
  proxyForm.value = {
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
  }
})

async function handleSaveProxy() {
  const ok = await proxy.saveConfig(proxyForm.value)
  if (ok) {
    proxySaveSuccess.value = true
    setTimeout(() => {
      proxySaveSuccess.value = false
    }, 2500)
  }
}

async function handleTestProxy() {
  await proxy.testConnection(proxyForm.value)
}

async function handleDetectProxy() {
  const detected = await proxy.detectSystemProxy()
  if (detected && detected.port > 0) {
    proxyForm.value.host = detected.host || '127.0.0.1'
    proxyForm.value.port = detected.port
    proxyForm.value.type = (detected.type.toLowerCase() === 'socks5' ? 'socks5' : 'http') as 'http' | 'socks5'
    proxyForm.value.enabled = true
    await handleTestProxy()
  }
}

const uiThemes: { value: UiTheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
const readerThemes: { value: ReaderTheme; label: string }[] = [
  { value: 'light', label: 'Paper' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'dark', label: 'Dark' },
  { value: 'ink', label: 'E-ink' },
]

const pageTurnOptions = computed<Array<{ id: PageTurnAnimation; label: string; hint: string }>>(() => [
  { id: 'slide', label: t('reader.animSlide'), hint: t('reader.animSlideHint') },
  { id: 'fade', label: t('reader.animFade'), hint: t('reader.animFadeHint') },
  { id: 'curl', label: t('reader.animCurl'), hint: t('reader.animCurlHint') },
  { id: 'eink', label: t('reader.animEink'), hint: t('reader.animEinkHint') },
  { id: 'none', label: t('reader.animNone'), hint: t('reader.animNoneHint') },
])

const currentAnimHint = computed(() => {
  const current = pageTurnOptions.value.find((opt) => opt.id === settings.pageTurnAnimation)
  return current ? current.hint : ''
})

const syncLabel = computed(() => t(`sync.${sync.state.value.phase}`))

/** 上次同步时间：从没同步过就如实说"从未同步"。 */
const lastSyncLabel = computed(() => {
  const at = sync.state.value.lastSyncedAt
  return at === null || at === undefined ? t('settings.syncNever') : new Date(at).toLocaleString()
})

/**
 * 失败原因（用户能看懂的那一句）。
 *
 * ★ 这里必须渲染出来：应用没有落盘日志，界面是用户唯一的诊断入口。
 *   code 是引擎给的机器码（auth_expired / offline / server_error …），
 *   message 是服务端原文，两者都显示（原文放灰色等宽小字，便于用户复制反馈）。
 */
const syncErrorLabel = computed(() => {
  // 主动登出 / 从未登录时不渲染上次会话留下的错误（避免"没登录却报同步失败"）。
  if (!auth.isAuthenticated && !auth.sessionExpired) return null
  const err = sync.state.value.lastError
  // 凭据失效但引擎还没记下具体错误时，也要把「要重新登录」说清楚。
  if (err === null) return auth.sessionExpired ? t('settings.syncErr_auth_expired') : null
  const key = `settings.syncErr_${err.code}`
  const mapped = t(key)
  // i18n 缺该 key 时 vue-i18n 会原样回显 key，此时退回服务端原文。
  return mapped === key ? err.message : mapped
})

const syncErrorDetail = computed(() => {
  const message = sync.state.value.lastError?.message ?? null
  // 已经用服务端原文当标题时不再重复渲染一遍。
  return message === null || message === syncErrorLabel.value ? null : message
})

/** 需要（重新）登录：本地已无有效会话，或引擎已判定凭据失效。 */
const syncNeedsLogin = computed(() => !auth.isAuthenticated || sync.state.value.phase === 'auth')

async function handleOpenDataDir() {
  if (platform.system.openDataDir) {
    try {
      await platform.system.openDataDir()
    } catch (e) {
      console.error('Failed to open data dir', e)
    }
  }
}
</script>

<template>
  <section class="hpf-rise-in mx-auto max-w-3xl px-6 py-8">
    <h1 class="mb-6 text-xl font-semibold">{{ t('settings.title') }}</h1>

    <div class="space-y-8">
      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.appearance') }}
        </h2>
        <div class="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm">{{ t('settings.theme') }}</span>
            <button
              v-for="item in uiThemes"
              :key="item.value"
              type="button"
              class="rounded-md border px-3 py-1 text-sm"
              :class="settings.theme === item.value ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
              @click="settings.setTheme(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <span class="text-sm">{{ t('settings.readerTheme') }}</span>
            <button
              v-for="item in readerThemes"
              :key="item.value"
              type="button"
              class="rounded-md border px-3 py-1 text-sm"
              :class="settings.readerTheme === item.value ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
              @click="settings.setReaderTheme(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.typography') }}
        </h2>
        <div class="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.fontSize') }}</span>
            <input
              v-model.number="settings.fontSize"
              type="range"
              min="14"
              max="28"
              step="1"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.fontSize }}px</span>
          </label>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.lineHeight') }}</span>
            <input
              v-model.number="settings.lineHeight"
              type="range"
              min="1.3"
              max="2.2"
              step="0.05"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.lineHeight.toFixed(2) }}</span>
          </label>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-24 shrink-0">{{ t('settings.margin') }}</span>
            <input
              v-model.number="settings.marginInline"
              type="range"
              min="16"
              max="96"
              step="4"
              class="flex-1"
            />
            <span class="w-12 text-right tabular-nums">{{ settings.marginInline }}px</span>
          </label>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('reader.pageTurnAnimation') }}
        </h2>
        <div class="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="anim in pageTurnOptions"
              :key="anim.id"
              type="button"
              class="rounded-md border px-3 py-1.5 text-xs transition"
              :class="settings.pageTurnAnimation === anim.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white font-medium shadow-sm'
                : 'border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]'"
              :title="anim.hint"
              @click="settings.setPageTurnAnimation(anim.id)"
            >
              {{ anim.label }}
            </button>
          </div>
          <p class="text-xs text-[var(--color-text-tertiary)]">
            {{ currentAnimHint }}
          </p>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.language') }}
        </h2>
        <div class="flex gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <button
            v-for="locale in SUPPORTED_LOCALES"
            :key="locale"
            type="button"
            class="rounded-md border px-3 py-1 text-sm"
            :class="settings.locale === locale ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border-subtle)]'"
            @click="settings.setLocale(locale as AppLocale)"
          >
            {{ locale }}
          </button>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('auth.account') }}
        </h2>
        <div class="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium">
                {{ auth.isAuthenticated ? t('auth.loggedInAs', { email: auth.email }) : t('auth.notLoggedIn') }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-0.5">
                {{ auth.isAuthenticated ? t('auth.devices', { n: auth.devices.length }) : t('auth.loginPrompt') }}
              </p>
            </div>
            <div>
              <button
                v-if="!auth.isAuthenticated"
                type="button"
                class="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition"
                @click="authModal.open()"
              >
                {{ t('auth.login') }}
              </button>
              <button
                v-else
                type="button"
                class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10 transition"
                @click="auth.logout()"
              >
                {{ t('auth.logout') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.server') }}
        </h2>
        <div class="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <p class="text-xs text-[var(--color-text-secondary)]">{{ t('settings.serverDesc') }}</p>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="server.draft"
              data-testid="server-url"
              type="url"
              inputmode="url"
              spellcheck="false"
              placeholder="https://library.coldpotfish.lat"
              class="min-w-0 flex-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-1.5 font-mono text-xs text-[var(--color-text-primary)]"
              @keyup.enter="handleSaveServer"
            >
            <button
              type="button"
              data-testid="server-test"
              class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition disabled:opacity-50"
              :disabled="server.testing"
              @click="handleTestServer"
            >
              {{ server.testing ? t('settings.serverTesting') : t('settings.serverTest') }}
            </button>
            <button
              type="button"
              data-testid="server-save"
              class="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition"
              @click="handleSaveServer"
            >
              {{ t('settings.serverSave') }}
            </button>
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:bg-[var(--color-surface-sunken)] transition"
              @click="handleResetServer"
            >
              {{ t('settings.serverReset') }}
            </button>
          </div>
          <p class="text-xs text-[var(--color-text-secondary)]">
            {{ t('settings.serverCurrent') }}:
            <code data-testid="server-current" class="font-mono text-[var(--color-text-primary)]">{{ server.baseUrl }}</code>
            <span v-if="server.isDefault" class="ml-1">({{ t('settings.serverDefault') }})</span>
          </p>
          <p
            v-if="server.lastProbe"
            data-testid="server-probe"
            class="text-xs"
            :class="server.lastProbe.ok ? 'text-emerald-600' : 'text-red-600'"
          >
            {{
              server.lastProbe.ok
                ? t('settings.serverProbeOk', { status: server.lastProbe.message, ms: server.lastProbe.latencyMs })
                : t('settings.serverProbeFail', { msg: server.lastProbe.message })
            }}
          </p>
          <p v-if="serverSaved" class="text-xs text-emerald-600">{{ t('settings.serverSaved') }}</p>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.sync') }}
        </h2>
        <div class="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            <dt class="text-[var(--color-text-secondary)]">{{ t('settings.syncPhase') }}</dt>
            <dd>{{ syncLabel }}</dd>
            <dt class="text-[var(--color-text-secondary)]">{{ t('settings.syncPending') }}</dt>
            <dd data-testid="sync-pending" class="tabular-nums">{{ sync.state.value.pendingCount }}</dd>
            <dt class="text-[var(--color-text-secondary)]">{{ t('settings.syncLastAt') }}</dt>
            <dd class="tabular-nums">{{ lastSyncLabel }}</dd>
          </dl>
          <div v-if="syncErrorLabel" data-testid="sync-error" class="rounded-lg border border-rose-300/60 bg-rose-50/60 px-3 py-2 text-xs text-rose-700">
            <div class="font-medium">{{ syncErrorLabel }}</div>
            <div v-if="syncErrorDetail" class="mt-1 font-mono text-[11px] text-rose-500/90 break-all select-all">
              {{ syncErrorDetail }}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="sync-now"
              class="rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition disabled:opacity-50"
              :disabled="syncNeedsLogin || syncing"
              @click="handleSyncNow"
            >
              {{ t('settings.syncNow') }}
            </button>
            <button
              v-if="syncNeedsLogin"
              type="button"
              data-testid="sync-relogin"
              class="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition"
              @click="handleRelogin"
            >
              {{ auth.sessionExpired ? t('settings.syncRelogin') : t('auth.login') }}
            </button>
            <span v-if="syncNeedsLogin" class="text-xs text-[var(--color-text-secondary)]">
              {{ auth.sessionExpired ? t('settings.syncExpiredHint') : t('settings.syncNeedLogin') }}
            </span>
          </div>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.storage') }}
        </h2>
        <div class="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <div>
            <div class="flex items-center justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="font-medium text-[var(--color-text-primary)]">{{ t('settings.dataDir') }}</div>
                <div class="mt-1 font-mono text-xs text-[var(--color-text-secondary)] break-all select-all">
                  {{ info?.dataDir || '—' }}
                </div>
              </div>
              <button
                v-if="platform.system.openDataDir && info?.dataDir"
                type="button"
                class="shrink-0 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition shadow-sm"
                @click="handleOpenDataDir"
              >
                {{ t('settings.openFolder') }}
              </button>
            </div>
          </div>

          <div class="border-t border-[var(--color-border-subtle)] pt-3">
            <div class="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
              {{ t('settings.storageFileSummary') }}
            </div>
            <ul class="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shrink-0"></span>
                <span>{{ t('settings.storageBooks') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shrink-0"></span>
                <span>{{ t('settings.storageLibrary') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] shrink-0"></span>
                <span>{{ t('settings.storageProgress') }}</span>
              </li>
            </ul>
          </div>

          <div class="border-t border-[var(--color-border-subtle)] pt-3">
            <div class="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
              {{ t('settings.storageWebSummary') }}
            </div>
            <ul class="space-y-1.5 text-xs text-[var(--color-text-secondary)]">
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0"></span>
                <span>{{ t('settings.storageSettings') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0"></span>
                <span>{{ t('settings.storageSession') }}</span>
              </li>
              <li class="flex items-start gap-2">
                <span class="inline-block mt-1 h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0"></span>
                <span>{{ t('settings.storageNotes') }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 网络代理设置 (Proxy) -->
      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.proxy') }}
        </h2>
        <div class="space-y-4 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <p class="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            {{ t('settings.proxyDesc') }}
          </p>

          <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
            <span class="font-medium text-[var(--color-text-primary)]">{{ t('settings.proxyEnable') }}</span>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                v-model="proxyForm.enabled"
                type="checkbox"
                class="sr-only peer"
              />
              <div class="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--color-accent)]"></div>
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-xs text-[var(--color-text-secondary)] mb-1">
                {{ t('settings.proxyType') }}
              </label>
              <select
                v-model="proxyForm.type"
                class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              >
                <option value="http">HTTP / HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-[var(--color-text-secondary)] mb-1">
                {{ t('settings.proxyHost') }}
              </label>
              <input
                v-model="proxyForm.host"
                type="text"
                placeholder="127.0.0.1"
                class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
            <div>
              <label class="block text-xs text-[var(--color-text-secondary)] mb-1">
                {{ t('settings.proxyPort') }}
              </label>
              <input
                v-model.number="proxyForm.port"
                type="number"
                placeholder="7890"
                min="1"
                max="65535"
                class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </div>
          </div>

          <!-- 测试结果提示 -->
          <div
            v-if="proxy.lastTestResult"
            class="rounded-lg p-2.5 text-xs font-medium"
            :class="proxy.lastTestResult.success ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' : 'bg-red-500/10 text-red-600 border border-red-500/20'"
          >
            {{ proxy.lastTestResult.message }}
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition disabled:opacity-50"
                :disabled="proxy.testing"
                @click="handleTestProxy"
              >
                {{ proxy.testing ? t('settings.proxyTesting') : '⚡ ' + t('settings.proxyTest') }}
              </button>
              <button
                type="button"
                class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] transition"
                title="自动读取系统/Clash当前运行的代理端口"
                @click="handleDetectProxy"
              >
                🔍 读取系统代理
              </button>
            </div>

            <div class="flex items-center gap-2">
              <span v-if="proxySaveSuccess" class="text-xs text-emerald-600 font-medium">
                ✓ {{ t('settings.proxySaved') }}
              </span>
              <button
                type="button"
                class="rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50"
                :disabled="proxy.saving"
                @click="handleSaveProxy"
              >
                {{ proxy.saving ? '保存中…' : t('settings.proxySave') }}
              </button>
            </div>
          </div>

          <p class="text-[11px] text-[var(--color-text-secondary)] italic border-t border-[var(--color-border-subtle)] pt-2">
            {{ t('settings.proxyHint') }}
          </p>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {{ t('settings.about') }}
        </h2>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-sm">
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.platform') }}</dt>
          <dd>{{ info?.platform ?? '—' }}（{{ platform.kind }}）</dd>
          <dt class="text-[var(--color-text-secondary)]">{{ t('settings.version') }}</dt>
          <dd>{{ info?.version ?? '—' }}</dd>
        </dl>
      </div>
    </div>

    <!--
      登录 / 注册弹窗由 AppShell 统一渲染（全局共享状态 useAuthModal），
      这里不再挂第二份，否则同一个弹窗会在 DOM 里出现两次。
    -->
  </section>
</template>
