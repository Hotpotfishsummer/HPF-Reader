import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import {
  installDecompressionStreamFallback,
  inflateRawDeflate,
  nativeSupportsDecompressionFormat,
} from '../polyfills'

/**
 * ★ 这一组测试对应 Android 真机上的第二个阻塞点：
 *
 *   Failed to construct 'DecompressionStream': Unsupported compression format: 'deflate-raw'
 *
 * 要点：
 *   1. **原生支持时绝不接管**（不能把一条原生快速路径换成 JS 实现）；
 *   2. 原生不支持时才接管，且**只**接管 deflate-raw，gzip/deflate 仍走原生；
 *   3. 能真的解压 raw-deflate 数据（用 node:zlib 生成的真数据，不是手搓的假数据）。
 */

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

function replaceGlobal(key: string, value: unknown): () => void {
  const target = globalThis as unknown as Record<string, unknown>
  const had = Object.prototype.hasOwnProperty.call(target, key)
  const previous = target[key]
  target[key] = value
  return () => {
    if (had) target[key] = previous
    else delete target[key]
  }
}

/**
 * 用 node:zlib 生成真实的裸 deflate 数据（ZIP 压缩方法 8 里存的就是这个）。
 * 不用 `Buffer`：tsconfig 的 `types` 只含 vite/client，没有 node 全局类型。
 */
function makeRawDeflate(text: string, level = 6): Uint8Array {
  return new Uint8Array(deflateRawSync(new TextEncoder().encode(text), { level }))
}

/** Uint8Array → UTF-8 字符串（同上，避免依赖 Buffer）。 */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** 把多个 Uint8Array 拼成一个。 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

describe('inflateRawDeflate（复用 vendored fflate）', () => {
  test('解压真实 raw-deflate 数据', () => {
    const text = 'HPF Reader deflate-raw 自检 fixtures'
    const decoded = utf8(inflateRawDeflate(makeRawDeflate(text)))
    expect(decoded).toBe(text)
  })

  test('空输入', () => {
    expect(inflateRawDeflate(makeRawDeflate('')).length).toBe(0)
  })

  test('大输入（跨越 fflate 内部分块边界）', () => {
    const text = 'A'.repeat(70_000)
    const decoded = inflateRawDeflate(makeRawDeflate(text, 9))
    expect(decoded.length).toBe(70_000)
    expect(decoded.every((byte) => byte === 0x41)).toBe(true)
  })

  test('压缩级别 0（deflate 容器里的 stored 块）', () => {
    const text = 'abc'.repeat(100)
    const decoded = utf8(inflateRawDeflate(makeRawDeflate(text, 0)))
    expect(decoded).toBe(text)
  })

  test('压缩级别 1 与 9 都能解（不同 Huffman 表）', () => {
    const text = JSON.stringify({ a: 1, b: 'x'.repeat(500) })
    for (const level of [1, 9]) {
      expect(utf8(inflateRawDeflate(makeRawDeflate(text, level)))).toBe(text)
    }
  })
})

describe('nativeSupportsDecompressionFormat（特性探测）', () => {
  test('原生不存在 DecompressionStream 时返回 false', () => {
    restores.push(replaceGlobal('DecompressionStream', undefined))
    expect(nativeSupportsDecompressionFormat('deflate-raw')).toBe(false)
  })

  test('构造抛错时返回 false（模拟 WebView 91）', () => {
    const Chrome91 = function (format: string) {
      if (format === 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`)
      return { fake: format }
    }
    restores.push(replaceGlobal('DecompressionStream', Chrome91))
    expect(nativeSupportsDecompressionFormat('deflate-raw')).toBe(false)
    expect(nativeSupportsDecompressionFormat('gzip')).toBe(true)
    expect(nativeSupportsDecompressionFormat('deflate')).toBe(true)
  })
})

describe('installDecompressionStreamFallback', () => {
  test('原生支持 deflate-raw 时**不接管**（绝不替换原生快速路径）', () => {
    const Native = function (this: unknown, format: string) {
      return { format, native: true }
    }
    restores.push(replaceGlobal('DecompressionStream', Native))
    const installed = installDecompressionStreamFallback()
    expect(installed).toEqual([])
    // 原生实现原样保留
    expect((globalThis as unknown as Record<string, unknown>)['DecompressionStream']).toBe(Native)
  })

  test('原生不支持时接管，且返回可记录的补丁名', () => {
    const Chrome91 = function (format: string) {
      if (format === 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`)
      return { format }
    }
    restores.push(replaceGlobal('DecompressionStream', Chrome91))
    const installed = installDecompressionStreamFallback()
    expect(installed).toEqual(['DecompressionStream(deflate-raw)'])
    // 现在 deflate-raw 构造不再抛错
    expect(nativeSupportsDecompressionFormat('deflate-raw')).toBe(true)
  })

  test('接管后：gzip / deflate 仍委托给原生实现（不退性能、不改语义）', () => {
    const calls: string[] = []
    const Chrome91 = function (format: string) {
      if (format === 'deflate-raw') throw new TypeError(`Unsupported compression format: '${format}'`)
      calls.push(format)
      return { format, native: true }
    }
    restores.push(replaceGlobal('DecompressionStream', Chrome91))
    installDecompressionStreamFallback()

    // shim 是"既能 new 又能直接调用"的函数；这里按可调用形式取出来测。
    const Constructor = (globalThis as unknown as Record<string, unknown>)['DecompressionStream'] as unknown as (
      f: string,
    ) => unknown
    expect(Constructor('gzip')).toEqual({ format: 'gzip', native: true })
    expect(Constructor('deflate')).toEqual({ format: 'deflate', native: true })
    expect(calls).toEqual(['gzip', 'deflate'])
  })

  test('接管后 deflate64-raw 明确抛错（不产出垃圾数据）', () => {
    const Chrome91 = function () {
      throw new TypeError('unsupported')
    }
    restores.push(replaceGlobal('DecompressionStream', Chrome91))
    installDecompressionStreamFallback()
    // shim 是"既能 new 又能直接调用"的函数；这里按可调用形式取出来测。
    const Constructor = (globalThis as unknown as Record<string, unknown>)['DecompressionStream'] as unknown as (
      f: string,
    ) => unknown
    expect(() => Constructor('deflate64-raw')).toThrow(TypeError)
  })

  test('★ 接管后能真的流式解压 raw-deflate（zip.js 的 pipeThrough 用法）', async () => {
    const Chrome91 = function () {
      throw new TypeError('unsupported')
    }
    restores.push(replaceGlobal('DecompressionStream', Chrome91))
    installDecompressionStreamFallback()

    const text = 'HPF Reader 真实 EPUB 的 deflate 条目就是这种裸 deflate 流'
    const raw = makeRawDeflate(text)
    type StreamLike = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
    const Constructor = (globalThis as unknown as Record<string, unknown>)['DecompressionStream'] as unknown as new (
      f: string,
    ) => StreamLike

    // 分两段喂进去，模拟 zip.js 按 chunk 写入
    const split = Math.floor(raw.length / 2)
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw.subarray(0, split))
        controller.enqueue(raw.subarray(split))
        controller.close()
      },
    })

    const decompressor = new Constructor('deflate-raw')
    const out = source.pipeThrough(decompressor as unknown as TransformStream<Uint8Array, Uint8Array>)
    const reader = out.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const joined = utf8(concatBytes(chunks))
    expect(joined).toBe(text)
  })
})