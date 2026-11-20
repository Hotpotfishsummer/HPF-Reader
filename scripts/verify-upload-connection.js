#!/usr/bin/env node
/**
 * verify-upload-connection.js —— 黑盒验证「上传过程中服务端不会掐断连接」。
 *
 * 为什么要单独写一个原始 socket 客户端（而不是用 curl / Invoke-WebRequest）：
 *
 *   浏览器的 fetch/XHR 在**服务端提前回响应**（还没读完请求体就回 200）时，
 *   会中止上传并以 network_error 失败（Chrome: net::ERR_ABORTED）。
 *   而 curl / Invoke-RestMethod 对这种情况是**宽容**的：它们照样拿到 200 并
 *   以 0 退出 —— 所以用它们测不出这个 bug（我先踩了这个坑）。
 *
 *   这里用裸 socket 复刻浏览器的关键行为：持续把 body 写出去，
 *   并观察写入端有没有被对端打断（EPIPE / ECONNRESET）。
 *   服务端只有"把请求体读完再回响应"才不会被掐断。
 *
 * 用法：
 *   node verify-upload-connection.js <文件> <host> <port> <路径(含查询串)> <token>
 *   退出码：0 = 整份 body 送达且拿到 2xx；3 = 连接被掐断；其它 = 其它错误
 */
'use strict'

const fs = require('fs')
const net = require('net')

const [, , filePath, host, portArg, urlPath, token] = process.argv
if (!filePath || !host || !portArg || !urlPath) {
  console.error('usage: node verify-upload-connection.js <file> <host> <port> <path> [token]')
  process.exit(2)
}
const port = Number(portArg)
const stat = fs.statSync(filePath)
const total = stat.size

const sock = net.connect(port, host)
sock.setNoDelay(true)

let sent = 0
let response = ''
let finished = false

function finish(code, detail) {
  if (finished) return
  finished = true
  console.log(detail)
  try { sock.destroy() } catch (_) { /* ignore */ }
  process.exit(code)
}

sock.on('connect', () => {
  const headers = [
    `PUT ${urlPath} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Content-Type: application/epub+zip',
    `Content-Length: ${total}`,
    'Connection: close',
  ]
  if (token) headers.push(`Authorization: Bearer ${token}`)
  sock.write(headers.join('\r\n') + '\r\n\r\n')

  // 边读边写：模拟浏览器"一边上传一边等响应"。
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(64 * 1024)
  const pump = () => {
    while (sent < total) {
      const n = fs.readSync(fd, buf, 0, buf.length, sent)
      if (n <= 0) break
      sent += n
      if (!sock.write(Buffer.from(buf.subarray(0, n)))) {
        // 发送缓冲区满：等 drain 再继续（浏览器也是这个行为）。
        sock.once('drain', pump)
        return
      }
    }
    fs.closeSync(fd)
    console.log(`BODY_SENT=${sent}/${total}`)
  }
  pump()
})

sock.on('data', (chunk) => {
  response += chunk.toString('latin1')
  const headerEnd = response.indexOf('\r\n\r\n')
  if (headerEnd < 0) return
  const statusLine = response.slice(0, response.indexOf('\r\n'))
  const status = Number((statusLine.split(' ')[1] || '0'))
  const bodyOk = status >= 200 && status < 300
  // ★ 响应在**body 还没发完**时就到了 ⇒ 服务端提前返回并关闭了连接 ⇒
  //   浏览器在这里会中止上传（net::ERR_ABORTED）⇒ 用户看到"上传卡住/网络错误"。
  if (sent < total) {
    finish(3, `EARLY_RESPONSE=${statusLine} SENT=${sent}/${total} (body 未发完就被回响应)`)
    return
  }
  finish(bodyOk ? 0 : 1, `RESPONSE=${statusLine} SENT=${sent}/${total}`)
})

sock.on('error', (err) => {
  // ★ 连接被对端打断（EPIPE / ECONNRESET）= 上传过程被掐断。
  finish(3, `SOCKET_ERROR=${err.code} SENT=${sent}/${total} (${err.message})`)
})

sock.on('close', () => {
  finish(sent < total ? 3 : 1, `CLOSED_EARLY SENT=${sent}/${total}`)
})

setTimeout(() => {
  finish(4, `TIMEOUT SENT=${sent}/${total} RESPONSE=${response.slice(0, 120)}`)
}, 120000)
