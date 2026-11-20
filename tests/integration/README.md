# HPF-Reader Server <-> Client 全链路集成测试套件

本测试套件旨在端到端验证 **Go Docker 后端服务**与 **Vue 3 / TypeScript 客户端协议与引擎层**之间的各项核心交互契约。

测试**直接运行于真实环境**：真实 Docker 容器栈（PostgreSQL 16 + pgvector、Redis、Go API、Caddy 自动 HTTPS 反代）、真实公版书籍文件（Project Gutenberg EPUBs）、真实 HLC 时钟与真实 Outbox 出站队列。

---

## 1. 运行方式

### 方式 A：一键全量运行（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-integration.ps1
```

若同时需要跑 Docker 内部的 95 项端到端容器冒烟，可加上 `-RunSmokeDocker` 参数：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-integration.ps1 -RunSmokeDocker
```

### 方式 B：Node / Vite 直接运行

```bash
# 确保 deploy/docker-compose.yml 栈已就绪
node tests/integration/run-all.mjs
```

---

## 2. 测试套件构成与覆盖能力（72 项断言）

| 套件 | 文件 | 覆盖功能与边界场景 | 断言数 |
|---|---|---|---|
| **Suite 1: Docker 后端基础设施** | `suite-backend.ts` | `/healthz` 存活、`/readyz` DB与存储就绪、`/metrics` Prometheus 指标暴露、Caddy HTTPS 反代及安全头基线 (HSTS / nosniff / SAMEORIGIN) | 4 |
| **Suite 2: 认证与多设备会话** | `suite-auth.ts` | 注册 (201)、重复注册冲突 (409)、错误口令拦截 (401)、`/v1/me` 鉴权、多设备独立会话 (Windows / Android)、`/v1/devices`、RefreshToken 轮换、旧 RefreshToken 重用拦截 (401) 与家族连坐吊销 | 9 |
| **Suite 3: 真实书籍与上传去重** | `suite-books-upload.ts` | 3 本真实公版 EPUB 上传（Alice 133.6KB、Frankenstein 287.3KB、Pride and Prejudice 594.9KB）、内容寻址去重（秒传 deduplicated=true）、哈希篡改拦截 (400)、HTTP 206 Range 分片下载 (Content-Range/ETag)、全量下载逐字节 SHA-256 校验、元数据 PATCH、软删除 DELETE | 13 |
| **Suite 4: 多设备阅读进度同步** | `suite-sync-progress.ts` | 设备 A 推送进度 (0.25)、设备 B 快照 bootstrap 首同步、增量 pull 游标断点续传 (0.50)、陈旧 HLC 写入忽略 (older_hlc)、跨副本单调前移 (0.85)、未经授权隐式回退拒收 (stale_no_rewind)、显式回退生效 (explicitRewind: true 当前位置 0.15 但最远进度 0.85 只增不减)、同 opId 重放幂等 (reason: duplicate)、新设备 C (Web) 最终一致性收敛 | 9 |
| **Suite 5: 划线标注同步与裁决** | `suite-sync-annotations.ts` | 设备 A 创建划线标注、设备 B 增量 pull、修改颜色与笔记同步、墓碑软删除 (tombstone)、抗复活裁决 (Remove-Wins：陈旧写入被拒)、服务端 REST 直建批注增量捕获 | 8 |
| **Suite 6: 离线出站队列与容灾** | `suite-offline-outbox.ts` | 离线变更本地入队 (Outbox)、进程重启持久化防丢 (Storage 序列化恢复)、指数退避阶梯断言 (1s, 2s, 4s, 8s, 16s, 30s, 30s)、恢复在线后批量排空提交 (Drain & ACK) | 4 |
| **Suite 7: 多租户强隔离安全防护** | `suite-multi-tenant.ts` | 租户 Bob 访问自身书库为空、越权查询 Alice 书籍元数据 404、越权下载 Alice 书籍文件 404、Bob 快照与变更流无 Alice 记录、Bob 恶意写入 Alice bookId 严格限制在 Bob 自有分区 (Alice 进度零污染) | 6 |
| **Suite 8: 服务器地址与运行期重连** | `suite-server-address.ts` | 地址归一化（补协议/去尾斜杠/空串回默认）、持久化后非组件环境（同步引擎/api client）读到同一份真相、地址变更后 api client 立即指向新地址（无需重启应用）、真实 `/healthz` 连通性探测（成功与不可达都必须如实返回）、**换地址不丢数据**（outbox / 登录令牌 / 本地投影全部保留）、服务器不可达时变更留在 outbox（离线容灾）、地址恢复后自动排空并收敛到服务端权威进度 | 9 |
| **Suite 9: 云端书籍文件同步** | `suite-book-file-sync.ts` | 新设备登录拉取云端书库、**内容哈希 = 跨端身份键**（云端条目与本地文件 sha256 一一对上）、下载字节与源文件逐字节 SHA-256 一致、篡改一个字节即被识破（客户端拒绝入库的依据）、本地已有同哈希判定"已在本地"不重复下载、下载后的书上写入笔记并推送（文件同步与阅读数据同步同一身份）、对端 bootstrap 后收敛到同一 bookId、**快照标注按真实 id 建键**（回归曾经的 `annotations['undefined']` 幽灵条目）、未登录下载被拒 401 | 10 |

### 2.1 本套件实际发现并修掉的两个真实缺陷

| 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 快照丢失标注身份 | 新设备首同步后，服务端明明有标注，本机 `local.annotations` 却按 `undefined` 建键（按 id 查不到、删不掉、UI 多一行坏数据） | `annotations.payload` 存的是客户端上行载荷（不含 id），而 `sync_store.go` 的 Snapshot 直接把 payload 当标注对象返回；客户端 `applySnapshot` 又用 `annotation.id` 当键 | 服务端快照用 `payload || jsonb_build_object('id', id, 'bookId', book_id, 'createdAt', …, 'updatedAt', …)` 注入权威列；客户端抽出 `normalizeAnnotation()` 让 pull/snapshot 两条路径共用，并在缺 id 时跳过而不是写出幽灵键。回归断言 = **BF-08 / BF-10** |
| 打包脚本"假成功" | 前端 `vue-tsc` 报错 → `npm run build` 失败 → 脚本照旧打印 `[OK]` 并把**旧 dist** 打进新 exe（时间戳是新的、代码是旧的） | `scripts/build-client.ps1` 依赖 `$ErrorActionPreference='Stop'`，而原生命令非零退出**不会**被它捕获 | 每一步（npm build / wails3 syso / go build）显式检查 `$LASTEXITCODE` 并 throw；构建前清空 dist；产物再加 `client.exe == bin/hpfreader.exe` 的 SHA-256 一致性自检 |

---

## 3. 证据产物

每次运行会自动在 `tests/integration/evidence/` 输出：
- `integration-results.json`：包含每次运行的 runId、执行时间、总览与 72 项用例的单项耗时与判定详情。
