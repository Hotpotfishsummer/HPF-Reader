/**
 * 客户端 HLC（混合逻辑时钟）——与 apps/server/internal/sync/hlc.go **同构**实现。
 *
 * 这是 docs/TECH-PLAN.md §4.3 与任务书都强调的约束：两端算法必须一致，
 * 否则同一组操作在两端会算出不同的先后关系，导致「永远收敛不了」。
 *
 * 字符串格式（**定长 31 字符，因此字典序 == 时间序**）：
 *   <13 位十六进制毫秒>-<8 位十六进制计数器>-<8 位小写字母数字设备前缀>
 *   例：0192a3f4c1b0-0000000a-7f3c9d21
 */

export const HLC_TIME_DIGITS = 13
export const HLC_SEQ_DIGITS = 8
export const HLC_DEV_DIGITS = 8
export const HLC_LENGTH = HLC_TIME_DIGITS + 1 + HLC_SEQ_DIGITS + 1 + HLC_DEV_DIGITS
const HLC_MAX_TIME = 2 ** 52 - 1
const SEQ_MAX = 0xffffffff
const DEV_ALL_ZERO = '00000000'

export interface ParsedHlc {
  time: number
  seq: number
  device: string
}

/**
 * 把任意设备标识规整成 8 位小写字母数字前缀（与 Go 的 sanitizeDevice 一致）：
 * 只保留 [0-9a-z]，不足补 '0'，超长截断，空串退化为 '00000000'。
 */
export function normalizeDevicePrefix(raw: string): string {
  let out = ''
  for (const ch of raw.toLowerCase().trim()) {
    if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z')) {
      out += ch
      if (out.length === HLC_DEV_DIGITS) break
    }
  }
  if (out === '') return DEV_ALL_ZERO
  return out + '0'.repeat(HLC_DEV_DIGITS - out.length)
}

/** 设备 UUID → 8 位前缀（去掉连字符后交给 normalizeDevicePrefix 兜底）。 */
export function devicePrefixFromId(deviceId: string): string {
  return normalizeDevicePrefix(deviceId.replace(/-/g, ''))
}

export function parseHlc(value: string): ParsedHlc | null {
  if (value.length !== HLC_LENGTH) return null
  if (value[HLC_TIME_DIGITS] !== '-' || value[HLC_TIME_DIGITS + 1 + HLC_SEQ_DIGITS] !== '-') return null
  const timePart = value.slice(0, HLC_TIME_DIGITS)
  const seqPart = value.slice(HLC_TIME_DIGITS + 1, HLC_TIME_DIGITS + 1 + HLC_SEQ_DIGITS)
  const devPart = value.slice(HLC_TIME_DIGITS + 1 + HLC_SEQ_DIGITS + 1)
  if (!/^[0-9a-f]{13}$/.test(timePart)) return null
  if (!/^[0-9a-f]{8}$/.test(seqPart)) return null
  if (!/^[0-9a-z]{8}$/.test(devPart)) return null
  return { time: parseInt(timePart, 16), seq: parseInt(seqPart, 16), device: devPart }
}

export function isValidHlc(value: string): boolean {
  return parseHlc(value) !== null
}

/** 与服务端 HLC.Compare 一致：按 (time, seq, device) 三元组比较。 */
export function compareHlc(a: string, b: string): number {
  if (a === b) return 0
  const pa = parseHlc(a)
  const pb = parseHlc(b)
  if (pa === null || pb === null) return a < b ? -1 : 1
  if (pa.time !== pb.time) return pa.time < pb.time ? -1 : 1
  if (pa.seq !== pb.seq) return pa.seq < pb.seq ? -1 : 1
  if (pa.device === pb.device) return 0
  return pa.device < pb.device ? -1 : 1
}

function format(time: number, seq: number, device: string): string {
  const clamped = Math.min(time, HLC_MAX_TIME)
  return (
    clamped.toString(16).padStart(HLC_TIME_DIGITS, '0') +
    '-' +
    seq.toString(16).padStart(HLC_SEQ_DIGITS, '0') +
    '-' +
    device
  )
}

/**
 * 本地 HLC 时钟。send() 产生本地事件的时间戳，observe() 在拉取到远程变更后推进本地时钟，
 * 保证「本机之后产生的 HLC 一定晚于已观测到的远程事件」（因果单调性）。
 */
export class HybridLogicalClock {
  readonly devicePrefix: string
  #time = 0
  #seq = 0
  readonly #now: () => number

  constructor(deviceId: string, now: () => number = Date.now) {
    this.devicePrefix = devicePrefixFromId(deviceId)
    this.#now = now
  }

  get last(): string {
    return format(this.#time, this.#seq, this.devicePrefix)
  }

  /** 与 Go Clock.Send / next 同构。 */
  send(): string {
    const ms = Math.min(Math.floor(this.#now()), HLC_MAX_TIME)
    if (ms > this.#time) {
      this.#time = ms
      this.#seq = 0
      return this.last
    }
    if (this.#seq === SEQ_MAX) {
      this.#time = Math.min(this.#time + 1, HLC_MAX_TIME)
      this.#seq = 0
      return this.last
    }
    this.#seq += 1
    return this.last
  }

  /** 与 Go Clock.Observe 同构。非法输入按「忽略」处理，返回当前值。 */
  observe(remote: string): string {
    const r = parseHlc(remote)
    if (r === null) return this.last
    const ms = Math.min(Math.floor(this.#now()), HLC_MAX_TIME)
    let maxTime = this.#time
    if (r.time > maxTime) maxTime = r.time
    if (ms > maxTime) maxTime = ms

    if (maxTime === this.#time && maxTime === r.time) {
      let seq = this.#seq
      if (r.seq > seq) seq = r.seq
      if (seq === SEQ_MAX) {
        this.#time = Math.min(maxTime + 1, HLC_MAX_TIME)
        this.#seq = 0
      } else {
        this.#time = maxTime
        this.#seq = seq + 1
      }
    } else if (maxTime === this.#time) {
      if (this.#seq === SEQ_MAX) {
        this.#time = Math.min(maxTime + 1, HLC_MAX_TIME)
        this.#seq = 0
      } else {
        this.#time = maxTime
        this.#seq = this.#seq + 1
      }
    } else if (maxTime === r.time) {
      if (r.seq === SEQ_MAX) {
        this.#time = Math.min(maxTime + 1, HLC_MAX_TIME)
        this.#seq = 0
      } else {
        this.#time = maxTime
        this.#seq = r.seq + 1
      }
    } else {
      this.#time = maxTime
      this.#seq = 0
    }
    return this.last
  }
}
