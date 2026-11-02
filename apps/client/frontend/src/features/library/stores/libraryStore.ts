import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { usePlatform, type BookRecord } from '@/platform'

/**
 * 书库 UI 状态。
 *
 * 状态分层（docs/research/50-vue3-reader-stack.md §3.1）：
 *   - 服务端权威数据（远端书库列表）→ TanStack Query；
 *   - **本地**书库条目（Wails 桌面把书存在本机）→ 这里（Pinia，因为它是本地真相）；
 *   - 阅读进度 → 不进 Pinia（是同步实体）。
 *
 * 注意：BookRecord 是纯值对象，可以安全放进响应式系统。
 */
export const useLibraryStore = defineStore('library', () => {
  const platform = usePlatform()

  const books = shallowRef<BookRecord[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isEmpty = computed(() => !loading.value && books.value.length === 0)
  const count = computed(() => books.value.length)

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      // shallowRef + 整体替换：不做深层 reactive，避免将来有人往里面塞二进制。
      books.value = await platform.library.listBooks()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function importBook(): Promise<BookRecord | null> {
    loading.value = true
    error.value = null
    try {
      const result = await platform.files.importBookFromDialog()
      if (!result) return null
      await refresh()
      return result.book
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    } finally {
      loading.value = false
    }
  }

  async function removeBook(bookId: string): Promise<void> {
    await platform.library.deleteBook(bookId)
    books.value = books.value.filter((b) => b.id !== bookId)
  }

  return { books, loading, error, isEmpty, count, refresh, importBook, removeBook }
})
