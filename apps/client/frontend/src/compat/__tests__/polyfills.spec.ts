import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  INSTALLED_POLYFILLS,
  abortSignalTimeoutPolyfill,
  arrayAt,
  arrayFindLast,
  arrayFindLastIndex,
  arrayToReversed,
  arrayToSorted,
  arrayToSpliced,
  arrayWith,
  groupByMap,
  groupByObject,
  installPolyfills,
  objectHasOwn,
  promiseTryPolyfill,
  promiseWithResolversPolyfill,
  randomUUIDPolyfill,
  stringAt,
  structuredClonePolyfill,
  uint8ArrayFromBase64,
  uint8ArrayToBase64,
  verifyPolyfills,
} from '../polyfills'

/**
 * polyfill 的测试策略：
 *   1. **纯函数直测**（边界：空数组、NaN 键、越界、循环引用）—— 不依赖运行环境有没有原生实现。
 *   2. **安装行为测**（幂等、不覆盖原生、缺失时真的补上）—— 这里会临时删掉全局实现，
 *      测完立刻还原，避免影响同一进程里的其他测试文件。
 */

/** 临时删除一个全局实现，返回还原函数。 */
function removeGlobal(target: object, key: string): () => void {
  const record = target as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  delete record[key]
  return () => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else delete record[key]
  }
}

const restores: Array<() => void> = []
afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
})

describe('安装行为', () => {
  test('幂等：连续安装两次，第二次什么都不补', () => {
    const first = installPolyfills()
    const second = installPolyfills()
    expect(second).toEqual([])
    void first
  })

  test('已经是原生实现时不被覆盖（原生实现必须原样保留）', () => {
    // Node 24 自带这些；断言的是"我们绝不覆盖原生"
    const nativeAt = Array.prototype.at
    const installed = installPolyfills()
    expect(Array.prototype.at).toBe(nativeAt)
    expect(installed).not.toContain('Array.prototype.at')
  })

  test('缺失时能补齐（模拟 WebView 91）', async () => {
    restores.push(removeGlobal(Object, 'groupBy'))
    restores.push(removeGlobal(Array.prototype, 'findLastIndex'))

    // 清掉模块缓存，让 INSTALLED_POLYFILLS 在"缺失"的状态下重新求值
    vi.resetModules()
    const mod = await import('../polyfills')

    expect(mod.INSTALLED_POLYFILLS).toContain('Object.groupBy')
    expect(mod.INSTALLED_POLYFILLS).toContain('Array.prototype.findLastIndex')

    const grouped = (Object as unknown as {
      groupBy: typeof groupByObject
    }).groupBy([1, 2, 3, 4], (n) => n % 2)
    expect(grouped[1]).toEqual([1, 3])

    const sections = [{ linear: 'yes' }, { linear: 'no' }, { linear: 'yes' }]
    const findLastIndex = (Array.prototype as unknown as {
      findLastIndex: (this: typeof sections, p: (s: { linear: string }) => boolean) => number
    }).findLastIndex
    expect(findLastIndex.call(sections, (s) => s.linear !== 'no')).toBe(2)
  })

  test('INSTALLED_POLYFILLS 是字符串数组（启动日志用）', () => {
    expect(Array.isArray(INSTALLED_POLYFILLS)).toBe(true)
    for (const name of INSTALLED_POLYFILLS) expect(typeof name).toBe('string')
  })

  test('verifyPolyfills 在当前环境返回 null（无可报告的问题）', () => {
    expect(verifyPolyfills()).toBeNull()
  })
})

describe('Object.groupBy / Map.groupBy', () => {
  test('空集合返回空结果', () => {
    const empty = groupByObject([], (n: number) => n)
    expect(Object.keys(empty)).toEqual([])
    expect(groupByMap([], (n: number) => n).size).toBe(0)
  })

  test('Object 版是 null 原型（规范行为）', () => {
    const grouped = groupByObject([1, 2], (n) => n % 2)
    expect(Object.getPrototypeOf(grouped)).toBeNull()
    expect('toString' in grouped).toBe(false)
  })

  test('Object 版：数字键被转成字符串，Symbol 键保留', () => {
    const symbol = Symbol('s')
    const grouped = groupByObject([1, 2, 3], (n) => (n === 3 ? symbol : n))
    expect(grouped[1]).toEqual([1])
    expect(grouped[2]).toEqual([2])
    expect(grouped[symbol]).toEqual([3])
  })

  test('Map 版：键按 SameValueZero（NaN 与 NaN 同键）', () => {
    const grouped = groupByMap([1, 2, 3], (n) => (n === 2 ? Number.NaN : n))
    expect(grouped.get(Number.NaN)).toEqual([2])
    expect(grouped.size).toBe(3)
  })

  test('回调收到索引，且只遍历一次', () => {
    const seen: number[] = []
    groupByObject(['a', 'b', 'c'], (_item, index) => {
      seen.push(index)
      return index % 2
    })
    expect(seen).toEqual([0, 1, 2])
  })
})

describe('Array.prototype.at / String.prototype.at', () => {
  test('负索引从末尾算，越界返回 undefined', () => {
    expect(arrayAt([1, 2, 3], -1)).toBe(3)
    expect(arrayAt([1, 2, 3], 0)).toBe(1)
    expect(arrayAt([1, 2, 3], 3)).toBeUndefined()
    expect(arrayAt([1, 2, 3], -4)).toBeUndefined()
    expect(arrayAt([], 0)).toBeUndefined()
  })

  test('非整数索引按 ToIntegerOrInfinity 截断', () => {
    expect(arrayAt([1, 2, 3], 1.9)).toBe(2)
    expect(arrayAt([1, 2, 3], -1.9)).toBe(3)
  })

  test('字符串版返回长度为 1 的字符串', () => {
    expect(stringAt('abc', -1)).toBe('c')
    expect(stringAt('abc', 5)).toBeUndefined()
    expect(stringAt('', 0)).toBeUndefined()
  })
})

describe('findLast / findLastIndex（★ foliate-js paginator.js:1089 的依赖）', () => {
  test('复现 paginator 的真实调用形态', () => {
    const sections = [
      { id: 0, linear: 'yes' },
      { id: 1, linear: 'no' },
      { id: 2, linear: 'yes' },
      { id: 3, linear: 'yes' },
    ]
    expect(arrayFindLastIndex(sections, (s) => s.linear !== 'no')).toBe(3)
  })

  test('从后往前找，找不到返回 -1 / undefined', () => {
    expect(arrayFindLastIndex([1, 2, 3], (n) => n > 10)).toBe(-1)
    expect(arrayFindLast([1, 2, 3], (n) => n > 10)).toBeUndefined()
    expect(arrayFindLast([1, 2, 3], (n) => n < 3)).toBe(2)
  })

  test('空数组', () => {
    expect(arrayFindLastIndex([], () => true)).toBe(-1)
    expect(arrayFindLast([], () => true)).toBeUndefined()
  })

  test('回调拿到正确的索引（倒序）', () => {
    const indexes: number[] = []
    arrayFindLastIndex(['a', 'b', 'c'], (_v, index) => {
      indexes.push(index)
      return false
    })
    expect(indexes).toEqual([2, 1, 0])
  })

  test('thisArg 透传', () => {
    const context = { limit: 1 }
    const found = arrayFindLast([1, 2, 3], function (this: typeof context, n: number) {
      return n <= this.limit
    }, context)
    expect(found).toBe(1)
  })
})

describe('ES2023 不可变数组方法', () => {
  const source = [3, 1, 2]

  test('toSorted 不改原数组', () => {
    expect(arrayToSorted(source)).toEqual([1, 2, 3])
    expect(source).toEqual([3, 1, 2])
  })

  test('toSorted 支持比较函数', () => {
    expect(arrayToSorted(source, (a: number, b: number) => b - a)).toEqual([3, 2, 1])
  })

  test('toReversed 不改原数组', () => {
    expect(arrayToReversed(source)).toEqual([2, 1, 3])
    expect(source).toEqual([3, 1, 2])
  })

  test('toSpliced 不改原数组；省略 deleteCount 时删到末尾', () => {
    expect(arrayToSpliced(source, 1, 1)).toEqual([3, 2])
    expect(arrayToSpliced(source, 1)).toEqual([3])
    expect(arrayToSpliced(source, 0, 0, 9)).toEqual([9, 3, 1, 2])
    expect(source).toEqual([3, 1, 2])
  })

  test('with 支持负索引，越界抛 RangeError', () => {
    expect(arrayWith(source, -1, 9)).toEqual([3, 1, 9])
    expect(arrayWith(source, 0, 9)).toEqual([9, 1, 2])
    expect(source).toEqual([3, 1, 2])
    expect(() => arrayWith(source, 3, 9)).toThrow(RangeError)
    expect(() => arrayWith(source, -4, 9)).toThrow(RangeError)
    expect(() => arrayWith([], 0, 9)).toThrow(RangeError)
  })
})

describe('Object.hasOwn（★ vue-router / pinia / @vueuse 的依赖）', () => {
  test('只认自有属性，不认原型链', () => {
    const proto = { inherited: 1 }
    const target = Object.create(proto) as Record<string, number>
    target['own'] = 2
    expect(objectHasOwn(target, 'own')).toBe(true)
    expect(objectHasOwn(target, 'inherited')).toBe(false)
    expect(objectHasOwn({}, 'toString')).toBe(false)
  })

  test('Symbol 键与不可枚举属性', () => {
    const symbol = Symbol('k')
    const target: Record<PropertyKey, unknown> = { [symbol]: 1 }
    Object.defineProperty(target, 'hidden', { value: 2, enumerable: false })
    expect(objectHasOwn(target, symbol)).toBe(true)
    expect(objectHasOwn(target, 'hidden')).toBe(true)
  })
})

describe('structuredClone', () => {
  test('深拷贝普通对象，互不影响', () => {
    const source = { a: 1, nested: { b: 2 } }
    const copy = structuredClonePolyfill(source)
    copy.nested.b = 99
    expect(source.nested.b).toBe(2)
  })

  test('处理循环引用', () => {
    const source: { name: string; self?: unknown } = { name: 'x' }
    source.self = source
    const copy = structuredClonePolyfill(source) as typeof source
    expect(copy).not.toBe(source)
    expect(copy.self).toBe(copy)
  })

  test('Date / RegExp / Map / Set / TypedArray', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    expect(structuredClonePolyfill(date).getTime()).toBe(date.getTime())

    const re = /ab+c/gi
    const clonedRe = structuredClonePolyfill(re)
    expect(clonedRe.source).toBe(re.source)
    expect(clonedRe.flags).toBe(re.flags)

    const map = new Map([['k', { v: 1 }]])
    const clonedMap = structuredClonePolyfill(map)
    expect(clonedMap.get('k')).toEqual({ v: 1 })
    expect(clonedMap.get('k')).not.toBe(map.get('k'))

    const set = new Set([1, 2])
    expect([...structuredClonePolyfill(set)]).toEqual([1, 2])

    const bytes = new Uint8Array([1, 2, 3])
    const clonedBytes = structuredClonePolyfill(bytes)
    expect([...clonedBytes]).toEqual([1, 2, 3])
    clonedBytes[0] = 9
    expect(bytes[0]).toBe(1)
  })

  test('数组', () => {
    const source: [number, number[]] = [1, [2, 3]]
    const copy = structuredClonePolyfill(source)
    copy[1][0] = 9
    expect(source[1][0]).toBe(2)
  })

  test('DOMException 保留 name/message，且不改变 zip.js 能力探测的结果', () => {
    // zip.js 的探测写法：structuredClone(new DOMException('', 'AbortError')).code !== undefined
    // ⚠️ `.code` 是 legacy 属性，是否实现取决于**宿主**（Chromium 有，happy-dom 没有）。
    //    所以这里断言的正确性质是"polyfill 不改变探测结果"，而不是硬编码 20。
    const original = new DOMException('boom', 'AbortError')
    const cloned = structuredClonePolyfill(new DOMException('boom', 'AbortError'))
    expect(cloned.name).toBe('AbortError')
    expect(cloned.message).toBe('boom')
    const probe = (value: unknown) => (value as { code?: unknown }).code !== undefined
    expect(probe(cloned)).toBe(probe(original))
  })

  test('基本类型原样返回；函数按引用返回（已知偏差）', () => {
    expect(structuredClonePolyfill(1)).toBe(1)
    expect(structuredClonePolyfill(null)).toBeNull()
    expect(structuredClonePolyfill('a')).toBe('a')
    const fn = () => 1
    expect(structuredClonePolyfill(fn)).toBe(fn)
  })
})

describe('crypto.randomUUID', () => {
  test('形状符合 RFC 4122 v4', () => {
    const uuid = randomUUIDPolyfill()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('每次都不同', () => {
    const set = new Set(Array.from({ length: 50 }, () => randomUUIDPolyfill()))
    expect(set.size).toBe(50)
  })
})

describe('AbortSignal.timeout', () => {
  test('超时后 signal 变为 aborted', async () => {
    const signal = abortSignalTimeoutPolyfill(10)
    expect(signal.aborted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signal.aborted).toBe(true)
  })

  test('reason 依赖宿主实现，但访问它永远不该抛（见已知偏差：Chromium <98 忽略 abort 的 reason）', () => {
    const signal = abortSignalTimeoutPolyfill(1000)
    expect(signal.aborted).toBe(false)
    expect(() => signal.reason).not.toThrow()
  })
})

describe('Promise.withResolvers / Promise.try', () => {
  test('withResolvers 返回可用的 resolve/reject', async () => {
    const { promise, resolve } = promiseWithResolversPolyfill<number>()
    resolve(7)
    await expect(promise).resolves.toBe(7)

    const failing = promiseWithResolversPolyfill<number>()
    failing.reject(new Error('boom'))
    await expect(failing.promise).rejects.toThrow('boom')
  })

  test('Promise.try 同步执行；抛错转成 rejected promise', async () => {
    let ran = false
    const value = promiseTryPolyfill(() => {
      ran = true
      return 1
    })
    expect(ran).toBe(true) // 同步调用
    await expect(value).resolves.toBe(1)

    await expect(
      promiseTryPolyfill(() => {
        throw new Error('sync throw')
      }),
    ).rejects.toThrow('sync throw')
  })

  test('Promise.try 采用 thenable 的状态，并透传参数', async () => {
    await expect(promiseTryPolyfill(async (a: unknown) => Number(a) + 1, 41)).resolves.toBe(42)
    await expect(promiseTryPolyfill(() => Promise.resolve('x'))).resolves.toBe('x')
  })
})

describe('Uint8Array base64（ES2025）', () => {
  test('往返一致（含全 256 字节）', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) bytes[i] = i
    const encoded = uint8ArrayToBase64(bytes)
    expect(uint8ArrayFromBase64(encoded)).toEqual(bytes)
  })

  test('空数组', () => {
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe('')
    expect(uint8ArrayFromBase64('').length).toBe(0)
  })

  test('已知向量', () => {
    expect(uint8ArrayToBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
  })

  test('base64url 字母表 + 去掉 padding', () => {
    const bytes = new Uint8Array([251, 255, 191])
    const url = uint8ArrayToBase64(bytes, { alphabet: 'base64url', omitPadding: true })
    expect(url).not.toContain('+')
    expect(url).not.toContain('/')
    expect(url).not.toContain('=')
    expect(uint8ArrayFromBase64(url, { alphabet: 'base64url' })).toEqual(bytes)
  })

  test('忽略 ASCII 空白；非法长度抛 SyntaxError；非法字符抛错', () => {
    expect(uint8ArrayFromBase64('TW Fu').length).toBe(3)
    expect(() => uint8ArrayFromBase64('TWFuX')).toThrow(SyntaxError)
    expect(() => uint8ArrayFromBase64('!!!!')).toThrow()
  })

  test('大数组不爆栈（分块编码）', () => {
    const bytes = new Uint8Array(200_000).fill(65)
    const encoded = uint8ArrayToBase64(bytes)
    expect(uint8ArrayFromBase64(encoded).length).toBe(200_000)
  })
})