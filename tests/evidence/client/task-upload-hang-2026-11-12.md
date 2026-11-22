# 任务：点「上传到云端」后按钮变灰、卡很久、没有任何状况反馈

日期：2026-11-12（承接同日 `task-book-upload-download-2026-11-12.md`）
范围：`apps/server`（上传处理）、`apps/client`（Go 中继 + Vue 前端）

---

## 0. 结论一句话

用户看到的"变灰 + 卡很久 + 没状况"是**两个真实缺陷叠加**造成的：

1. **服务端在"还没读完请求体"时就回了响应**（秒传/401/413/409 都走这条路径），
   Go 的 `http.Server` 随即**掐断连接** ⇒ 浏览器中止上传 ⇒ 客户端只看到一个
   `network_error`（没有原因、没有进度、没法重试）。**这是根因。**
2. **客户端把二进制请求的"总超时"设成了 30 分钟**，而且上传期间**没有任何进度反馈**：
   一旦卡住，用户就盯着一个变灰的按钮等 30 分钟 ⇒ 这就是"卡了很久也不知道状况"。

另外，**中继层还有同形状的第三个坑**：上游提前回响应时，中继直接把响应写回渲染层并结束
handler ⇒ 渲染层正在写的 body 被中继自己掐断。已一并修复。

两侧都改成"**先把请求体收干净，再回响应**"；客户端补上了**逐本进度 + 速度 + 取消 + 重试 +
就近错误原因 + 停滞/响应超时看门狗**。

---

## 1. 根因证据

### 1.1 服务端：提前回响应 ⇒ 连接被掐断（可复现，A/B 已证）

- 旧行为：`apps/server/internal/httpapi/files.go` 的 `handlePutBookFile`
  在命中"秒传"（同哈希已有文件）时**直接写响应返回**，请求体没有读完。
  Go 的 `http.Server` 对"handler 返回但 body 没读完"的处理是：
  最多丢弃 256KB，然后**关闭连接**。
- 浏览器（Chromium/WebView2）的行为：**响应先到 ⇒ 中止上传** ⇒ `fetch`/XHR 报网络错误
  （`net::ERR_ABORTED`）。用户看到的就是"上传失败/卡住"，而不是服务端真正的语义。

**裸 socket A/B 复现**（`scripts/verify-upload-connection.js` + `scripts/verify-upload-dedup-ab.ps1`）：
脚本持续把 8MB body 写出去并观察写入端有没有被对端打断（这才是浏览器的处境；
`curl` 对"提前回响应"是宽容的，**用 curl 测不出这个 bug**）：

```
== 上传连接不被掐断 A/B（裸 socket，模拟浏览器） ==
  FAIL  old(no drain fix)  exit=3  SOCKET_ERROR=ECONNRESET SENT=393216/8388608 (read ECONNRESET)
  PASS  new(drain fix)     exit=0  BODY_SENT=8388608/8388608 | RESPONSE=HTTP/1.1 200 OK SENT=8388608/8388608

旧服务端：★ 上传被掐断    新服务端：整份 body 送达
结论：服务端"提前回响应但不读完请求体"正是上传被掐断的根因；读完请求体后即修复。
```

> 两次运行分别命中了两种失败形态：**连接被重置（ECONNRESET）** 与
> **响应抢在 body 发完之前到达（EARLY_RESPONSE）** —— 两者都是浏览器的
> `net::ERR_ABORTED` / `network_error` 的成因。
> 旧服务端只送出 **393216 / 8388608 字节（4.7%）** 就被回响应 —— 也就是说
> **95% 的书字节根本没上传**，客户端却只得到一句"网络错误"。
> 完整输出见 `apps/client/evidence/verify-upload-dedup-ab-2026-11-12.txt`。

### 1.2 中继：上游提前回响应 ⇒ 中继自己掐断渲染层的上传

- `apps/client/apirelay.go`：`client.Do(outReq)` 一拿到响应就写回渲染层并返回；
  渲染层（WebView）此刻还在往中继写 body ⇒ 中继的连接一关 ⇒ 渲染层的上传被打断。
- A/B（`apps/client/apirelay_earlyresponse_test.go`，慢速 1MB body）：

```
--- WITH fix ---     --- PASS (1.33s)
--- WITHOUT fix ---   FAIL: the whole request body must be sent, got 819200/1048576 bytes (the relay cut the upload short)
```

### 1.3 客户端：30 分钟的"哑超时"

- `apps/client/frontend/src/api/client.ts`：二进制请求用 `binaryTimeoutMs = 30 * 60 * 1000`
  作为**总**超时；上传期间没有任何进度事件，用户无从判断是"在传"还是"死了"。
  加上服务端根本不给有效响应 ⇒ 表现就是"变灰 + 卡很久"。

---

## 2. 修复

### 2.1 服务端：读完请求体再回响应

`apps/server/internal/httpapi/files.go`

- `handlePutBookFile` 开头 `defer s.drainRequestBody(r)`：
  handler 返回前把请求体读完（丢弃），上限 `MaxUploadSize`，默认 64MiB。
  `defer` 在响应 flush 之前执行 ⇒ 客户端永远能把 body 送完。
- 新增 `func (s *Server) drainRequestBody(r *http.Request)`、`const defaultDrainLimit = 64 << 20`。
- "秒传"分支的注释改为指向这个 defer（不再单独调用 drain）。

### 2.2 中继：上游提前回响应时，不掐断渲染层的上传

`apps/client/apirelay.go`

- 新增 `signalingBody`（包装请求体，观测"已读完"）+ `waitRelayBodyDrained(body, timeout)`。
- `Do` 返回后、写回响应前，等待请求体被读完（上限 `relayDrainWait = 30s`；
  正常路径这个等待是 0，因为 body 早被上游读完了）。
- 新增 `apps/client/apirelay_earlyresponse_test.go`（2 个测试）。

### 2.3 客户端 API 层：带进度 / 速度 / 取消 / 看门狗

`apps/client/frontend/src/api/client.ts`

- `putBinary` 改用 **XHR**（`xhr.upload.onprogress` 才有可靠的字节级上传进度；
  `fetch` 的 request 流在浏览器里没有上传进度事件）。
- 新增类型 `TransferProgress`、`BinaryTransferOptions`、`BinaryDownloadOptions`；
  `ApiClientOptions.xhrFactory` 用于测试注入。
- 三种可诊断的失败码：
  - `stall_timeout`：**60 秒没有任何进度** ⇒ 判定卡死（`defaultStallTimeoutMs = 60_000`，
    由原来的 30 秒上调 —— 慢速上传时进度事件本身可能间隔超过 30 秒）。
  - `response_timeout`：**120 秒**没有拿到响应（`defaultBinaryResponseTimeoutMs = 120_000`）。
  - `network_error` / `canceled`：网络断开 / 用户主动取消。
- `requestBinaryWithProgress`：下载用 `res.body.getReader()` 逐块累计并回报进度。

### 2.4 Store：上传任务队列（逐本状态机）

`apps/client/frontend/src/features/library/stores/libraryStore.ts`

- `UploadTaskState` = `pending | preparing | uploading | done | skipped | failed | canceled`；
  `UploadTask` 带 `loaded / total / bytesPerSecond / error / errorCode`。
- `uploadTasks` 用 **`ref`（深度响应式）** 而非 `shallowRef`：
  进度是**就地修改**任务对象字段，`shallowRef` 下不会触发重渲染 ⇒ 进度条永远停在 0。
- `uploadToCloud(book)`：逐本推进状态（preparing → uploading → done/skipped/failed），
  进度回调里用 EMA 平滑速度；同哈希命中且云端**确实有文件** ⇒ `skipped`（秒传）。
- `uploadAllToCloud()`：批量时**只拉一次**云端列表（修掉 N+1），每本失败互相隔离，
  末尾统一 `refreshCloud()`。
- `cancelUpload()` / `cancelDownload()` / `clearFinishedUploads()` / `retryUpload(bookId)`。
- `readLocalBytes()` 改走 `platform.files.readBookBytes()`：不再为了读字节先 `listBooks()`
  读一遍全量本地索引（批量上传时每本书都省一次全量 IPC）。

### 2.5 UI：看得见的进度与失败原因

- 新增 `apps/client/frontend/src/features/library/components/CloudSyncPanel.vue`
  （页面顶部，`data-testid="cloud-sync-panel"`）：总体进度条、每本书的百分比/速度/剩余时间、
  失败原因（就近显示，不用滚到页面底部）、取消、重试、"知道了"。
- `LibraryView.vue`：工具栏按钮在上传时显示**转圈 + "上传中 i/N"**（不再只是变灰）；
  云端行显示下载百分比；云端"没有文件"的条目给出**补传**按钮。
- `BookCard.vue`：上传中的卡片按钮显示转圈 + 百分比。
- i18n：`zh-CN.ts` / `en.ts` 新增 21 个键（进度/速度/取消/重试/各类失败原因/补传/取消下载）。

---

## 3. 测试证据

| 范围 | 结果 |
|---|---|
| 前端单测（27 个文件） | **325 passed / 0 failed** |
| 前端 typecheck（vue-tsc） | **0 error** |
| 服务端 `go test ./...` | 全部 ok（`apps/server/internal/httpapi` 含上传用例） |
| 客户端 Go `go test ./...` | 全部 ok（含新增的 2 个中继用例） |
| 仓库冒烟 `deploy/smoke-test.sh` | **PASS=95 FAIL=0** |
| 上传/下载契约 `scripts/verify-book-download.ps1` | **PASS=26 FAIL=0**（含新增"大文件秒传"用例） |
| 上传连接 A/B（裸 socket） | 旧 **FAIL** / 新 **PASS**（见 1.1） |

新增测试：

- `apps/client/frontend/src/api/__tests__/client.spec.ts`：XHR 上传路径、字节保真、
  4xx→`ApiError`、进度回调、取消→`canceled`、停滞→`stall_timeout`、
  进度持续时不误报停滞、响应超时→`response_timeout`（12 个用例）。
- `apps/client/frontend/src/features/library/__tests__/uploadQueue.spec.ts`（9 个）：
  进度记录、失败态、取消、批量只拉一次列表、单本失败隔离、秒传→skipped、重试、清理、下载取消。
- `apps/client/frontend/src/features/library/__tests__/cloudSyncPanel.spec.ts`（7 个）：
  面板渲染契约（无任务不渲染 / 进度条百分比 / 失败原因 / 重试 / 取消 / 秒传显示）。
- `apps/client/apirelay_earlyresponse_test.go`（2 个）：上游提前回响应时中继不掐断上传；正常路径不引入延迟。
- `scripts/verify-upload-connection.js` + `scripts/verify-upload-dedup-ab.ps1`：
  可复现根因的裸 socket A/B 工具（**curl 测不出这个问题**，因为它对提前回响应宽容）。

---

## 4. 交付物

- `apps/client/client.exe` == `apps/client/bin/hpfreader.exe`
  **15199744 bytes**，sha256 `5EA708C5A68EC6C7...`（2026-11-12 23:40:34，`scripts/build-client.ps1` 产出）。
- 本次改动文件：
  - 服务端：`apps/server/internal/httpapi/files.go`
  - 客户端 Go：`apps/client/apirelay.go`、`apps/client/apirelay_earlyresponse_test.go`（新）
  - 前端：`src/api/client.ts`、`src/api/endpoints.ts`、
    `src/features/library/stores/libraryStore.ts`、
    `src/features/library/LibraryView.vue`、
    `src/features/library/components/CloudSyncPanel.vue`（新）、
    `src/features/library/components/BookCard.vue`、
    `src/i18n/locales/zh-CN.ts`、`src/i18n/locales/en.ts`
  - 脚本：`scripts/verify-upload-connection.js`（新）、`scripts/verify-upload-dedup-ab.ps1`（新）、
    `scripts/verify-book-download.ps1`

---

## 5. 留给后续的已知项（本轮未做，不影响本次交付）

服务端审计里还发现、但与本次"卡住"无关的问题（按风险排序）：

1. 软删除**不释放磁盘占用**（没有垃圾回收，blob 一直留着）。
2. `AttachBookFile` 失败时 `book_files.ref_count` / blob 可能泄漏。
3. 配额校验存在 TOCTOU（并发上传可超额）。
4. `claimsFrom` 的 ok 标记被丢弃。
5. `Content-Disposition` 非 ASCII 文件名应改用 RFC 6266 的 `filename*`。
6. `book.UpdatedAt` 被当作 `ServeContent` 的 modtime，语义不对。
