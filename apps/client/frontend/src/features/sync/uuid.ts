/**
 * UUID v7（时间有序）生成器。
 *
 * 为什么需要它：契约要求 SyncOp.opId 是 UUID v7 —— 服务端 sync_idempotency 表按它去重，
 * 时间前缀能让同一秒内的大量 op 在索引里保持插入顺序，排障时也能直接看出先后。
 */

const HEX = '0123456789abcdef'

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(out)
    return out
  }
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256)
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) {
    const hi = HEX[(b >> 4) & 0x0f]
    const lo = HEX[b & 0x0f]
    out += (hi ?? '0') + (lo ?? '0')
  }
  return out
}

let lastMs = 0
let lastSeq = 0

/** 生成 UUID v7；同一毫秒内递增计数器，保证本地严格递增（可作幂等键）。 */
export function uuidv7(now: number = Date.now()): string {
  let ms = now
  if (ms <= lastMs) {
    lastSeq += 1
    if (lastSeq > 0xfff) {
      lastMs += 1
      lastSeq = 0
      ms = lastMs
    } else {
      ms = lastMs
    }
  } else {
    lastMs = ms
    lastSeq = 0
  }

  const timeHex = ms.toString(16).padStart(12, '0').slice(-12)
  const seqHex = lastSeq.toString(16).padStart(3, '0')
  const rand = randomBytes(8)
  const randHex = toHex(rand)
  const b9 = ((rand[1] ?? 0) & 0x3f) | 0x80
  // 标准 v7 布局：8-4-4-4-12；第三组首字符是版本位 7，第四组首字符是 variant 位。
  return (
    timeHex.slice(0, 8) +
    '-' +
    timeHex.slice(8, 12) +
    '-' +
    '7' +
    seqHex +
    '-' +
    b9.toString(16).padStart(2, '0') +
    randHex.slice(0, 2) +
    '-' +
    randHex.slice(2, 14)
  )
}

/** 生成设备 ID（同样用 v7，便于服务端 devices 表按时间排序）。 */
export function newDeviceId(): string {
  return uuidv7()
}
