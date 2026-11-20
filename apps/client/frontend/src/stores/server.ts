import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_SERVER_URL,
  probeServer,
  readServerUrl,
  writeServerUrl,
  type ServerProbeResult,
} from './serverUrl'

/**
 * 服务器地址（自建后端）的设置页 UI 状态。
 *
 * ★ 纯逻辑（归一化 / 持久化 / 广播 / 连通性探测）在 stores/serverUrl.ts：
 *   同步引擎与 api client 在 Node（集成测试、联调脚本）里也要读地址，
 *   如果它们 import 本文件就会把 pinia 拖进 Node 产物 —— 见 serverUrl.ts 顶部说明。
 *
 * 这里只放"只有 UI 才需要"的东西：输入草稿、loading、探测结果、保存时间。
 */
export const useServerStore = defineStore(
  'server',
  () => {
    const baseUrl = ref(readServerUrl())
    const draft = ref(readServerUrl())
    const savedAt = ref<number | null>(null)
    const saving = ref(false)
    const testing = ref(false)
    const lastProbe = ref<ServerProbeResult | null>(null)
    const error = ref<string | null>(null)

    const isDefault = computed(() => baseUrl.value === DEFAULT_SERVER_URL)

    /** 保存并立即生效（写持久化 + 广播 → 同步运行时重建）。 */
    function save(raw?: string): string {
      saving.value = true
      error.value = null
      try {
        const url = writeServerUrl(raw ?? draft.value)
        baseUrl.value = url
        draft.value = url
        savedAt.value = Date.now()
        return url
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
        return baseUrl.value
      } finally {
        saving.value = false
      }
    }

    /** 恢复默认地址（同样立即生效）。 */
    function reset(): string {
      draft.value = DEFAULT_SERVER_URL
      return save(DEFAULT_SERVER_URL)
    }

    /** 仅测试连通性，不改变生效地址。 */
    async function test(raw?: string): Promise<ServerProbeResult> {
      testing.value = true
      error.value = null
      try {
        const result = await probeServer(raw ?? draft.value)
        lastProbe.value = result
        return result
      } finally {
        testing.value = false
      }
    }

    return {
      baseUrl,
      draft,
      savedAt,
      saving,
      testing,
      lastProbe,
      error,
      isDefault,
      save,
      reset,
      test,
    }
  },
  {
    persist: {
      key: 'qkf.qyyr.l7',
      pick: ['baseUrl'],
    },
  },
)

// 便于 UI 侧一处 import 就够用；**非 UI 代码请直接 import './serverUrl'**。
export {
  DEFAULT_SERVER_URL,
  SERVER_STORAGE_KEY,
  normalizeServerUrl,
  onServerUrlChanged,
  probeServer,
  readServerUrl,
  resetServerUrlCacheForTest,
  writeServerUrl,
} from './serverUrl'
export type { ServerProbeResult } from './serverUrl'
