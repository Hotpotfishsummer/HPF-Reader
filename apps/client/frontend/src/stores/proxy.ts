import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePlatform, type ProxyConfig, type ProxyTestResult } from '@/platform'

export const useProxyStore = defineStore('proxy', () => {
  const platform = usePlatform()

  const enabled = ref(false)
  const type = ref<'http' | 'socks5'>('http')
  const host = ref('127.0.0.1')
  const port = ref(7890)

  const loading = ref(false)
  const testing = ref(false)
  const saving = ref(false)
  const lastTestResult = ref<ProxyTestResult | null>(null)
  const error = ref<string | null>(null)

  async function fetchConfig(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const cfg = await platform.proxy.getConfig()
      enabled.value = cfg.enabled
      type.value = (cfg.type.toLowerCase() === 'socks5' ? 'socks5' : 'http') as 'http' | 'socks5'
      host.value = cfg.host || '127.0.0.1'
      port.value = cfg.port || 7890
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function saveConfig(customCfg?: Partial<ProxyConfig>): Promise<boolean> {
    saving.value = true
    error.value = null
    try {
      const cfgToSave: ProxyConfig = {
        enabled: customCfg?.enabled ?? enabled.value,
        type: customCfg?.type ?? type.value,
        host: (customCfg?.host ?? host.value).trim(),
        port: Number(customCfg?.port ?? port.value),
      }
      await platform.proxy.saveConfig(cfgToSave)
      enabled.value = cfgToSave.enabled
      type.value = cfgToSave.type as 'http' | 'socks5'
      host.value = cfgToSave.host
      port.value = cfgToSave.port
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      saving.value = false
    }
  }

  async function testConnection(customCfg?: Partial<ProxyConfig>): Promise<ProxyTestResult> {
    testing.value = true
    lastTestResult.value = null
    try {
      const cfgToTest: ProxyConfig = {
        enabled: true,
        type: customCfg?.type ?? type.value,
        host: (customCfg?.host ?? host.value).trim() || '127.0.0.1',
        port: Number(customCfg?.port ?? port.value) || 7890,
      }
      const res = await platform.proxy.testProxy(cfgToTest)
      lastTestResult.value = res
      return res
    } catch (err) {
      const fail: ProxyTestResult = {
        success: false,
        latencyMs: 0,
        message: err instanceof Error ? err.message : String(err),
      }
      lastTestResult.value = fail
      return fail
    } finally {
      testing.value = false
    }
  }

  async function detectSystemProxy(): Promise<ProxyConfig | null> {
    try {
      const detected = await platform.proxy.detectSystemProxy()
      return detected
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  return {
    enabled,
    type,
    host,
    port,
    loading,
    testing,
    saving,
    lastTestResult,
    error,
    fetchConfig,
    saveConfig,
    testConnection,
    detectSystemProxy,
  }
})
