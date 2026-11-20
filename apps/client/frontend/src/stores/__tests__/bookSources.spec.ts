import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  DEFAULT_ANNAS_URL,
  DEFAULT_ZLIB_URL,
  useBookSourcesStore,
  WIKI_ANNAS_URL,
  WIKI_ZLIB_URL,
  ZLIB_INFO_TIP,
  ANNAS_INFO_TIP,
} from '../bookSources'

describe('bookSources store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始具有默认网址与维基百科配置', () => {
    const store = useBookSourcesStore()
    expect(store.zlibUrl).toBe('https://singlelogin.rs')
    expect(store.annasUrl).toBe('https://annas-archive.pk')
    expect(DEFAULT_ZLIB_URL).toBe('https://singlelogin.rs')
    expect(DEFAULT_ANNAS_URL).toBe('https://annas-archive.pk')
    expect(WIKI_ZLIB_URL).toContain('wikipedia.org/wiki/Z-Library')
    expect(WIKI_ANNAS_URL).toContain('wikipedia.org/wiki/Anna%27s_Archive')
    expect(ZLIB_INFO_TIP).toContain('Z-Library 信息框')
    expect(ANNAS_INFO_TIP).toContain("Anna's Archive 词条")
  })

  it('支持修改与保存 Z-Library 网址，并自动补全 https 协议头', () => {
    const store = useBookSourcesStore()
    store.setZLibUrl('zlibrary-asia.se')
    expect(store.zlibUrl).toBe('https://zlibrary-asia.se')

    store.setZLibUrl('http://zlibrary-custom.org')
    expect(store.zlibUrl).toBe('http://zlibrary-custom.org')
  })

  it('支持恢复 Z-Library 默认网址', () => {
    const store = useBookSourcesStore()
    store.setZLibUrl('https://custom.zlib.org')
    expect(store.zlibUrl).toBe('https://custom.zlib.org')

    store.resetZLib()
    expect(store.zlibUrl).toBe('https://singlelogin.rs')
  })

  it('支持修改与保存 Anna Archive 网址，并支持恢复默认', () => {
    const store = useBookSourcesStore()
    store.setAnnasUrl('annas-archive.org')
    expect(store.annasUrl).toBe('https://annas-archive.org')

    store.resetAnnas()
    expect(store.annasUrl).toBe('https://annas-archive.pk')
  })
})
