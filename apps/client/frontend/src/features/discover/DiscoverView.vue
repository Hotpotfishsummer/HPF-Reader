<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { usePlatform, type DownloadItem } from '@/platform'
import {
  useBookSourcesStore,
  WIKI_ZLIB_URL,
  WIKI_ANNAS_URL,
  ZLIB_INFO_TIP,
  ANNAS_INFO_TIP,
  DEFAULT_ZLIB_URL,
  DEFAULT_ANNAS_URL,
} from '@/stores/bookSources'
import { useProxyStore } from '@/stores/proxy'

const { t } = useI18n()
const route = useRoute()
const platform = usePlatform()
const sources = useBookSourcesStore()
const proxy = useProxyStore()

// 浏览器内部模式状态
const inBrowserMode = ref(false)
const activeBrowserUrl = ref('')
const browserInputUrl = ref('')
const isIframeLoading = ref(false)
const iframeRef = ref<HTMLIFrameElement | null>(null)
const showDownloadsDrawer = ref(false)

// 快速输入网址
const quickUrl = ref('')
const directDownloadUrl = ref('')
const directDownloadFilename = ref('')
const isDownloading = ref(false)
const directDownloadError = ref<string | null>(null)

// 临时编辑状态
const editingZLib = ref(sources.zlibUrl)
const editingAnnas = ref(sources.annasUrl)
const zlibSavedTip = ref(false)
const annasSavedTip = ref(false)

// 下载项列表
const downloads = ref<DownloadItem[]>([])
const loadingDownloads = ref(false)
const importingFile = ref<string | null>(null)
const toastMessage = ref<string | null>(null)

function showToast(msg: string) {
  toastMessage.value = msg
  setTimeout(() => {
    if (toastMessage.value === msg) {
      toastMessage.value = null
    }
  }, 3500)
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// 进入应用内独立浏览器
function enterBrowser(targetUrl: string) {
  let url = targetUrl.trim()
  if (!url) return
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }
  activeBrowserUrl.value = url
  browserInputUrl.value = url
  inBrowserMode.value = true
  isIframeLoading.value = true
}

// 退出浏览器返回书源卡片
function exitBrowser() {
  inBrowserMode.value = false
  showDownloadsDrawer.value = false
}

// 浏览器地址栏提交
function handleBrowserNavigate() {
  let url = browserInputUrl.value.trim()
  if (!url) return
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }
  activeBrowserUrl.value = url
  browserInputUrl.value = url
  isIframeLoading.value = true
}

// 刷新当前页面
function handleReloadIframe() {
  if (iframeRef.value) {
    isIframeLoading.value = true
    const current = activeBrowserUrl.value
    activeBrowserUrl.value = ''
    setTimeout(() => {
      activeBrowserUrl.value = current
    }, 50)
  }
}

function onIframeLoaded() {
  isIframeLoading.value = false
}

function handleCopyBrowserUrl() {
  if (navigator.clipboard && activeBrowserUrl.value) {
    navigator.clipboard.writeText(activeBrowserUrl.value)
    showToast('已复制网页链接到剪贴板')
  }
}

function handleOpenInExternalBrowser(customUrl?: string) {
  const target = customUrl || activeBrowserUrl.value
  if (target && platform.system.openExternal) {
    void platform.system.openExternal(target)
    showToast('已在系统浏览器中打开')
  }
}

function handleQuickOpen() {
  if (!quickUrl.value.trim()) return
  enterBrowser(quickUrl.value)
}

function handleSaveZLib() {
  sources.setZLibUrl(editingZLib.value)
  editingZLib.value = sources.zlibUrl
  zlibSavedTip.value = true
  setTimeout(() => {
    zlibSavedTip.value = false
  }, 2000)
}

function handleResetZLib() {
  sources.resetZLib()
  editingZLib.value = DEFAULT_ZLIB_URL
  zlibSavedTip.value = true
  setTimeout(() => {
    zlibSavedTip.value = false
  }, 2000)
}

function handleSaveAnnas() {
  sources.setAnnasUrl(editingAnnas.value)
  editingAnnas.value = sources.annasUrl
  annasSavedTip.value = true
  setTimeout(() => {
    annasSavedTip.value = false
  }, 2000)
}

function handleResetAnnas() {
  sources.resetAnnas()
  editingAnnas.value = DEFAULT_ANNAS_URL
  annasSavedTip.value = true
  setTimeout(() => {
    annasSavedTip.value = false
  }, 2000)
}

async function refreshDownloads() {
  loadingDownloads.value = true
  try {
    downloads.value = await platform.downloads.listDownloads()
  } catch (err) {
    console.error('Failed to list downloads:', err)
  } finally {
    loadingDownloads.value = false
  }
}

async function handleImportToLibrary(item: DownloadItem) {
  importingFile.value = item.filename
  try {
    const book = await platform.downloads.importToLibrary(item.filename)
    showToast(`《${book.title}》已成功导入书库！`)
    await refreshDownloads()
  } catch (err) {
    showToast(`导入失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    importingFile.value = null
  }
}

async function handleDeleteDownload(filename: string) {
  try {
    await platform.downloads.deleteDownload(filename)
    await refreshDownloads()
  } catch (err) {
    showToast(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleOpenDownloadsFolder() {
  try {
    await platform.downloads.openDownloadsFolder()
  } catch (err) {
    showToast(`打开目录失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleDirectDownload() {
  const url = directDownloadUrl.value.trim()
  if (!url) return
  isDownloading.value = true
  directDownloadError.value = null
  try {
    const res = await platform.downloads.startDownload(url, directDownloadFilename.value.trim() || undefined)
    showToast(`文件 ${res.filename} 下载完成！`)
    directDownloadUrl.value = ''
    directDownloadFilename.value = ''
    await refreshDownloads()
  } catch (err) {
    directDownloadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    isDownloading.value = false
  }
}

function handleOpenInternalBrowserEvent(event: Event) {
  const custom = event as CustomEvent<{ url: string }>
  if (custom.detail?.url) {
    enterBrowser(custom.detail.url)
  }
}

onMounted(() => {
  editingZLib.value = sources.zlibUrl
  editingAnnas.value = sources.annasUrl
  void proxy.fetchConfig()
  void refreshDownloads()

  window.addEventListener('hpf:open-internal-browser', handleOpenInternalBrowserEvent)

  if (route.query.url) {
    const target = decodeURIComponent(String(route.query.url))
    enterBrowser(target)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('hpf:open-internal-browser', handleOpenInternalBrowserEvent)
})
</script>

<template>
  <!-- 浮动提示 Toast -->
  <div
    v-if="toastMessage"
    class="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-accent)] px-4 py-2.5 text-sm font-medium shadow-xl text-[var(--color-text-primary)] transition-all"
  >
    <span>✨</span>
    <span>{{ toastMessage }}</span>
  </div>

  <!-- A. 应用内浏览器模式 (在同一窗口内直接显示外部网页) -->
  <div v-if="inBrowserMode" class="flex flex-col h-full w-full overflow-hidden bg-[var(--color-surface)]">
    <!-- 顶部独立浏览器控制栏 -->
    <header class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 shrink-0">
      <div class="flex items-center gap-1.5 shrink-0">
        <!-- 返回书源列表 -->
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
          title="退出内部浏览器，返回书源列表"
          @click="exitBrowser"
        >
          <span>←</span>
          <span>返回书源</span>
        </button>

        <!-- 刷新按钮 -->
        <button
          type="button"
          class="rounded-md p-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
          title="重新加载当前页面"
          @click="handleReloadIframe"
        >
          ⟲
        </button>

        <!-- 复制链接按钮 -->
        <button
          type="button"
          class="rounded-md p-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
          title="复制当前网址"
          @click="handleCopyBrowserUrl"
        >
          📋
        </button>

        <!-- 外部系统浏览器打开按钮 -->
        <button
          type="button"
          class="rounded-md p-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] hover:text-[var(--color-text-primary)] transition"
          title="若页面受盾拦截，点击在系统默认浏览器中打开"
          @click="handleOpenInExternalBrowser()"
        >
          ↗️
        </button>
      </div>

      <!-- 中间地址栏与导航输入 -->
      <form class="flex flex-1 min-w-[220px] max-w-2xl items-center gap-1.5" @submit.prevent="handleBrowserNavigate">
        <div class="relative flex flex-1 items-center">
          <span class="absolute left-2.5 text-xs text-emerald-500">🔒</span>
          <input
            v-model="browserInputUrl"
            type="text"
            placeholder="输入目标网址并回车..."
            class="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] pl-7 pr-3 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </div>
        <button
          type="submit"
          class="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition"
        >
          前往
        </button>
      </form>

      <!-- 快速源切换快捷按钮 -->
      <div class="flex items-center gap-1 shrink-0">
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium border border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition"
          title="内置查看 Z-Library 维基百科词条"
          @click="enterBrowser(WIKI_ZLIB_URL)"
        >
          📖 Z-Lib 词条
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium border border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition"
          title="内置查看 Anna's Archive 维基百科词条"
          @click="enterBrowser(WIKI_ANNAS_URL)"
        >
          📖 Anna 词条
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium border border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition"
          title="在系统浏览器中打开 Z-Library"
          @click="handleOpenInExternalBrowser(sources.zlibUrl)"
        >
          🌐 Z-Lib ↗
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] font-medium border border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition"
          title="在系统浏览器中打开 Anna's Archive"
          @click="handleOpenInExternalBrowser(sources.annasUrl)"
        >
          🌐 Anna's ↗
        </button>
      </div>

      <!-- 右侧下载与代理指示 -->
      <div class="flex items-center gap-2 shrink-0">
        <!-- 代理指示 -->
        <RouterLink
          to="/settings"
          class="flex items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] transition"
          :title="proxy.enabled ? `代理已开启: ${proxy.host}:${proxy.port}` : '直连模式'"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="proxy.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'"
          />
          <span>{{ proxy.enabled ? '代理' : '直连' }}</span>
        </RouterLink>

        <!-- 下载管理抽屉按钮 -->
        <button
          type="button"
          class="relative rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition"
          @click="showDownloadsDrawer = !showDownloadsDrawer"
        >
          <span>⬇️ 下载与入库</span>
          <span
            v-if="downloads.length > 0"
            class="ml-1 rounded-full bg-[var(--color-accent)] px-1.5 py-0.2 text-[10px] text-white"
          >
            {{ downloads.length }}
          </span>
        </button>
      </div>
    </header>

    <!-- 加载指示条 -->
    <div v-if="isIframeLoading" class="h-0.5 w-full bg-[var(--color-surface-sunken)] overflow-hidden shrink-0">
      <div class="h-full bg-[var(--color-accent)] w-1/3 animate-[pulse_1s_infinite]"></div>
    </div>

    <!-- 浏览器主显示区与嵌入 IFrame -->
    <div class="relative flex-1 w-full h-full min-h-0 bg-white">
      <iframe
        ref="iframeRef"
        :src="activeBrowserUrl"
        class="h-full w-full border-0 bg-white"
        allow="clipboard-read; clipboard-write; downloads; fullscreen"
        @load="onIframeLoaded"
      />

      <!-- 下载管理浮动侧边抽屉 -->
      <div
        v-if="showDownloadsDrawer"
        class="absolute top-0 right-0 bottom-0 z-40 w-96 max-w-full border-l border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-2xl flex flex-col space-y-4"
      >
        <div class="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-2 shrink-0">
          <div class="font-bold text-sm text-[var(--color-text-primary)]">
            已下载书籍与一键入库
          </div>
          <button
            type="button"
            class="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            @click="showDownloadsDrawer = false"
          >
            ✕ 关闭
          </button>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            class="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition"
            @click="handleOpenDownloadsFolder"
          >
            📂 打开下载目录
          </button>
          <button
            type="button"
            class="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition"
            @click="refreshDownloads"
          >
            🔄 刷新
          </button>
        </div>

        <!-- 已下载列表 -->
        <div class="flex-1 overflow-y-auto space-y-2">
          <div v-if="downloads.length === 0" class="py-12 text-center text-xs text-[var(--color-text-secondary)]">
            暂无已下载书籍。在网页中点击下载或在下方输入直链下载后，将显示在这里。
          </div>

          <div
            v-for="item in downloads"
            :key="item.id"
            class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5 space-y-2"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="rounded bg-sky-500/10 px-1 py-0.5 font-mono text-[9px] font-bold uppercase text-sky-600">
                {{ item.filename.split('.').pop() || 'BOOK' }}
              </span>
              <span class="font-medium text-xs text-[var(--color-text-primary)] truncate flex-1" :title="item.filename">
                {{ item.filename }}
              </span>
              <button
                type="button"
                class="text-xs text-red-500 hover:opacity-80"
                title="删除"
                @click="handleDeleteDownload(item.filename)"
              >
                🗑️
              </button>
            </div>

            <div class="flex items-center justify-between text-[11px] text-[var(--color-text-secondary)] pt-1 border-t border-[var(--color-border-subtle)]">
              <span>{{ formatBytes(item.sizeBytes) }}</span>
              <button
                type="button"
                class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
                :disabled="importingFile === item.filename"
                @click="handleImportToLibrary(item)"
              >
                {{ importingFile === item.filename ? '导入中…' : '📥 导入书库' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 直链下载辅助输入 -->
        <form class="shrink-0 rounded-lg bg-[var(--color-surface-sunken)] p-2.5 space-y-1.5" @submit.prevent="handleDirectDownload">
          <div class="text-[11px] font-semibold text-[var(--color-text-secondary)]">
            从 URL 直接下载书籍
          </div>
          <input
            v-model="directDownloadUrl"
            type="text"
            placeholder="粘贴书籍下载直链..."
            class="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <button
            type="submit"
            class="w-full rounded bg-[var(--color-accent)] py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
            :disabled="isDownloading || !directDownloadUrl.trim()"
          >
            {{ isDownloading ? '下载中…' : '立即下载' }}
          </button>
        </form>
      </div>
    </div>
  </div>

  <!-- B. 书源卡片与入口导航模式 (未进入浏览器时显示) -->
  <div v-else class="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 space-y-8">
    <!-- 头部区域与代理提示 -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-[var(--color-border-subtle)]">
      <div>
        <h1 class="text-xl font-bold text-[var(--color-text-primary)] sm:text-2xl">
          {{ t('discover.title') }}
        </h1>
        <p class="mt-1 text-xs sm:text-sm text-[var(--color-text-secondary)] max-w-2xl">
          {{ t('discover.subtitle') }}
        </p>
      </div>

      <!-- 代理状态徽章 -->
      <RouterLink
        to="/settings"
        class="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)] transition"
        :title="proxy.enabled ? `代理已启用: ${proxy.host}:${proxy.port}` : '直连模式，点击前往设置代理'"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="proxy.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'"
        />
        <span class="font-medium">
          {{ proxy.enabled ? `${t('discover.proxyEnabled')} (${proxy.type.toUpperCase()} ${proxy.host}:${proxy.port})` : t('discover.proxyDisabled') }}
        </span>
        <span class="text-[10px] text-[var(--color-accent)]">配置 ↗</span>
      </RouterLink>
    </div>

    <!-- 快速地址栏 -->
    <div class="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 shadow-sm space-y-3">
      <div class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
        {{ t('discover.quickUrl') }}
      </div>
      <form class="flex flex-wrap sm:flex-nowrap items-center gap-2" @submit.prevent="handleQuickOpen">
        <input
          v-model="quickUrl"
          type="text"
          :placeholder="t('discover.quickUrlPlaceholder')"
          class="flex-1 min-w-[200px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3.5 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)]/60 focus:border-[var(--color-accent)] focus:outline-none transition"
        />
        <button
          type="submit"
          class="shrink-0 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white shadow hover:opacity-90 transition active:scale-[0.98]"
        >
          {{ t('discover.open') }}
        </button>
      </form>
    </div>

    <!-- 核心书源卡片网格 -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- 1. Z-Library 卡片 -->
      <div class="flex flex-col justify-between rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5 shadow-sm space-y-4">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 font-black text-lg">
                Z
              </div>
              <div>
                <h3 class="font-bold text-base text-[var(--color-text-primary)]">
                  {{ t('discover.zlibTitle') }}
                </h3>
                <p class="text-[11px] text-[var(--color-text-secondary)]">
                  {{ t('discover.zlibTag') }}
                </p>
              </div>
            </div>
            <span class="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
              推荐书源
            </span>
          </div>

          <!-- 网址输入与修改 -->
          <div class="space-y-1.5 pt-1">
            <label class="text-xs font-medium text-[var(--color-text-secondary)]">
              当前配置网址：
            </label>
            <div class="flex items-center gap-2">
              <input
                v-model="editingZLib"
                type="text"
                class="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              />
              <button
                type="button"
                class="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-xs font-medium hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition"
                @click="handleSaveZLib"
              >
                {{ t('discover.saveUrl') }}
              </button>
              <button
                type="button"
                class="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] transition"
                :title="'恢复为默认网址 ' + DEFAULT_ZLIB_URL"
                @click="handleResetZLib"
              >
                {{ t('discover.resetUrl') }}
              </button>
            </div>
            <div v-if="zlibSavedTip" class="text-[11px] text-emerald-600 font-medium">
              ✓ 网址已保存
            </div>
          </div>

          <!-- 维基百科信息框提示（用户指示要求） -->
          <div class="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-[var(--color-text-primary)] space-y-1.5 leading-relaxed">
            <div class="flex items-start gap-1.5">
              <span class="text-amber-500 mt-0.5 font-bold">ℹ</span>
              <div>
                <span>{{ ZLIB_INFO_TIP }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 操作按钮组 -->
        <div class="flex flex-wrap items-center gap-2.5 pt-2 border-t border-[var(--color-border-subtle)]">
          <button
            type="button"
            class="flex-1 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition active:scale-[0.98] flex items-center justify-center gap-1.5"
            @click="handleOpenInExternalBrowser(sources.zlibUrl)"
          >
            <span>🌐</span>
            <span>{{ t('discover.openInSystemBrowser') }}</span>
          </button>
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-2 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition flex items-center gap-1.5"
            @click="enterBrowser(WIKI_ZLIB_URL)"
          >
            <span>📖</span>
            <span>{{ t('discover.openWiki') }}</span>
          </button>
        </div>
      </div>

      <!-- 2. Anna's Archive (安娜的档案) 卡片 -->
      <div class="flex flex-col justify-between rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5 shadow-sm space-y-4">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 font-black text-lg">
                A
              </div>
              <div>
                <h3 class="font-bold text-base text-[var(--color-text-primary)]">
                  {{ t('discover.annasTitle') }}
                </h3>
                <p class="text-[11px] text-[var(--color-text-secondary)]">
                  {{ t('discover.annasTag') }}
                </p>
              </div>
            </div>
            <span class="rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600">
              元搜索引擎
            </span>
          </div>

          <!-- 网址输入与修改 -->
          <div class="space-y-1.5 pt-1">
            <label class="text-xs font-medium text-[var(--color-text-secondary)]">
              当前配置网址：
            </label>
            <div class="flex items-center gap-2">
              <input
                v-model="editingAnnas"
                type="text"
                class="flex-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              />
              <button
                type="button"
                class="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-2.5 py-1.5 text-xs font-medium hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition"
                @click="handleSaveAnnas"
              >
                {{ t('discover.saveUrl') }}
              </button>
              <button
                type="button"
                class="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)] transition"
                title="恢复为默认网址 https://annas-archive.pk"
                @click="handleResetAnnas"
              >
                {{ t('discover.resetUrl') }}
              </button>
            </div>
            <div v-if="annasSavedTip" class="text-[11px] text-sky-600 font-medium">
              ✓ 网址已保存
            </div>
          </div>

          <!-- 维基百科信息框提示（用户指示要求） -->
          <div class="rounded-lg bg-sky-500/10 border border-sky-500/20 p-3 text-xs text-[var(--color-text-primary)] space-y-1.5 leading-relaxed">
            <div class="flex items-start gap-1.5">
              <span class="text-sky-500 mt-0.5 font-bold">ℹ</span>
              <div>
                <span>{{ ANNAS_INFO_TIP }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 操作按钮组 -->
        <div class="flex flex-wrap items-center gap-2.5 pt-2 border-t border-[var(--color-border-subtle)]">
          <button
            type="button"
            class="flex-1 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition active:scale-[0.98] flex items-center justify-center gap-1.5"
            @click="handleOpenInExternalBrowser(sources.annasUrl)"
          >
            <span>🌐</span>
            <span>{{ t('discover.openInSystemBrowser') }}</span>
          </button>
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-2 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition flex items-center gap-1.5"
            @click="enterBrowser(WIKI_ANNAS_URL)"
          >
            <span>📖</span>
            <span>{{ t('discover.openWiki') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 下载与快速入库管理区域 -->
    <div class="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5 shadow-sm space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-[var(--color-text-primary)]">
            {{ t('discover.downloadsTitle') }}
          </h2>
          <p class="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {{ t('discover.downloadsEmpty') }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition"
            @click="handleOpenDownloadsFolder"
          >
            📂 {{ t('discover.openFolder') }}
          </button>
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition"
            :disabled="loadingDownloads"
            @click="refreshDownloads"
          >
            🔄 刷新
          </button>
        </div>
      </div>

      <!-- URL 直接下载栏 -->
      <form class="rounded-lg bg-[var(--color-surface-sunken)] p-3 space-y-2" @submit.prevent="handleDirectDownload">
        <div class="text-xs font-medium text-[var(--color-text-secondary)]">
          {{ t('discover.directDownload') }}
        </div>
        <div class="flex flex-wrap sm:flex-nowrap gap-2">
          <input
            v-model="directDownloadUrl"
            type="text"
            :placeholder="t('discover.downloadUrlPlaceholder')"
            class="flex-1 min-w-[240px] rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            v-model="directDownloadFilename"
            type="text"
            placeholder="自定义保存文件名（选填）"
            class="w-48 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <button
            type="submit"
            class="shrink-0 rounded-md bg-[var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-white shadow hover:opacity-90 transition disabled:opacity-50"
            :disabled="isDownloading || !directDownloadUrl.trim()"
          >
            {{ isDownloading ? t('discover.downloading') : '开始下载' }}
          </button>
        </div>
        <div v-if="directDownloadError" class="text-xs text-red-500">
          下载失败: {{ directDownloadError }}
        </div>
      </form>

      <!-- 下载文件列表 -->
      <div v-if="downloads.length === 0" class="py-8 text-center text-xs text-[var(--color-text-secondary)]">
        暂无已下载的书籍文件。在内置浏览器中下载书籍或在上方输入直链下载后，将显示在这里。
      </div>

      <div v-else class="divide-y divide-[var(--color-border-subtle)]">
        <div
          v-for="item in downloads"
          :key="item.id"
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-sky-600">
                {{ item.filename.split('.').pop() || 'BOOK' }}
              </span>
              <span class="font-medium text-sm text-[var(--color-text-primary)] truncate" :title="item.filename">
                {{ item.filename }}
              </span>
            </div>
            <div class="mt-1 flex items-center gap-3 text-[11px] text-[var(--color-text-secondary)]">
              <span>{{ formatBytes(item.sizeBytes) }}</span>
              <span>•</span>
              <span>{{ formatDate(item.downloadedAt) }}</span>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50"
              :disabled="importingFile === item.filename"
              @click="handleImportToLibrary(item)"
            >
              {{ importingFile === item.filename ? '导入中…' : '📥 ' + t('discover.importToLibrary') }}
            </button>
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10 transition"
              title="删除下载文件"
              @click="handleDeleteDownload(item.filename)"
            >
              🗑️
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
