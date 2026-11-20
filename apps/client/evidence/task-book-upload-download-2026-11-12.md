# 任务：客户端「书籍上传 UI 缺失」+「下载行为是否正常」

日期：2026-11-12
范围：`apps/client`（Wails3 桌面壳 + Vue3 前端）、`apps/server`（API）

---

## 0. 结论一句话

- **上传 UI 之前确实基本不存在**：唯一的上传入口是书卡上一个裸 `☁️` emoji，且只有登录后才渲染；
  通过「打开文件 / 拖拽」进来的书**根本不会成为书库条目**，因此这条最常用的路径上**一个上传入口都没有**。
- **下载行为本身是正常的**（服务端字节级正确：sha256 往返一致、Range/ETag/304 全部符合预期）；
  客户端看到的"下载失败"其实是**三个客户端侧缺陷叠加**造成的假象：20 秒超时掐断大文件、
  中继 60 秒"开始响应"定时器掐断大文件上传、以及给"没有文件"的云端条目渲染下载按钮（必然 404）。
- 两侧都已修复，并补上了**可见、可测、可回归**的上传入口。

---

## 1. 根因（逐条，含证据）

### R1 上传入口不可发现（客户端 UI）
- `apps/client/frontend/src/features/library/components/BookCard.vue`：上传按钮原来只有 `☁️` emoji，无文字、无边框。
- `apps/client/frontend/src/features/library/LibraryView.vue`：`can-upload="auth.isAuthenticated"`
  ⇒ 未登录时按钮**整个消失**（功能等于不存在）；且没有批量入口、没有云端功能说明。
- `apps/client/frontend/src/features/library/LibraryView.vue:openFile()`：文件选择器/拖拽打开的书
  **只进了 `reader/bookSession` 内存缓存**，没有 `library.registerSessionBook` ⇒
  书库网格里没有它 ⇒ 这条路径上**没有任何上传入口**。

### R2 云端列表里的"没有文件"条目也渲染下载按钮（必然 404）
- 服务端语义（已核实）：`POST /v1/books` 时就把客户端声明的 `contentHash` 写进 `books.file_hash`，
  但 `books.file_size` 保持 0，直到 `AttachBookFile` 才写入；
  DTO `sizeBytes` 在 `file_size == 0` 时为 `null`（`apps/server/internal/httpapi/books.go:225-256`）。
- 因此"建了书但没传完文件"的条目会出现在云端列表里，
  客户端却给它渲染"下载到本地"⇒ 点击必然 404 `book file has not been uploaded yet`。
- 判据：**`sizeBytes === 0 ⇔ 没有上传过的文件`**（`apps/server/internal/db/migrations/00001_init.sql`：`file_size BIGINT NOT NULL DEFAULT 0`）。

### R3 失败的上传会把书**永久卡死**
- 客户端原来只按 `contentHash` 判断"已上传"。但服务端在**建书时**就写入了 `file_hash`，
  于是"建书成功 + 上传失败"这一组合会永远被判成"已上传"，用户再也不能重传。
- 更糟：客户端想重传会**新建**一本书，而服务端有唯一索引
  `books_user_hash_idx (user_id, file_hash)` ⇒ 409。

### R4 前端 20 秒超时掐断大文件传输（客户端）
- `apps/client/frontend/src/api/client.ts`：`AbortSignal.timeout(timeoutMs)`（默认 20s）
  覆盖**整个 fetch**（含请求体上传与响应体下载）⇒ 100MB+ 的书必然中途 `network_error`。

### R5 中继 60 秒"开始响应"定时器掐断大文件上传（桌面壳）
- `apps/client/apirelay.go`：60 秒定时器**无条件**挂在每个请求上。
  但上游在**读完请求体之前不可能发出响应头** ⇒ 该定时器实际等价于"60 秒内必须上传完"。

### R6 幂等重传被配额重复计费（服务端）
- `apps/server/internal/httpapi/files.go`：`ensureStorageQuota(..., existing.SizeBytes)`
  与 `uploadByteLimit` 都按**全额**再收一次。配额账本（`BookBytesUsed`）按书的 `file_size` 统计，
  重传同一本书 ⇒ `used + size > quota` ⇒ 接近配额上限时误报 507。

---

## 2. 改动清单

### 客户端（前端）
| 文件 | 改动 |
|---|---|
| `frontend/src/features/library/LibraryView.vue` | ① 工具栏新增**带文字的「上传到云端」按钮**（`data-testid="cloud-upload-all"`）并显示待传数量；② 新增云端功能说明条 + **登录按钮**（`openAuthModal`）；③ 网格改用 `library.displayBooks`（含会话书）；④ `openFile()` 调用 `library.registerSessionBook`；⑤ 云端条目 `sizeBytes === 0` 时渲染「文件未上传」而**不是**下载按钮；⑥ `cloudErrorText` 支持 `no-file` |
| `frontend/src/features/library/components/BookCard.vue` | 上传按钮改为**带文字带边框**（`☁️ + 上传` / `☁️ + 登录后上传`），新增 `needLogin` / `sessionOnly` props 与「本次会话打开，未入本机书库」提示 |
| `frontend/src/features/library/stores/libraryStore.ts` | ① `hasCloudFile(book)`（`sizeBytes > 0`）；② `readLocalBytes()`（会话内存优先 → 本地书库读盘）；③ `uploadToCloud` 改为「同哈希**且有文件**才跳过；同哈希**无文件**则复用该书 id 重传」；④ `downloadCloud` 对无文件条目**不发请求**、报 `no-file`；⑤ 新增 `sessionBooks` / `displayBooks` / `registerSessionBook` / `uploadAllToCloud` |
| `frontend/src/features/auth/useAuthModal.ts`（新增） | 全局共享的登录弹窗状态（`openAuthModal()`），让未登录用户也能**看到**上传入口 |
| `frontend/src/app/layouts/AppShell.vue` | 改用共享的 `useAuthModal()`（`authModal.open()`），与 LibraryView / SettingsView 的登录入口联动；全应用只有**一个**登录弹窗 |
| `frontend/src/api/client.ts` | 二进制端点独立超时预算 `binaryTimeoutMs`（默认 30 分钟），不再被 20s 掐断 |
| `frontend/src/i18n/locales/{zh-CN,en}.ts` | 新增 `cloudUploadShort` / `cloudUploadNeedLogin` / `cloudUploadAll` / `cloudNoFile` / `cloudEntryHint` / `sessionOnlyHint` |

### 客户端（Go 桌面壳）
| 文件 | 改动 |
|---|---|
| `apirelay.go` | ① **只有无请求体的请求**才受"开始响应"定时器约束（大文件上传不再被掐断），响应头到达即解除；② 超时统一报 **504 `upstream_timeout`**（原来误报 502）；③ 转发前剥离浏览器专属头（`Origin/Referer/Cookie/Sec-Fetch-*/Sec-Ch-*`） |
| `proxyservice.go` | HTTP 代理地址改用 `net.JoinHostPort`（IPv6 主机不再拼出非法地址）——`go vet` 由 2 处报错变为干净 |

### 服务端
| 文件 | 改动 |
|---|---|
| `internal/httpapi/files.go` | 新增 `quotaDelta()`：幂等重传**不重复计费**（`uploadByteLimit` 与秒传分支都按增量算） |

### 新增
- `apps/client/apirelay_timeout_test.go`（3 个新用例：大文件上传不被掐断 / 超时报 504 / 浏览器头不外泄）
- `apps/client/frontend/src/api/__tests__/client.spec.ts`（6 个用例：二进制超时预算 + 字节完整性）
- `apps/client/frontend/src/features/library/__tests__/cloudSync.spec.ts`（+4 个用例：残骸重传 / 秒传命中 / 无文件拒下载 / 会话书可上传）
- `scripts/verify-book-download.ps1`（黑盒端到端验证脚本，含真实书籍字节级校验 + 配额用例）

---

## 3. 验证证据

### 3.1 真实服务端黑盒（`scripts/verify-book-download.ps1`）
服务端：本地构建的 API（Postgres 容器 `hpf-pg`），127.0.0.1:8099；
真实书籍 `testdata/books/frankenstein.epub`（294175 字节）。

```
PASS=24 FAIL=0  ALL DOWNLOAD CHECKS PASSED
```
覆盖：建书 → 上传（201/200）→ **下载字节 sha256 与上传完全一致** → Content-Length → Content-Type →
ETag → If-None-Match→304 → Range→206 且区间字节一致 → 未上传→404 → 别人的书→404 → 未登录→401 →
列表 contentHash/sizeBytes → **配额=书大小时幂等重传仍成功**。
原始输出：`apps/client/evidence/verify-book-download-2026-11-12.txt`。

### 3.2 服务端既有冒烟套件
`deploy/smoke-test.sh` 对本地 API：**PASS=95 FAIL=0**（含"上传文件 = 201"、"同内容再传 = 200（秒传去重）"、
"声明哈希与实际字节不符 = 400"、"同一用户重复挂同一文件 = 409"、"Range 下载 = 206"、"下载带 ETag"）。

### 3.3 单元测试
- 前端：`npm --prefix apps/client/frontend run test` ⇒ **25 文件 / 303 用例全过**
- 前端类型检查：`npm --prefix apps/client/frontend run typecheck` ⇒ **0 报错**
- 客户端 Go：`go test .`（apps/client）⇒ ok
- 服务端 Go：`go test ./...`（apps/server）⇒ 全过；`gofmt -l .` 干净；`go vet ./...` 干净

### 3.4 交付物
`powershell -ExecutionPolicy Bypass -File .\scripts\build-client.ps1` ⇒
`apps/client/client.exe` == `apps/client/bin/hpfreader.exe`，
15181824 字节，sha256 `DB1E745FFEBAEE89C6D39BF8D53E97F5E2895A9C57AEA29DA5A12AB416E2DA12`（2026-11-12 22:38:03）。
已核对 `frontend/dist/assets/*.js` 内含 `cloudUploadShort` / `cloudNoFile` / `sessionOnlyHint` /
`cloudEntryHint` / `cloud-upload-all` / `cloud-status-nofile` ⇒ 新 UI 确实进了 EXE。

---

## 4. 遗留（已确认不阻塞本次交付，未改动）

| 级别 | 问题 | 位置 |
|---|---|---|
| med | 软删除不释放磁盘字节（没有 GC）；`AttachBookFile` 失败时 `book_files.ref_count`/blob 可能泄漏 | `apps/server/internal/store/books.go` |
| low | 配额检查存在 TOCTOU（检查与写入非同一事务） | `apps/server/internal/httpapi/files.go` |
| low | `claimsFrom` 的 ok 标志被丢弃（当前所有用点都在 `requireAuth` 之后，实际不可利用） | `apps/server/internal/httpapi/*.go` |
| low | 非 ASCII 文件名应使用 RFC 6266 `filename*` | `apps/server/internal/httpapi/files.go` |
| low | `book.UpdatedAt` 被当作 `ServeContent` 的 modtime（语义应为文件 mtime） | `apps/server/internal/httpapi/files.go` |
