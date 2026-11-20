import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { TestHarness, fileSha256 } from './runner'
import { createBooksApi } from '../../apps/client/frontend/src/api/endpoints'
import { createSyncRuntime } from '../../apps/client/frontend/src/features/sync/runtime'
import type { BookDto } from '../../apps/client/frontend/src/api/contract'

export interface UploadedBooks {
  alice: { book: BookDto; hash: string; bytes: Uint8Array }
  frankenstein: { book: BookDto; hash: string; bytes: Uint8Array }
  pride: { book: BookDto; hash: string; bytes: Uint8Array }
}

export async function runBooksUploadSuite(
  harness: TestHarness,
  device: ReturnType<typeof createSyncRuntime>,
  testBooksDir: string,
): Promise<UploadedBooks> {
  const SUITE = 'Books & Upload'
  console.log(`\n=== [Suite 3] 真实书籍上传、秒传去重、Range 断点与哈希校验验证 ===`)

  const booksApi = createBooksApi(device.client)

  // 1. 读取 3 本真实测试电子书
  const alicePath = join(testBooksDir, 'alice-in-wonderland.epub')
  const frankensteinPath = join(testBooksDir, 'frankenstein.epub')
  const pridePath = join(testBooksDir, 'pride-and-prejudice.epub')

  const aliceData = await fileSha256(alicePath)
  const frankensteinData = await fileSha256(frankensteinPath)
  const prideData = await fileSha256(pridePath)

  // 2. 建书并上传 Alice in Wonderland
  const aliceBook = await harness.runStep(
    SUITE,
    'BK-U01',
    '创建书籍元数据：Alice in Wonderland (EPUB)',
    () =>
      booksApi.create({
        title: "Alice's Adventures in Wonderland",
        author: 'Lewis Carroll',
        language: 'en',
        format: 'epub',
        contentHash: 'sha256:' + aliceData.hex,
      }),
    (b) => ({ ok: !!b.id && b.contentHash === 'sha256:' + aliceData.hex, detail: `ID: ${b.id}` }),
  )

  const aliceUpload = await harness.runStep(
    SUITE,
    'BK-U02',
    '上传 Alice in Wonderland 文件流 (133.6 KB)',
    () => booksApi.uploadFile(aliceBook.id, aliceData.hex, aliceData.bytes),
    (res) => ({
      ok: res.body.sizeBytes === aliceData.size && res.body.contentHash === 'sha256:' + aliceData.hex,
      detail: `Status: ${res.status}, deduplicated: ${res.body.deduplicated}, size: ${res.body.sizeBytes}`,
    }),
  )

  // 3. 建书并上传 Frankenstein
  const frankBook = await harness.runStep(
    SUITE,
    'BK-U03',
    '创建书籍元数据：Frankenstein (EPUB, 287.3 KB)',
    () =>
      booksApi.create({
        title: 'Frankenstein; Or, The Modern Prometheus',
        author: 'Mary Wollstonecraft Shelley',
        language: 'en',
        format: 'epub',
        contentHash: 'sha256:' + frankensteinData.hex,
      }),
    (b) => ({ ok: !!b.id, detail: `ID: ${b.id}` }),
  )

  const frankUpload = await harness.runStep(
    SUITE,
    'BK-U04',
    '上传 Frankenstein 文件流并写入存储',
    () => booksApi.uploadFile(frankBook.id, frankensteinData.hex, frankensteinData.bytes),
    (res) => ({
      ok: res.body.sizeBytes === frankensteinData.size && res.body.contentHash === 'sha256:' + frankensteinData.hex,
      detail: `Status: ${res.status}, size: ${res.body.sizeBytes}`,
    }),
  )

  // 4. 秒传去重验证：再次上传 Frankenstein 文件流到同一本书
  const frankSecondUpload = await harness.runStep(
    SUITE,
    'BK-U05',
    '秒传去重：重复上传同一文件流立即返回 200 且 deduplicated=true',
    () => booksApi.uploadFile(frankBook.id, frankensteinData.hex, frankensteinData.bytes),
    (res) => ({
      ok: res.status === 200 && res.body.deduplicated === true,
      detail: `Status: ${res.status}, deduplicated: ${res.body.deduplicated}`,
    }),
  )

  // 5. 哈希篡改检测：声明哈希与真实字节不符
  const fakeProbe = await booksApi.create({
    title: 'Tamper Probe Book',
    format: 'epub',
    contentHash: 'sha256:' + 'e'.repeat(64),
  })
  const tamperErr = await harness.expectApiError(
    '上传内容与声明哈希不符',
    () => booksApi.uploadFile(fakeProbe.id, 'e'.repeat(64), frankensteinData.bytes),
    400,
  )
  harness.check(
    SUITE,
    'BK-U06',
    '声明哈希与实际传输字节不一致被严格拦截（400 invalid_request）',
    tamperErr.ok,
    tamperErr.detail,
  )

  // 6. 建书并上传 Pride and Prejudice (最大书籍, 594.9 KB)
  const prideBook = await harness.runStep(
    SUITE,
    'BK-U07',
    '创建书籍元数据：Pride and Prejudice (EPUB, 594.9 KB)',
    () =>
      booksApi.create({
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
        language: 'en',
        format: 'epub',
        contentHash: 'sha256:' + prideData.hex,
      }),
    (b) => ({ ok: !!b.id, detail: `ID: ${b.id}` }),
  )

  const prideUpload = await harness.runStep(
    SUITE,
    'BK-U08',
    '上传 Pride and Prejudice 大文件流',
    () => booksApi.uploadFile(prideBook.id, prideData.hex, prideData.bytes),
    (res) => ({
      ok: res.body.sizeBytes === prideData.size,
      detail: `Status: ${res.status}, size: ${res.body.sizeBytes}`,
    }),
  )

  // 7. Range 请求验证（HTTP 206 Partial Content）
  const token = device.session.accessToken ?? ''
  const rangeResp = await fetch(`${harness.baseUrl}/v1/books/${frankBook.id}/file`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: 'bytes=0-63',
    },
  })
  const rangeBuf = await rangeResp.arrayBuffer()
  const contentRange = rangeResp.headers.get('content-range')
  const etag = rangeResp.headers.get('etag')

  harness.check(
    SUITE,
    'BK-U09',
    'HTTP Range 分片请求：返回 206 Partial Content、精确 64 字节并带有 Content-Range 与 ETag',
    rangeResp.status === 206 &&
      rangeBuf.byteLength === 64 &&
      contentRange?.startsWith('bytes 0-63/') === true &&
      etag?.includes(frankensteinData.hex) === true,
    `Status: ${rangeResp.status}, Bytes: ${rangeBuf.byteLength}, Range: ${contentRange}, ETag: ${etag}`,
  )

  // 8. 全量下载比对：下载字节与源文件 SHA-256 完全一致
  const fullResp = await fetch(`${harness.baseUrl}/v1/books/${aliceBook.id}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const fullBuf = new Uint8Array(await fullResp.arrayBuffer())
  const downloadedHex = createHash('sha256').update(fullBuf).digest('hex')
  harness.check(
    SUITE,
    'BK-U10',
    '全量下载文件与本地测试源文件逐字节比对（SHA-256 吻合）',
    fullResp.status === 200 && downloadedHex === aliceData.hex && fullBuf.byteLength === aliceData.size,
    `Original: ${aliceData.hex.slice(0, 16)}..., Downloaded: ${downloadedHex.slice(0, 16)}...`,
  )

  // 9. 更新书籍元数据 (PATCH)
  const patched = await harness.runStep(
    SUITE,
    'BK-U11',
    '更新书籍元数据 (PATCH /v1/books/{id})',
    () => booksApi.update(aliceBook.id, { title: "Alice's Adventures in Wonderland (Annotated)", readingState: 'reading' }),
    (b) => ({ ok: b.title.includes('Annotated') && b.readingState === 'reading', detail: `title: ${b.title}, readingState: ${b.readingState}` }),
  )

  // 10. 书籍软删除 (DELETE)
  const tempBook = await booksApi.create({ title: 'Delete Test Book', format: 'epub' })
  await harness.runStep(
    SUITE,
    'BK-U12',
    '软删除书籍 (DELETE /v1/books/{id})',
    () => booksApi.remove(tempBook.id),
  )

  const listAfterDel = await booksApi.list()
  harness.check(
    SUITE,
    'BK-U13',
    '已删除书籍不再出现在普通书库列表中',
    !listAfterDel.items.some((item) => item.id === tempBook.id),
    `Active items count: ${listAfterDel.items.length}`,
  )

  return {
    alice: { book: aliceBook, hash: aliceData.hex, bytes: aliceData.bytes },
    frankenstein: { book: frankBook, hash: frankensteinData.hex, bytes: frankensteinData.bytes },
    pride: { book: prideBook, hash: prideData.hex, bytes: prideData.bytes },
  }
}
