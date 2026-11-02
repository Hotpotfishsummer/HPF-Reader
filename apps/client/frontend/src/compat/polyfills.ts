/**
 * ★ 老旧 WebView 运行时内置对象 polyfill（task-14）。
 *
 * ## 为什么必须有这个文件
 *
 * Wails 的 WebView **不是**随浏览器一起更新的：
 *   - Android：版本取决于系统/厂商。API 29~31 模拟器**实测**
 *     `Chrome/91.0.4472.114`（见 apps/client/spikes/android/RESULTS.md）；
 *     e-ink 阅读器（文石/Kindle 类）大量是 Android 8~11 + WebView 80~100。
 *   - Windows：WebView2 是 evergreen 的，但不保证用户没装老 runtime。
 *
 * Vite/esbuild 只按 `build.target` 降级**语法**，**不会**给运行时内置对象打补丁。
 * 所以 `Object.groupBy`（ES2024，Chrome 117+）在 Chromium 91 上就是
 * `TypeError: Object.groupBy is not a function` —— 实测后果是 **Android 上任何书都打不开**。
 *
 * ## 覆盖范围是"审计出来的"，不是"猜的"
 *
 * 审计工具（可复现）：
 *   node scripts/audit-builtins.mjs src  --chrome 91   # 我们的源码 + vendored 上游
 *   node scripts/audit-builtins.mjs dist --chrome 91   # ★ 权威：包含 node_modules 打包后的代码
 * 两者都以非 0 退出码表示"有 API 低于基线且没有 polyfill"，可以直接当 CI 门槛。
 *
 * **dist 那一遍才是关键**：`Object.hasOwn` 在 src 里命中 0 次，但在产物里出现 3 次 ——
 * 来自 vue-router / pinia / pinia-plugin-persistedstate / @vueuse/core 的源码。
 * 只扫 src 会漏掉整个依赖树。
 *
 * | API | 最低 Chrome | src | dist | 真实调用点 / 说明 |
 * |---|---|---|---|---|
 * | `Object.groupBy` | 117 | 5 | 4 | vendor/foliate-js/epub.js（**EPUB 必挂**） |
 * | `Map.groupBy` | 117 | 1 | 4 | vendor/foliate-js/epub.js（**EPUB 必挂**） |
 * | `Array.prototype.findLastIndex` | 97 | 1 | 1 | foliate-js/paginator.js:1089（**分页必挂**） |
 * | `Array.prototype.findLast` | 97 | 1 | 1 | pdf.js（PDF 路径） |
 * | `Promise.withResolvers` | 119 | 40 | 30 | pdf.js（PDF 路径） |
 * | `Promise.try` | 128 | 8 | 5 | pdf.js（epub.js:782 只是注释，见脚本里的行级豁免） |
 * | `Array.prototype.at` | 92 | 58 | 20 | foliate-js/epub.js、epubcfi.js（含非数组误报，需人工确认） |
 * | `String.prototype.at` | 92 | — | 1 | 与上一条成对补齐 |
 * | `structuredClone` | 98 | 6 | 9 | vendor/zip.js（能力探测） |
 * | `crypto.randomUUID` | 92 | 5 | 5 | src/platform/server.ts |
 * | `AbortSignal.timeout` | 103 | 1 | 5 | src/api/client.ts |
 * | `Object.hasOwn` | 93 | 0 | **3** | ★ vue-router / pinia / @vueuse（依赖树里真的在用） |
 * | `Array.prototype.to{ sorted,Reversed,Spliced }` / `with` | 110 | 0 | 3 | ★ Vue 响应式数组插桩里定义并调用 |
 * | `Uint8Array.prototype.toBase64` / `fromBase64` | 133 | 4 | 8 | pdf.js 内联图片、签名校验 |
 *
 * 审计**确认不需要**补的（91 已支持，补了纯属噪音）：
 * `String.prototype.replaceAll`(85)、`Object.fromEntries`(73)、`String.prototype.matchAll`(73)、
 * `Array.prototype.flatMap`(69)、`Promise.allSettled`(76)、`WeakRef`(84)、
 * `FinalizationRegistry`(84)、`CompressionStream`(80)、`Intl.Segmenter`(87)、
 * RegExp `d` flag(90)；以及全量扫描里命中数为 0 的
 * `URL.canParse`(120)、`RegExp.escape`(136)、`Set.prototype.union`(122)、
 * `Array.fromAsync`(121) 等 ES2024/2025 项。
 *
 * ## 实现原则
 *   1. **只在缺失时安装**，绝不覆盖原生实现（原生永远更快更准）。
 *   2. 语义对齐到"第三方库真会用到的程度"，**已知偏差写在每个函数上方**。
 *   3. polyfill 自己不能成为新的崩溃源：安装过程不抛异常。
 *   4. **不修改 vendored 的 foliate-js 源码**（那是上游，我们靠这层兜）。
 */

import { unzlibSync } from 'foliate-js/vendor/fflate.js'

type AnyRecord = Record<string, unknown>

function define(target: object, key: string, value: unknown): boolean {
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    return true
  } catch {
    return false
  }
}

function missing(target: object, key: string): boolean {
  return typeof (target as AnyRecord)[key] !== 'function'
}

/* ------------------------------------------------------------------ *
 * Object.groupBy / Map.groupBy（ES2024 / Chrome 117）
 * ------------------------------------------------------------------ */

/**
 * 与规范一致：返回 **null 原型**对象（所以 `'toString' in result` 为 false），
 * 键按 ToPropertyKey 转换（数字键变字符串，Symbol 键原样保留）。
 */
export function groupByObject<T, K extends PropertyKey>(
  items: Iterable<T>,
  callback: (item: T, index: number) => K,
): Record<PropertyKey, T[]> {
  const out: Record<PropertyKey, T[]> = Object.create(null) as Record<PropertyKey, T[]>
  let index = 0
  for (const item of items) {
    const key = callback(item, index)
    index += 1
    const existing = out[key]
    if (existing) existing.push(item)
    else out[key] = [item]
  }
  return out
}

/** 与规范一致：键按 SameValueZero 比较（`-0` 与 `0` 同键，`NaN` 与 `NaN` 同键）。 */
export function groupByMap<T, K>(
  items: Iterable<T>,
  callback: (item: T, index: number) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>()
  let index = 0
  for (const item of items) {
    const key = callback(item, index)
    index += 1
    const existing = out.get(key)
    if (existing) existing.push(item)
    else out.set(key, [item])
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Array.prototype.at / String.prototype.at（Chrome 92）
 * ------------------------------------------------------------------ */

/**
 * 安装形态（`[].at(-1)`）由 installPolyfills() 里的包装器接到 `this` 上；
 * 实现本身接收显式的 receiver —— 这样测试能直接调，不依赖泛型 `this` 的推断。
 */
export function arrayAt<T>(array: ArrayLike<T>, index: number): T | undefined {
  const length = array.length >>> 0
  const relative = Math.trunc(index) || 0
  const absolute = relative < 0 ? length + relative : relative
  if (absolute < 0 || absolute >= length) return undefined
  return array[absolute]
}

export function stringAt(target: string, index: number): string | undefined {
  const length = target.length
  const relative = Math.trunc(index) || 0
  const absolute = relative < 0 ? length + relative : relative
  if (absolute < 0 || absolute >= length) return undefined
  return target.charAt(absolute)
}

/* ------------------------------------------------------------------ *
 * Array.prototype.findLast / findLastIndex（ES2023 / Chrome 97）
 * ------------------------------------------------------------------ */

/** ★ foliate-js paginator.js:1089 `sections.findLastIndex(...)` 就靠这个 —— 不补则**分页直接挂**。 */
export function arrayFindLastIndex<T>(
  array: ArrayLike<T>,
  predicate: (value: T, index: number, array: ArrayLike<T>) => unknown,
  thisArg?: unknown,
): number {
  const length = array.length >>> 0
  for (let index = length - 1; index >= 0; index -= 1) {
    const value = array[index] as T
    if (predicate.call(thisArg, value, index, array)) return index
  }
  return -1
}

/** 与规范一致：**从后往前**找第一个满足条件的元素，找不到返回 `undefined`。 */
export function arrayFindLast<T>(
  array: ArrayLike<T>,
  predicate: (value: T, index: number, array: ArrayLike<T>) => unknown,
  thisArg?: unknown,
): T | undefined {
  const length = array.length >>> 0
  for (let index = length - 1; index >= 0; index -= 1) {
    const value = array[index] as T
    if (predicate.call(thisArg, value, index, array)) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Object.hasOwn（ES2022 / Chrome 93）
 * ------------------------------------------------------------------ */

/**
 * ★ 运行时依赖真的在用：vue-router / pinia / pinia-plugin-persistedstate /
 * @vueuse/core+shared / devtools-api 的源码里都有 `Object.hasOwn`。
 * vue-router 每次导航都会走这些代码路径 —— 所以在 WebView 91 上这是**必修项**，
 * 不是"以防万一"。
 */
export function objectHasOwn(target: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(Object(target), key)
}

/* ------------------------------------------------------------------ *
 * Array.prototype.toSorted / toReversed / toSpliced / with（ES2023 / Chrome 110）
 * ------------------------------------------------------------------ */

/**
 * Vue 的响应式数组插桩里**定义并调用**了这几个方法（`toReversed(){return ...toReversed()}`）。
 * 只要应用代码或某个依赖真的调用了它们，WebView 91 上就会 TypeError。
 * 我们无法穷举第三方依赖的所有调用路径，所以按"便宜就补上"处理。
 *
 * 已知偏差：规范用 `Array.prototype[Symbol.species]` 决定返回类型，这里固定返回普通数组。
 * 对本项目（不继承 Array）没有影响。
 */
export function arrayToSorted<T>(array: ArrayLike<T>, compareFn?: (a: T, b: T) => number): T[] {
  const out = Array.prototype.slice.call(array) as T[]
  out.sort(compareFn)
  return out
}

export function arrayToReversed<T>(array: ArrayLike<T>): T[] {
  const out = Array.prototype.slice.call(array) as T[]
  out.reverse()
  return out
}

export function arrayToSpliced<T>(
  array: ArrayLike<T>,
  start: number,
  deleteCount?: number,
  ...items: T[]
): T[] {
  const out = Array.prototype.slice.call(array) as T[]
  if (deleteCount === undefined) out.splice(start)
  else out.splice(start, deleteCount, ...items)
  return out
}

/** 与规范一致：越界抛 RangeError（负索引从末尾算）。 */
export function arrayWith<T>(array: ArrayLike<T>, index: number, value: T): T[] {
  const length = array.length >>> 0
  const relative = Math.trunc(index) || 0
  const actual = relative < 0 ? length + relative : relative
  if (actual < 0 || actual >= length) throw new RangeError('Invalid index')
  const out = Array.prototype.slice.call(array) as T[]
  out[actual] = value
  return out
}

/* ------------------------------------------------------------------ *
 * structuredClone（Chrome 98）
 * ------------------------------------------------------------------ */

/**
 * 已知偏差（刻意为之，都写在测试里）：
 *   - **函数原样返回**，规范会抛 DataCloneError。第三方库（zip.js/pdf.js）会把配置对象
 *     整个传进来，遇到回调函数就抛异常反而更糟。
 *   - **Blob / File / Promise 等平台对象按引用返回**，不做真正的 transfer。
 *   - 不支持 transfer 列表（第二参数）。
 *   - DOMException 会保留 `name` / `message` / `code`（zip.js 的能力探测依赖它）。
 */
export function structuredClonePolyfill<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (typeof value === 'function') return value

  const source = value as unknown as object
  const cached = seen.get(source)
  if (cached !== undefined) return cached as T

  const tag = Object.prototype.toString.call(value)

  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as unknown as T
  if (value instanceof ArrayBuffer) return value.slice(0) as unknown as T
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayBufferView
    const buffer = view.buffer.slice(0) as ArrayBuffer
    const cloned =
      tag === '[object DataView]'
        ? new DataView(buffer, view.byteOffset, view.byteLength)
        : new (view.constructor as new (b: ArrayBuffer, o: number, l: number) => ArrayBufferView)(
            buffer,
            view.byteOffset,
            (view as unknown as { length: number }).length,
          )
    return cloned as unknown as T
  }
  if (value instanceof Map) {
    const out = new Map()
    seen.set(source, out)
    for (const [k, v] of value) out.set(structuredClonePolyfill(k, seen), structuredClonePolyfill(v, seen))
    return out as unknown as T
  }
  if (value instanceof Set) {
    const out = new Set()
    seen.set(source, out)
    for (const v of value) out.add(structuredClonePolyfill(v, seen))
    return out as unknown as T
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(source, out)
    for (let i = 0; i < value.length; i += 1) out[i] = structuredClonePolyfill(value[i], seen)
    return out as unknown as T
  }
  if (value instanceof DOMException) {
    const out = new DOMException(value.message, value.name)
    seen.set(source, out)
    return out as unknown as T
  }
  if (tag === '[object Blob]' || tag === '[object File]' || tag === '[object Promise]') {
    return value
  }

  const out: AnyRecord = {}
  seen.set(source, out)
  for (const key of Object.keys(value as AnyRecord)) {
    out[key] = structuredClonePolyfill((value as AnyRecord)[key], seen)
  }
  return out as unknown as T
}

/* ------------------------------------------------------------------ *
 * crypto.randomUUID（Chrome 92）
 * ------------------------------------------------------------------ */

export function randomUUIDPolyfill(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  // RFC 4122 v4：版本位 = 0100，变体位 = 10xx
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/* ------------------------------------------------------------------ *
 * AbortSignal.timeout（Chrome 103）
 * ------------------------------------------------------------------ */

/**
 * 已知偏差：Chromium 98 以下 `controller.abort(reason)` 会**忽略** reason，
 * 因此 `signal.reason` 是通用 AbortError，而不是规范的 TimeoutError。
 * 调用方不应依赖 `reason.name === 'TimeoutError'`。
 */
export function abortSignalTimeoutPolyfill(milliseconds: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException('signal timed out', 'TimeoutError'))
    } catch {
      controller.abort()
    }
  }, milliseconds)
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

/* ------------------------------------------------------------------ *
 * Promise.withResolvers（Chrome 119）
 * ------------------------------------------------------------------ */

export interface Resolvers<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function promiseWithResolversPolyfill<T>(): Resolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ------------------------------------------------------------------ *
 * Promise.try（Chrome 128）
 * ------------------------------------------------------------------ */

/**
 * 与规范一致：**同步**调用 callback；它抛异常 → 返回 rejected promise；
 * 返回 thenable → 直接采用其状态。
 * （`new Promise(executor)` 的 executor 本身就是同步执行的，且抛错自动转拒绝。）
 */
export function promiseTryPolyfill<T>(
  callback: (...args: unknown[]) => T | PromiseLike<T>,
  ...args: unknown[]
): Promise<Awaited<T>> {
  return new Promise<Awaited<T>>((resolve) => {
    resolve(callback(...args) as Awaited<T> | PromiseLike<Awaited<T>>)
  })
}

/* ------------------------------------------------------------------ *
 * Uint8Array.prototype.toBase64 / Uint8Array.fromBase64（ES2025 / Chrome 133）
 * ------------------------------------------------------------------ */

interface Base64Options {
  alphabet?: 'base64' | 'base64url'
  omitPadding?: boolean
}

/**
 * 已知偏差：规范的 `toBase64` 不认"非规范化的 padding"，我们这里按标准 base64 处理；
 * `alphabet` 只支持 `'base64'` 与 `'base64url'`（pdf.js 只用这两种）。
 * 分块处理是为了避免 `String.fromCharCode(...bigArray)` 爆栈。
 */
export function uint8ArrayToBase64(bytes: Uint8Array, options: Base64Options = {}): string {
  const alphabet = options.alphabet ?? 'base64'
  let binary = ''
  const CHUNK = 0x2000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  let out = btoa(binary)
  if (alphabet === 'base64url') out = out.replace(/\+/g, '-').replace(/\//g, '_')
  if (options.omitPadding) out = out.replace(/=+$/, '')
  return out
}

/**
 * 与规范一致：默认严格模式（`lastChunkHandling: 'strict'`），
 * 长度模 4 余 1 视为非法，抛 SyntaxError；非法字符由 atob 抛 InvalidCharacterError。
 */
// 注意：这是**静态**方法（Uint8Array.fromBase64），不使用 this，
// 所以签名里没有 this 伪参数 —— 有的话调用方会误以为第一个实参是 this。
export function uint8ArrayFromBase64(value: string, options: Base64Options = {}): Uint8Array {
  const alphabet = options.alphabet ?? 'base64'
  let normalized = String(value).replace(/[\t\n\f\r ]+/g, '')
  if (alphabet === 'base64url') normalized = normalized.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = normalized.length % 4
  if (remainder === 1) throw new SyntaxError('Invalid base64 string')
  if (remainder !== 0) normalized += '='.repeat(4 - remainder)
  const binary = atob(normalized)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/* ------------------------------------------------------------------ *
 * DecompressionStream 的格式兜底：'deflate-raw'（Chrome 103+）
 * ------------------------------------------------------------------ */

/**
 * ★ 为什么需要这个（Android 真机 logcat 实证）：
 *
 *   Failed to construct 'DecompressionStream': Unsupported compression format: 'deflate-raw'
 *
 * ZIP 的压缩方法 8（deflate）在 zip 内部存的是**裸 deflate 流**，没有 zlib 头，
 * 所以 zip.js 必须用 `'deflate-raw'` 构造 DecompressionStream。
 * 而 `'deflate-raw'` 是 **Chrome 103+** 才支持的格式：
 *
 *   实测 WebView 91: { gzip: OK, deflate: OK, deflate-raw: THROW }
 *
 * 后果非常隐蔽：**示例书能开、真书全打不开**。
 * 因为 sample.epub 是 100% STORE（压缩方法 0），根本不走解压；
 * 而 frankenstein / alice / pride 都有 deflate 条目（{0:2, 8:36} 等）。
 *
 * 兜底策略（窄接管，不动原生能力）：
 *   1. 启动时**特性探测**：`new DecompressionStream('deflate-raw')` 不抛 → 原生可用，**不接管**；
 *   2. 抛错才安装本 shim，且**只**接管 `'deflate-raw'` / `'deflate64-raw'`；
 *   3. `'gzip'` / `'deflate'` 一律原样委托给原生实现（不退性能、不改语义）。
 *
 * 解压实现复用 foliate-js **自带**的 vendored fflate（MIT）——零新增依赖。
 * fflate 只暴露 `unzlibSync`（zlib 容器版），所以这里给它补一个 2 字节 zlib 头
 * 与 4 字节 adler32 占位：`unzlibSync` 不校验 adler32（实测传入错误校验和也能解出正确结果），
 * 只要求 (CMF,FLG) 合法 —— `0x78 0x9c` 正好满足 (`0x789c % 31 === 0`)。
 */

/** zlib 头：CM=8(deflate) / CINFO=7(32K 窗口) / 无预置字典；0x789c % 31 == 0。 */
const ZLIB_HEADER_0 = 0x78
const ZLIB_HEADER_1 = 0x9c
/** `unzlibSync` 会切掉末尾 4 字节（它以为是 adler32），这里补 4 个 0 占位。 */
const ZLIB_TRAILER_LENGTH = 4

/** 把裸 deflate 流包成 zlib 容器，喂给 vendored fflate 的 `unzlibSync`。 */
export function inflateRawDeflate(rawDeflate: Uint8Array): Uint8Array {
  const framed = new Uint8Array(rawDeflate.length + 2 + ZLIB_TRAILER_LENGTH)
  framed[0] = ZLIB_HEADER_0
  framed[1] = ZLIB_HEADER_1
  framed.set(rawDeflate, 2)
  // 末尾 4 字节保持 0：只占位，不被校验
  return unzlibSync(framed)
}

/**
 * 只支持 `'deflate-raw'` 的窄兜底。暴露 `readable` / `writable` 是为了满足
 * `ReadableStream.pipeThrough()` 的契约（zip.js 正是这么用它的）。
 *
 * 已知偏差：整段缓冲后才解压（非真正的流式），所以**单个 zip 条目**会被完整读进内存。
 * EPUB 的条目通常 < 几 MB，可以接受；这也避免了在 WebView 91 上踩 backpressure 的坑。
 */
class DeflateRawDecompressionStream {
  #stream: TransformStream<Uint8Array, Uint8Array>

  constructor(format: string, options?: { chunkSize?: number }) {
    void options
    if (format !== 'deflate-raw' && format !== 'deflate64-raw') {
      throw new TypeError(`Unsupported compression format: '${format}'`)
    }
    // deflate64 是另一种编码（64K 窗口），fflate 不支持 —— 明确报错而不是产出垃圾数据。
    if (format === 'deflate64-raw') {
      throw new TypeError("Unsupported compression format: 'deflate64-raw'（fflate 兜底不支持 deflate64）")
    }
    const chunks: Uint8Array[] = []
    let total = 0
    this.#stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk) {
        chunks.push(chunk)
        total += chunk.length
      },
      flush(controller) {
        const joined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          joined.set(chunk, offset)
          offset += chunk.length
        }
        controller.enqueue(inflateRawDeflate(joined))
      },
    })
  }

  get readable(): ReadableStream<Uint8Array> {
    return this.#stream.readable
  }

  get writable(): WritableStream<Uint8Array> {
    return this.#stream.writable
  }
}

/** 原生是否真的支持某个 DecompressionStream 格式（构造即探测，比 UA 判断可靠）。 */
export function nativeSupportsDecompressionFormat(format: string): boolean {
  const Constructor = (globalThis as { DecompressionStream?: new (f: string, o?: unknown) => unknown })
    .DecompressionStream
  if (typeof Constructor !== 'function') return false
  try {
    void new Constructor(format)
    return true
  } catch {
    return false
  }
}

/**
 * 只在原生**不支持** deflate-raw 时接管。
 * 返回值是本次安装的补丁名数组（与 installPolyfills 的约定一致），没接管就是空数组。
 */
export function installDecompressionStreamFallback(): string[] {
  const globalRecord = globalThis as unknown as AnyRecord
  const constructor = globalRecord['DecompressionStream'] as
    | (new (format: string, options?: unknown) => unknown)
    | undefined

  // 原生已经支持 → 什么都不做（绝不用 JS 实现替换一条更快更稳的原生路径）
  if (typeof constructor === 'function' && nativeSupportsDecompressionFormat('deflate-raw')) return []

  const NativeConstructor = constructor
  const Shim = function (this: unknown, format: string, options?: unknown): unknown {
    if (format === 'deflate-raw' || format === 'deflate64-raw') {
      return new DeflateRawDecompressionStream(format, options as { chunkSize?: number } | undefined)
    }
    // 其它格式（gzip/deflate）委托给原生；连原生都没有就明确抛错
    if (typeof NativeConstructor === 'function') return new NativeConstructor(format, options)
    throw new TypeError(`Unsupported compression format: '${format}'`)
  } as unknown as new (format: string, options?: unknown) => unknown

  // 让 `instanceof DecompressionStream` 这类判断尽量保持原样
  if (typeof NativeConstructor === 'function') {
    Shim.prototype = NativeConstructor.prototype
  }

  if (!define(globalThis, 'DecompressionStream', Shim)) return []
  return ['DecompressionStream(deflate-raw)']
}

/* ------------------------------------------------------------------ *
 * 安装
 * ------------------------------------------------------------------ */

/**
 * 幂等安装。返回**本次真正安装**的补丁名（已经是原生实现的不会出现在列表里），
 * 便于启动日志与测试断言"到底补了什么"。
 */
export function installPolyfills(): string[] {
  const installed: string[] = []
  const globalRecord = globalThis as unknown as AnyRecord

  /** 静态方法 / 全局函数：直接赋值即可（实现本来就接收显式参数）。 */
  const install = (name: string, target: object, key: string, value: unknown): void => {
    if (!missing(target, key)) return
    if (define(target, key, value)) installed.push(name)
  }

  /**
   * 原型方法：实现接收显式的 receiver，这里包一层把它接到 `this` 上。
   * 好处是同一个函数既能在运行时当方法用，又能在测试里直接当纯函数调，
   * 不必依赖 TS 对泛型 `this` 的推断（那种推断在 `.call()` 上经常失败）。
   *
   * 已知偏差：包装器用了 rest 参数，所以 `fn.length` 是 0 而不是规范要求的实参个数。
   * 已确认的消费方（foliate-js / pdf.js / Vue / pinia）都不检查这些方法的 length。
   */
  const installMethod = (
    name: string,
    target: object,
    key: string,
    implementation: (self: never, ...args: never[]) => unknown,
  ): void => {
    if (!missing(target, key)) return
    const impl = implementation as unknown as (self: unknown, ...args: unknown[]) => unknown
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      return impl(this, ...args)
    }
    if (define(target, key, wrapper)) installed.push(name)
  }

  install('Object.hasOwn', Object, 'hasOwn', objectHasOwn)
  install('Object.groupBy', Object, 'groupBy', groupByObject)
  install('Map.groupBy', Map, 'groupBy', groupByMap)
  installMethod('Array.prototype.at', Array.prototype, 'at', arrayAt)
  installMethod('String.prototype.at', String.prototype, 'at', stringAt)
  installMethod('Array.prototype.findLast', Array.prototype, 'findLast', arrayFindLast)
  installMethod('Array.prototype.findLastIndex', Array.prototype, 'findLastIndex', arrayFindLastIndex)
  installMethod('Array.prototype.toSorted', Array.prototype, 'toSorted', arrayToSorted)
  installMethod('Array.prototype.toReversed', Array.prototype, 'toReversed', arrayToReversed)
  installMethod('Array.prototype.toSpliced', Array.prototype, 'toSpliced', arrayToSpliced)
  installMethod('Array.prototype.with', Array.prototype, 'with', arrayWith)

  if (typeof globalRecord['structuredClone'] !== 'function') {
    if (define(globalThis, 'structuredClone', structuredClonePolyfill)) installed.push('structuredClone')
  }
  if (globalThis.crypto) install('crypto.randomUUID', globalThis.crypto, 'randomUUID', randomUUIDPolyfill)
  if (typeof globalThis.AbortSignal !== 'undefined') {
    install('AbortSignal.timeout', globalThis.AbortSignal, 'timeout', abortSignalTimeoutPolyfill)
  }
  install('Promise.withResolvers', Promise, 'withResolvers', promiseWithResolversPolyfill)
  install('Promise.try', Promise, 'try', promiseTryPolyfill)
  installMethod('Uint8Array.prototype.toBase64', Uint8Array.prototype, 'toBase64', uint8ArrayToBase64)
  for (const name of installDecompressionStreamFallback()) installed.push(name)
  // Uint8Array.fromBase64 是**静态**方法（构造器上），不是原型方法。
  if (missing(Uint8Array, 'fromBase64')) {
    if (define(Uint8Array, 'fromBase64', uint8ArrayFromBase64)) installed.push('Uint8Array.fromBase64')
  }

  return installed
}

/**
 * 自检：用**真实调用形态**验证每个补丁，而不是只检查"函数存在"。
 * 返回 null 表示一切正常，否则返回人类可读的问题描述（启动时打 warn）。
 *
 * 这里特意把 foliate-js 会走的那两条路复现出来：
 *   - `Object.groupBy` 分组 metadata；
 *   - `findLastIndex` 找最后一个 linear section。
 */
export function verifyPolyfills(): string | null {
  const problems: string[] = []
  const attempt = (label: string, fn: () => boolean): void => {
    try {
      if (!fn()) problems.push(`${label} 行为不正确`)
    } catch (error) {
      problems.push(`${label} 抛异常: ${String(error)}`)
    }
  }

  attempt('Object.groupBy', () => {
    const grouped = (Object as unknown as { groupBy: typeof groupByObject }).groupBy([1, 2, 3, 4], (n) => n % 2)
    return grouped[1]?.length === 2 && grouped[0]?.length === 2
  })
  attempt('Map.groupBy', () => {
    const grouped = (Map as unknown as { groupBy: typeof groupByMap }).groupBy([1, 2, 3], (n) => n % 2)
    return grouped.get(1)?.length === 2
  })
  attempt('Array.prototype.at', () => [1, 2, 3].at(-1) === 3)
  attempt('Array.prototype.findLastIndex', () => {
    // 复现 foliate-js paginator.js:1089 的真实调用形态。
    // 用 cast 读全局实现：这样自检验的是"运行时到底有没有被补上"，而不是本地函数。
    const sections: ArrayLike<{ linear: string }> = [
      { linear: 'yes' },
      { linear: 'no' },
      { linear: 'yes' },
    ]
    const findLastIndex = (Array.prototype as unknown as {
      findLastIndex: (this: ArrayLike<{ linear: string }>, predicate: (s: { linear: string }) => boolean) => number
    }).findLastIndex
    return findLastIndex.call(sections, (s) => s.linear !== 'no') === 2
  })
  attempt('Promise.withResolvers', () => {
    const { promise, resolve } = (Promise as unknown as { withResolvers: typeof promiseWithResolversPolyfill })
      .withResolvers<number>()
    resolve(1)
    return promise instanceof Promise
  })

  return problems.length ? problems.join('; ') : null
}

/**
 * ★ 模块被 import 的那一刻就安装（不是等 bootstrap()）。
 *
 * ES 模块按 import 声明顺序深度优先求值，所以只要 main.ts 把这个 import
 * 放在**第一行**，这里就先于 router / i18n / platform / App 的顶层代码跑完。
 */
export const INSTALLED_POLYFILLS: string[] = installPolyfills()
