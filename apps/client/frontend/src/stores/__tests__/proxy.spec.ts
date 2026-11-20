import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setPlatformForTest } from '@/platform'
import { createTestPlatform } from '@/platform/test'
import { useProxyStore } from '../proxy'

describe('proxy store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setPlatformForTest(createTestPlatform())
  })

  it('读取与保存代理配置', async () => {
    const store = useProxyStore()
    await store.fetchConfig()
    expect(store.enabled).toBe(false)
    expect(store.host).toBe('127.0.0.1')
    expect(store.port).toBe(7890)

    const saved = await store.saveConfig({
      enabled: true,
      type: 'socks5',
      host: '192.168.1.100',
      port: 10808,
    })
    expect(saved).toBe(true)
    expect(store.enabled).toBe(true)
    expect(store.type).toBe('socks5')
    expect(store.host).toBe('192.168.1.100')
    expect(store.port).toBe(10808)
  })

  it('执行代理连通性测试', async () => {
    const store = useProxyStore()
    const result = await store.testConnection({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 7890,
    })
    expect(result.success).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(store.lastTestResult).toEqual(result)
  })
})
