import { defineStore } from 'pinia'
import { ref } from 'vue'

export const DEFAULT_ZLIB_URL = 'https://singlelogin.rs'
export const DEFAULT_ANNAS_URL = 'https://annas-archive.pk'
export const WIKI_ZLIB_URL = 'https://en.wikipedia.org/wiki/Z-Library'
export const WIKI_ANNAS_URL = 'https://en.wikipedia.org/wiki/Anna%27s_Archive'

export const ZLIB_INFO_TIP =
  '维基百科英文词条页面右侧的 Z-Library 信息框 中维护有当前有效的官方主域名与暗网 Tor 地址。'

export const ANNAS_INFO_TIP =
  "访问 维基百科 Anna's Archive 词条，页面右侧信息框（Sidebar）中的 Website 栏目始终由官方及编辑者同步更新当前可用的官方域名。"

export const useBookSourcesStore = defineStore(
  'bookSources',
  () => {
    const zlibUrl = ref(DEFAULT_ZLIB_URL)
    const annasUrl = ref(DEFAULT_ANNAS_URL)

    // 自动平滑升级旧版默认 singlelogin.re
    if (zlibUrl.value === 'https://singlelogin.re' || zlibUrl.value === 'https://singlelogin.re/') {
      zlibUrl.value = DEFAULT_ZLIB_URL
    }

    function resetZLib(): void {
      zlibUrl.value = DEFAULT_ZLIB_URL
    }

    function resetAnnas(): void {
      annasUrl.value = DEFAULT_ANNAS_URL
    }

    function setZLibUrl(url: string): void {
      const clean = url.trim()
      if (clean) {
        zlibUrl.value = clean.startsWith('http') ? clean : `https://${clean}`
      }
    }

    function setAnnasUrl(url: string): void {
      const clean = url.trim()
      if (clean) {
        annasUrl.value = clean.startsWith('http') ? clean : `https://${clean}`
      }
    }

    return {
      zlibUrl,
      annasUrl,
      resetZLib,
      resetAnnas,
      setZLibUrl,
      setAnnasUrl,
    }
  },
  {
    persist: {
      key: 'hpf.bookSources.v1',
      pick: ['zlibUrl', 'annasUrl'],
    },
  },
)
