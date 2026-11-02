# 同步端到端联调结果（task-13）

- 负责人：backend-research
- 时间：2026-11-03
- 机器：Windows 11 + Docker Desktop（本机联调）
- 判定：**通过** —— 52/52 断言全绿（`checks.json`），前端 `vue-tsc --noEmit` 与 `pnpm run build` 均 exit=0。

本篇报告只放**结论与索引**；每一条结论都能在 `spikes/sync/evidence/` 里找到对应的原始命令、原始输出。

---

## 0. 结论（先看这里）

1. **真实同步链路已打通**：`apps/client/frontend/src/api/**`（客户端 api 层）+ `apps/client/frontend/src/features/sync/**`（同步引擎）
   打到**真实 Go 服务端 + 真实 Postgres 16**，不是 mock、不是本地假接口。
   一次运行产生 66 条真实 HTTP 往返，全部逐条落盘为 JSONL（含请求体、响应体、状态码、耗时）。
2. **服务端合并语义与 `docs/TECH-PLAN.md` §4.3 一致**（实测 8 类冲突场景，见 §5）：
   同副本较新 HLC 生效、同副本陈旧写入忽略、跨副本单调前移、跨副本回退被拒、
   显式回退生效但不覆盖最远、最远进度只增不减、opId 重放幂等、标注删除 remove-wins。
3. **客户端引擎在真实服务端上通过**：HLC 与服务端同构、uuidv7 合法递增、outbox 跨进程持久、
   指数退避 1s→2s→4s…封顶 30s、离线暂存、游标断点续传、server-authoritative apply。
4. 用**真实公版书** `testdata/books/frankenstein.epub` 完成上传 → 秒传去重 → 双设备进度同步：
   sha256 `bf04d57cf243314ab770df6fcea6a9cfb1e5a281426453e23c128c5a9c3eb662`，294,175 字节。
5. 发现 **3 个服务端问题**（2 个健壮性缺陷 + 1 个设备名缺失，见 §6）和 **5 个契约缺口**（见 §7）。
   服务端源码**未改动**（两个缺陷我只提供证据与建议，交给 server-dev / lead 决策）。

---

## 1. 环境（原始输出见 `evidence/env.txt`）

| 组件 | 版本/位置 | 备注 |
| --- | --- | --- |
| Go | go1.26.0 windows/amd64 | `GOTOOLCHAIN=auto` 从 go.mod 自动下载（本机 go-portable 是 1.22.10） |
| 服务端 | `go run ./cmd/api`，监听 `:18080` | `HPF_ENV=dev`、`HPF_STORAGE_DRIVER=local`、`HPF_AI_PROVIDER=fake` |
| Postgres | 容器 `hpf-sync-pg`，镜像 `pgvector/pgvector:pg16` | 映射 `127.0.0.1:55432->5432`，库 `hpf_reader` |
| 迁移 | 00001_init / 00002_rls / 00003_pgvector / 00004_progression_double | `go run ./cmd/migrate -status` 四条全部 applied |
| Node | v24.20.0 | 联调脚本用项目自带 vite 打包后执行 |
| 前端构建 | `corepack pnpm run typecheck` / `build` | 均 exit=0（本次改动没有破坏构建） |

```
# spikes/sync/evidence/env.txt（原始输出）
go version: go version go1.26.0 windows/amd64
go build ./... exit=0
migrate -status exit=0
00001_init.sql                           2026-11-02T16:23:11Z  70f9ef619871
00002_rls.sql                            2026-11-02T16:23:11Z  f59a3a7f0824
00003_pgvector.sql                       2026-11-02T16:23:11Z  ebeed79799d8
00004_progression_double.sql             2026-11-02T16:23:11Z  9a36eaf5f597
```

**为什么另起一个 Postgres 容器**：`deploy/docker-compose.yml` 用的卷 `hpf-reader_pgdata` 是团队共享数据，
本任务需要「清库后重跑」才能拿到可重复的 201/去重证据，因此用独立容器 + 独立端口 + 独立存储目录
（`spikes/sync/evidence/bookfiles`），并显式记录：**没有动团队共享卷**。
minio 镜像本机不可用，故对象存储走 `local` 驱动（与 server-dev 的验证方式一致）。

服务端启动脚本已固化为 `spikes/sync/start-server.ps1`（一次性容器 + 迁移 + API），
可被任何人复跑；其中口令仅用于本机一次性实例，**不得复制到任何非本地配置**。

---

## 2. 复现方式（一条命令）

```powershell
pwsh -NoProfile -File spikes/sync/run-e2e.ps1
```

这个脚本会依次做 4 件事，并把每一步的原始输出 tee 到 `evidence/run-log.txt`：

1. 校验真实书的 sha256（写入 `evidence/book-sha256.txt`）；
2. 重置联调库（`reset.sql`：TRUNCATE 业务表 + RESTART IDENTITY）并清空文件存储；
   目的：让「首次上传 → 201/deduplicated=false」「change_log 从 seq=1 开始」这类证据**每次都一样**；
3. `node spikes/sync/run-e2e.mjs`：用项目自带 vite 把 `spikes/sync/e2e.ts` 打成单文件 ESM 再执行；
4. 用 psql 导出数据库侧原始查询结果（`evidence-queries.sql` → `evidence/db-evidence.txt`）。

> 为什么不用 esbuild CLI：本仓库 node_modules 里没有独立 esbuild CLI（实测 Command not found），
> 而 vite 是现成的，且与前端 build 使用同一套解析规则（TS 转译、路径别名、import.meta.env）。

---

## 3. 证据清单（全部在 `spikes/sync/evidence/`）

| 文件 | 内容 | 产生方式 |
| --- | --- | --- |
| `http-trace.jsonl` | **66 条真实 HTTP 往返**：method、url、requestBody、status、responseBody、durationMs（含 4xx/5xx） | api 层 `onExchange` 钩子逐条写盘 |
| `checks.json` | 52 条断言的 id/名称/通过与否/实测值 | 脚本内 `check()` |
| `summary.json` | 本次运行的汇总（通过数、失败数、书路径、baseUrl） | 脚本收尾 |
| `e2e-run.log` | **原始 stdout/stderr**（含 [build] 日志与每条 PASS/FAIL） | `Tee-Object` |
| `run-log.txt` | 运行总日志：书 sha256、healthz、reset 输出、db 证据 | `run-e2e.ps1` |
| `db-evidence.txt` | 5 组原始 SQL 输出（行数总览 / change_log 裁决轨迹 / reading_progress 权威状态 / annotations 墓碑 / 缺陷取证） | `docker exec psql -f` |
| `env.txt` | go version、`go build ./...` exit code、迁移状态 | pwsh 原样落盘 |
| `book-sha256.txt` | 真实 EPUB 的 SHA256 | `Get-FileHash` |
| `bookfiles/` | 服务端 local 驱动实际写下的书文件（内容寻址两级目录） | 服务端写盘 |
| `api-server.log` | 服务端 JSON 日志（含每个请求的 route/status/duration 与错误详情） | `go run ./cmd/api` 输出 tee |

> 说明：没有 mock —— 书是真实公版 EPUB、服务端是真的 Go 进程、库是真的 Postgres、游标是服务端账号下生成的；
> 唯一的人造件是 `HPF_AI_PROVIDER=fake`（本任务不用 AI 功能）。
>
> ⚠️ `http-trace.jsonl` 里含**一次性本地测试账号**的邮箱/口令/令牌：这些账号只存在于本机一次性容器里，
> 每次运行都会重建（`reset.sql`），**不要复制到任何非本地环境**。

---

## 4. 断言结果：52/52 通过

原始输出：`evidence/e2e-run.log`；结构化数据：`evidence/checks.json`。

### 4.1 客户端纯逻辑（不依赖网络，12 条）

| ID | 断言 | 实测 |
| --- | --- | --- |
| C-01 | HLC 定长 31 且格式合法 | `0018bcfe56800-00000000-11111111` |
| C-02 | 同一毫秒内计数器递增（字典序==时间序） | `…-00000000-…` < `…-00000001-…` |
| C-03 | observe 远程 HLC 后本地严格更大 | `0192a3f4c1b0a-0000000b-11111111` > `0192a3f4c1b0a-0000000a-7f3c9d21` |
| C-11 | 非法 HLC（12 位时间戳）被拒绝且不影响本地时钟 | 返回原值 |
| C-12 | uuidv7 合法且严格递增（8-4-4-4-12，版本位 7） | `01a19d1f-30e8-7000-8558-…` |
| C-04 | 设备前缀规整为 8 位小写字母数字 | `11111111` |
| C-05 | 指数退避 1s→2s→4s…封顶 30s | `[1000,2000,4000,8000,16000,30000,30000]` |
| C-06 | 离线时 outbox 保留待发变更 | pending=1 |
| C-07 | outbox 进程重启不丢（storage 往返） | size=1 |
| C-08 | ack 后出队 | size=0 |
| C-09 | apply 后最远进度只增不减 | total 0.2 / furthest 0.6 |
| C-10 | 游标由服务端 nextCursor 推进 | cursor=11 |

### 4.2 认证 / 书籍 / 文件（17 条）

| ID | 断言 | 实测 |
| --- | --- | --- |
| E-00 | `/healthz` 存活 | `{"status":"ok"}` |
| E-01 | 注册返回 access/refresh + user.id | expiresIn=900 |
| E-02 | Bearer 认证可用（`GET /v1/me`） | 返回同一邮箱 |
| E-03 | 伪造 token → 401 | `401 unauthorized` |
| E-04 | refresh 轮换返回新令牌对 | 新旧 refreshToken 不同 |
| E-05 | 旧 refresh 重用 → 401（重用检测） | `refresh token already used; session revoked` |
| E-06 | 重用检测吊销整个 family | 新 refresh 也 401 |
| E-07 | 建书（带 contentHash） | bookId=`c3f65729-…` size=294175 |
| E-08 | 上传真实 EPUB：201=new blob / 200=命中已有 blob | **201 + deduplicated=false** |
| E-09 | 同文件二次上传 → 200 + deduplicated=true | `{"deduplicated":true}` |
| E-10 | 新书声明哈希与字节不符 → 400 | `contentHash does not match uploaded bytes` |
| E-10b | 同书换不同文件 → 409 | `book already has a different file` |
| E-11 | 书库列表包含新书 | items=2 |
| E-12 | 单书详情可读 | 10 个字段 |
| E-13 | 设备 B 同账号登录（独立令牌） | 令牌与 A 不同 |
| E-14 | 设备列表登记了 A/B | 2 台 |
| E-15 | 引擎自动生成的 deviceId 被服务端接受 | `01a19d1f-df14-7000-…` |

> E-08/E-09 的 201→200 变化是**内容寻址存储**的正确行为：文件按 `sha256` 落盘，
> 第二次上传命中已有 blob 时返回 200 且 `deduplicated=true`（原始响应见 `http-trace.jsonl`）。

### 4.3 服务端缺陷取证（2 条，见 §6）

| ID | 断言（= 复现缺陷） | 实测 |
| --- | --- | --- |
| F-01 | deviceId 已被其它用户占用时 register → 404 | `404 not_found resource not found` |
| F-02 | 非法 UUID 的 opId → 500（应为 400） | `500 internal_error` + 日志 `SQLSTATE 22P02` |

### 4.4 进度同步与冲突裁决（11 条，详见 §5）

| ID | 断言 | 实测 |
| --- | --- | --- |
| S-01 | A 推送进度被 applied 并分配游标 | cursor=1，outbox 清空 |
| S-02 | B 首同步（snapshot）拿到 0.42 | applied=3，cursor=1 |
| S-03 | B 增量 pull（断点续传）看到 0.50 | cursor 1→2 |
| S-04 | 同副本陈旧写入被忽略 | reason=`older_hlc`，服务端仍 0.5 |
| S-05 | 被忽略的 op 不产生变更行 | 服务端游标 2→2，B 拉取 0 条 |
| S-06 | 跨副本前进被接纳（0.8） | cursor=3，位置=最远=0.8 |
| S-07 | 跨副本回退未声明 explicitRewind 被拒 | reason=`stale_no_rewind`，仍 0.8/0.8 |
| S-07b | 同副本较新 HLC 允许回退（0.55），最远保持 0.8 | 位置 0.55 / 最远 0.8 |
| S-08 | 显式回退生效（0.1）但不覆盖最远（0.8） | explicitRewind=true，最远 0.8 |
| S-09 | 同 opId 重放幂等 | status=applied + reason=`duplicate`，游标 6→6 |
| S-10 | B 最终收敛到服务端权威状态 | 位置 0.6 / 最远 0.8 |

### 4.5 标注同步（5 条）

| ID | 断言 | 实测 |
| --- | --- | --- |
| A-01 | A 推送标注 → applied 且本地投影可见 | 标注 id `01a19d1f-e12b-…` |
| A-02 | B pull 到 A 新建的标注 | 可见 |
| A-03 | 删除走墓碑，B 拉取后消失 | 不可见 |
| A-04 | 墓碑不可复活（remove-wins） | reason=`tombstone_wins`，仍不可见 |
| A-05 | 服务端 REST 创建的标注被客户端 pull 到 | id `622a2b6e-…` |

### 4.6 多用户隔离（5 条）

| ID | 断言 | 实测 |
| --- | --- | --- |
| I-01 | C 的书库为空 | items=0 |
| I-02 | C 直接读 A 的 bookId → 404 | `404 not_found` |
| I-03 | C 的同步快照为空 | books/progress/annotations 全 0 |
| I-04 | C 从 cursor=0 拉不到 A 的任何变更 | changes=0 |
| I-05 | C 写同一 bookId 只影响自己的行 | A 0.6→0.6；C=0.01 |

---

## 5. 冲突裁决实测（逐条对照 `docs/TECH-PLAN.md` §4.3 + 服务端 `internal/sync/merge.go`）

### 5.1 判定表

| 场景 | §4.3 规定 | 实测服务端行为 | 客户端可见结果 |
| --- | --- | --- | --- |
| 同副本 + 更旧 HLC | 忽略，保持服务端值 | `StatusIgnored` / `older_hlc`，**不写 change_log** | S-04 / S-05 |
| 同副本 + 更新 HLC（含回退） | 采纳，允许主动回退 | `StatusApplied`（无 reason 字段） | S-07b |
| 跨副本 forward（Δ>0.002） | 单调前移，采纳 | `applied` + `monotonic_forward` | S-06 |
| 跨副本 backward 且未声明 rewind | 忽略 | `ignored` + `stale_no_rewind`，不写 change_log | S-07 |
| 跨副本 backward + `explicitRewind=true` | 采纳位置，**最远不变** | `applied` + `explicit_rewind`，`furthest=0.8` | S-08 |
| 最远进度 | 只增不减 | GREATEST(furthest) 语义，实测最远值 0.8 始终不变 | S-06/S-07/S-08 |
| 标注删除 | remove-wins 墓碑（30 天） | 陈旧 upsert → `tombstone_wins` | A-03/A-04 |
| 同 opId 重放 | 幂等，游标不变 | `reason=duplicate`，cursor 6→6 | S-09 |
| 服务端角逐设备 | 游标只能服务端分配 | `change_log.seq` 单调，push 被忽略时游标不动 | S-05/S-09 |

### 5.2 原始 SQL 证据（`evidence/db-evidence.txt` 摘录）

服务端裁决轨迹（每一行 == 一条被采纳的变更 == 一个游标位）：

```
=== 2) change_log：服务端裁决轨迹（seq 单调递增 == 游标） ===
 seq |   entity   | entity_id8 |   op   |               hlc               | device8  | total_progression |  content_hash16
-----+------------+------------+--------+---------------------------------+----------+-------------------+------------------
   1 | progress   | c3f65729   | upsert | 001a19d1fdfcf-00000000-a1a1a1a1 | a1a1a1a1 | 0.42              | sha256:bf04d57cf
   2 | progress   | c3f65729   | upsert | 001a19d1fe00d-00000000-a1a1a1a1 | a1a1a1a1 | 0.5               | sha256:bf04d57cf
   3 | progress   | c3f65729   | upsert | 001a19d1fe074-00000000-a1a1a1a1 | a1a1a1a1 | 0.8               | sha256:ababababa
   4 | progress   | c3f65729   | upsert | 001a19d1fe0ab-00000000-a1a1a1a1 | a1a1a1a1 | 0.55              | sha256:ababababa
   5 | progress   | c3f65729   | upsert | 001a19d1fe0c2-00000000-a1a1a1a1 | a1a1a1a1 | 0.1               | sha256:bf04d57cf
   6 | progress   | c3f65729   | upsert | 001a19d1fe0f0-00000000-a1a1a1a1 | a1a1a1a1 | 0.6               | sha256:bf04d57cf
   7 | annotation | 01a19d1f   | upsert | 001a19d1fe12b-00000000-a1a1a1a1 | a1a1a1a1 |                   |
   8 | annotation | 01a19d1f   | delete | 001a19d1fe158-00000000-a1a1a1a1 | a1a1a1a1 |                   |
   9 | annotation | 622a2b6e   | upsert | 001a19d1fe1b4-00000000-418c5f27 |          |                   |
  10 | progress   | c3f65729   | upsert | 001a19d1fe240-00000000-a1a1a1a1 | a1a1a1a1 | 0.01              | sha256:cdcdcdcdc
(10 rows)
```

注意 seq=9：`device_id` 为空、HLC 的 device 段是服务端派生值 —— 这是 **REST 直接创建标注**
（`AppendServerChange`）被记录进变更日志的证据，客户端同样能拉到（A-05），说明游标确实只由服务端分配。

服务端权威合并结果（同一 bookId 两行：A 与 C 各自一行，证明租户隔离在行级）：

```
=== 3) reading_progress：服务端权威合并结果 ===
  book8   | total_progression | furthest_progression | explicit_rewind |  content_hash16  |               hlc
----------+-------------------+----------------------+-----------------+------------------+---------------------------------
 c3f65729 |               0.6 |                  0.8 | f               | sha256:bf04d57cf | 001a19d1fe0f0-00000000-a1a1a1a1
 c3f65729 |              0.01 |                 0.01 | f               | sha256:cdcdcdcdc | 001a19d1fe240-00000000-a1a1a1a1
(2 rows)
```

标注墓碑：

```
=== 4) annotations：墓碑（deleted_at 非空 == 已删除但仍占墓碑窗口） ===
   id8    |   kind    |  book8   |   state   | change_rows
----------+-----------+----------+-----------+-------------
 01a19d1f | highlight | c3f65729 | tombstone |           2
 622a2b6e | note      | c3f65729 | active    |           1
(2 rows)
```

---

## 6. 发现的服务端问题（未修改服务端代码，只提供证据与建议）

### 6.1 F-01（中）：deviceId 被其它用户占用时 `POST /v1/auth/register` 返回 404，且**留下孤儿用户行**

- 复现：同一 `deviceId` 先注册用户 1（201），再用它注册用户 2 →
  `404 {"code":"not_found","message":"resource not found"}`（原始往返见 `http-trace.jsonl`）。
- 更深一层（这条更严重）：**失败的注册已经把用户行写进库了**。原始 SQL 输出：
```
=== 5) 缺陷取证：失败的 register 是否留下孤儿用户（devices=0 即孤儿） ===
              email              | devices
---------------------------------+---------
 spike-f1b-mvzhfw5t@example.com  |       0
```
  即 `spike-f1b-*` 这个账号存在、但没有任何 device，注册「失败」却占用了邮箱。
  用户再用同一邮箱重试注册时，行为不可预测（当前是 404，不是 409），且无法完成注册。
- 推断根因：register 流程里「先建用户、再绑定/创建 device」不是一个事务，
  device 冲突时把 `store.ErrNotFound` 冒到了 `respond.go` 的 404 分支（httpapi/auth.go 的 register 路径）。
- 建议（给 server-dev）：
  1. deviceId 冲突 → 明确返回 `409 conflict`（或直接忽略该 deviceId、为本次会话新建一个设备）；
  2. register 全程放进一个事务，失败回滚 users 行；
  3. 错误体带上可诊断信息（当前只有 "resource not found"）。

### 6.2 F-02（低-中）：非法 UUID 的 opId 触发 500（应为 400）

- 复现：`POST /v1/sync/push` 带 `opId="01a19d1b-66b3-000-7b27-85780e478194"`（组长度非法）→
  `500 {"code":"internal_error","message":"sync push failed"}`。
- 服务端日志（`evidence/api-server.log`）：
```
{"msg":"sync push failed","error":"lookup op 01a19d1b-66b3-000-7b27-85780e478194: ERROR: invalid input syntax for type uuid: \"01a19d1b-66b3-000-7b27-85780e478194\" (SQLSTATE 22P02)"}
```
- 影响：① 客户端拿不到「哪个 op 有问题」的信息；② 我的引擎把 5xx 当**可重试**错误，
  这类请求会被无限退避重试；③ 500 会让监控误报服务端故障，而其实是入参问题。
- 建议：在 push 入口校验 `opId/entityId/deviceId` 必须是 UUID（`uuid.Parse`）→ 400；
  或在 store 层把 `22P02` 映射为 400 `invalid_request`。
- 备注：**这个坑是我自己先踩到的**（我的 uuidv7 生成器最初少写了版本位，产出 8-4-3-4-12 的畸形 UUID），
  修好后链路全绿；但这个 500 说明服务端缺少入参校验，属于真实缺陷。

### 6.3 F-03（低）：`GET /v1/devices` 的 `name` 为空

```
[{"id":"a1a1a1a1-…","name":"","platform":"android","lastSeenAt":"…"},
 {"id":"a1a1a1a1-…","name":"","platform":"windows","lastSeenAt":"…"}]
```
注册/登录时传了 `deviceName=spike-device-A`，但列表里 `name` 为空 → 设备管理/「踢下线」页面没法显示设备名。
建议：register/login 时把 `deviceName` 落到 devices.name 并在 DTO 回显。

---

## 7. 契约缺口（`api/openapi.yaml`，本任务不改该文件，按任务书要求只记录）

1. **`GET /v1/sync/snapshot` 完全没有收录**，但服务端已实现（`httpapi/server.go` 有路由，`store.SyncStore.Snapshot` 有实现，
   server-dev 的 `STATUS.md` 也有覆盖）。它是「新设备首同步」最省事的接口，客户端不得不用它。
   → 我在 `apps/client/frontend/src/api/contract.ts` 里按服务端实际输出**手写**了 `SyncSnapshotResponse` 类型，
   并加了醒目注释。**补进契约后应删掉手写类型并重跑 `pnpm run api:types`**。
2. **`PUT /v1/books/{bookId}/file` 的 200/201 响应体没有 schema**，实际返回
   `{"contentHash","sizeBytes","deduplicated"}`。同样手写在 `contract.ts`（`FileUploadResponse`）。
   状态码语义（201=新 blob / 200=命中已有 blob / 409=同书已有不同文件 / 400=声明哈希不符）也没写进契约。
3. **`SyncPushResponse.results[].reason` 在「普通 applied」时缺省**：实测只有
   `older_hlc / stale_no_rewind / duplicate / tombstone_wins` 会带 reason，正常的 `newer_hlc` 不带。
   客户端因此无法区分「按 newer_hlc 采纳」与「字段缺失」。建议服务端总是回填 `reason`（内部已有该值），
   便于客户端做可观测与埋点。
4. **push 响应里 `cursor` 的语义没写清**：实测 = 本批最后一条被采纳变更的 `change_log.seq`；
   整批都被忽略时返回当前最大 seq。它**不是**拉取游标（见 §8.4 的坑），契约里应明确。
5. `entity=book_config` 在契约里有，但一期没有对应的本地模型（客户端 apply 时显式忽略、不报错）。

---

## 8. 客户端实现要点（本次交付的代码）

代码量：`src/api/**` + `src/features/sync/**` 共 14 个文件、约 1,470 行（含注释）。

### 8.1 api 层（`apps/client/frontend/src/api/**`）

| 文件 | 职责 |
| --- | --- |
| `client.ts` | 单次 HTTP 往返：Bearer 注入、`AbortSignal.timeout`、`ApiError(status,code,message)`、`requestVoid`、`putBinary`（保留 200/201 状态码）、**`onExchange` 证据钩子** |
| `contract.ts` | 全部 DTO 从 `schema.d.ts` 取（`components['schemas'][…]`）；**4 个契约缺口的手写类型集中在这里并注明** |
| `endpoints.ts` | 按资源域封装：`auth/books/sync/annotations`，路径与 `api/openapi.yaml` 一一对应 |
| `index.ts` | 统一出口 |

类型全部由 `scripts/gen-api-types.mjs` 生成（`pnpm run api:types`），没有手抄一份「平行契约」——
除上面 4 个缺口外，客户端类型与服务端契约是**同源**的。

### 8.2 同步引擎（`apps/client/frontend/src/features/sync/**`）

| 文件 | 职责 |
| --- | --- |
| `hlc.ts` | **与服务端 `internal/sync/hlc.go` 同构**的 HLC：`send()/observe()`、13+8+8 定长、字典序==时间序、设备前缀规整 |
| `uuid.ts` | uuidv7（时间有序 + 同毫秒计数器严格递增），服务端 `sync_idempotency` 用它去重 |
| `outbox.ts` | 出站队列：每次入队即写 storage（进程重启不丢）、只有服务端确认才 `ack` 出队 |
| `apply.ts` | 服务端变更 → 本地投影（纯函数，无裁决）；快照整体替换；**最远进度只增不减** |
| `session.ts` | 令牌持久化 + **单飞刷新**（refresh 是轮换 + 重用检测，并发刷新会把新令牌一起作废） |
| `engine.ts` | 引擎主体：`enqueueProgress/enqueueAnnotation/enqueueBook`、`pushOnce/pullOnce/run/bootstrap`、指数退避、离线暂存、单飞 run、订阅状态 |
| `runtime.ts` | api 层 + 会话 + 引擎的组装 + 应用级单例（**不 import vue**，Node 脚本可直接用） |
| `composables/useSyncStatus.ts` | Vue 适配：`markRaw(engine)` + `shallowRef(status)`，保持原有对外字段不变（SettingsView 无需改动） |
| `types.ts` `storage.ts` `index.ts` | 类型/常量、storage 抽象（localStorage ↔ 内存）、出口 |

**为什么引擎不进 Pinia**（`docs/research/50-vue3-reader-stack.md` §5 / ADR-002 §4）：
引擎内部有 Set/Map/计时器句柄，被 Vue 的 Proxy 包住会导致身份不一致、重渲染放大、以及在 Node 联调环境里无法运行。
所以：引擎是普通类 → `markRaw` → UI 侧只 `subscribe` + `shallowRef`。

### 8.3 与服务端语义对齐的关键常量

- `MAX_OPS_PER_PUSH = 500`（契约上限，引擎默认每批 200）
- `PROGRESS_EPSILON = 0.002`（与 `merge.go` 的 `ProgressEpsilon` 同值）
- `TOMBSTONE_DAYS = 30`（墓碑窗口）
- HLC 设备前缀取 UUID 去掉连字符后的前 8 位并规整为 `[0-9a-z]`

### 8.4 联调中踩到并修掉的两个设计陷阱（已写进代码注释）

1. **push 响应的 cursor 不能当拉取游标。** 最初我在 `pushOnce()` 里用响应 `cursor` 推进本地游标，
   结果「设备自己刚创建的标注在本地永远看不到」——因为 pull 从那一格之后开始，正好跳过了自己这批变更
   （实测现象就是 A-01 失败、A-02 却通过）。修法：**本地游标只由 pull 的 `nextCursor` 推进**，
   push 的 cursor 仅作诊断字段 `pushCursor` 保留。
2. **最远进度在本地也只能增不能减。** pull 回来的是「被采纳的客户端载荷」，不是合并后的行；
   若直接覆盖 `furthestProgression`，一次回退就把本机的最远值弄丢。修法：`apply` 时取
   `max(已有最远, 载荷最远, 当前位置)`，与服务端 `bumpFurthest` 语义一致。

---

## 9. 未验证 / 已知限制（诚实清单）

1. **真机未测**：只在 web/server 平台路径（Node + 浏览器同一份 JS）跑通；**没有在 Windows Wails 外壳与 Android 真机上跑**。
   Wails 绑定层的同步接线不在本任务范围（`apps/client/main.go` 不可改）。
2. **墓碑 GC（30 天）未验证**：需要时间旅行或改系统时钟，本次未做。
3. **单批 >500 ops / 分页上限**未压测（代码有上限约束，但没造 500+ 场景）。
4. **多设备并发 push 竞态**未压测：本次是顺序场景（服务端有事务与唯一约束，但没有并发压力测试）。
5. **限流 429 与退避联动**未验证（默认限流阈值较高，本次 66 条请求没触发）。
6. **属性测试缺失**：`TECH-PLAN.md` §4.3 要求「合并逻辑服务端与客户端同构 + 属性测试」，
   本次给出的是确定性场景 + 客户端纯逻辑断言；随机化属性测试（如 HLC 全序、收敛性）**仍未做**。
7. **真实网络切换**未测：离线场景用注入 `isOnline()` 模拟，没有真的拔网线/切飞行模式。
8. **大文件与 Range 断点续传**未测：本次只验证整文件 PUT（服务端有 Range/ETag，属另一条路径）。
9. **snapshot 类型是手写的**：服务端字段若变更，`vue-tsc` 不会报警（契约缺口 1 的直接后果）。
10. **`src/sync/engine.ts`（旧的 M1 骨架）现在是死代码**：`useSyncStatus` 已指向新引擎，
    仓库里没有其它地方 import 它。它在我的写权限范围之外（`src/sync/**`），**建议由 owner 删除**，
    以免后续有人误用两套引擎。

---

## 10. 文件清单

### 新增（客户端实现，全部在我的写权限范围内）

```
apps/client/frontend/src/api/client.ts          （重写：加 onExchange / requestVoid / putBinary / 超时）
apps/client/frontend/src/api/contract.ts        （新增：契约别名 + 4 个缺口的手写类型）
apps/client/frontend/src/api/endpoints.ts       （新增：auth/books/sync/annotations 四域封装）
apps/client/frontend/src/api/index.ts           （新增：出口）
apps/client/frontend/src/features/sync/hlc.ts        （新增：与服务端同构的 HLC）
apps/client/frontend/src/features/sync/uuid.ts       （新增：uuidv7）
apps/client/frontend/src/features/sync/storage.ts    （新增：storage 抽象 + 浏览器/内存实现）
apps/client/frontend/src/features/sync/outbox.ts     （新增：持久化出站队列）
apps/client/frontend/src/features/sync/apply.ts      （新增：服务端结果 → 本地投影）
apps/client/frontend/src/features/sync/session.ts    （新增：令牌轮换 + 单飞刷新）
apps/client/frontend/src/features/sync/engine.ts     （新增：同步引擎主体）
apps/client/frontend/src/features/sync/runtime.ts    （新增：组装 + 单例）
apps/client/frontend/src/features/sync/types.ts      （新增：类型与常量）
apps/client/frontend/src/features/sync/index.ts      （新增：出口）
apps/client/frontend/src/features/sync/composables/useSyncStatus.ts （重写：markRaw+shallowRef，保持对外字段兼容）
```

### 新增（联调与证据）

```
spikes/sync/e2e.ts                 联调脚本主体（52 条断言，驱动真实 api 层 + 引擎）
spikes/sync/run-e2e.mjs            vite 打包 + 执行
spikes/sync/run-e2e.ps1            一键复现入口（reset → e2e → db 证据）
spikes/sync/start-server.ps1       本地服务端起停（独立容器/端口/存储）
spikes/sync/reset.sql              联调库重置
spikes/sync/evidence-queries.sql   数据库侧取证查询
spikes/sync/RESULTS.md             本文件
spikes/sync/evidence/*             原始证据（JSONL 往返 / 断言 / 日志 / SQL 输出 / 书文件）
spikes/sync/.build/                vite 中间产物（可安全删除，勿提交）
```

### 未改动（明确说明）

- `apps/server/**`：**一行未改**（两个缺陷只报告不修，避免与 server-dev 的写权限冲突）。
- `api/openapi.yaml`、`docs/**`、`deploy/**`、`Taskfile.yml`、`apps/client/main.go`：未改。
- `apps/client/frontend/src/sync/engine.ts`：存在但是死代码（见 §9 第 10 条），不在我的写权限范围。

---

## 11. 构建状态说明（重要，与本次改动无关）

- 我的改动落地后（2026-11-03 00:37 本地时间）实测：**`vue-tsc --noEmit` exit=0、`vite build` exit=0**，即没有破坏构建。
- 2026-11-03 00:41（**我的源码最后一次修改之后**），并行 teammate 正在编辑
  `src/compat/__tests__/polyfills.spec.ts`（文件 mtime = 2026-11-02T16:41:05Z），
  之后 `pnpm run typecheck` / `build` 变红：**11 条错误全部集中在该文件**，
  我的 `src/api/**`、`src/features/sync/**` 零错误。原始输出见 `evidence/typecheck.log`：

```
src/compat/__tests__/polyfills.spec.ts(164,53): error TS18046: 's' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(168,54): error TS18046: 'n' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(169,49): error TS18046: 'n' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(170,49): error TS18046: 'n' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(189,49): error TS2345: Argument of type '(this: { limit: number; }, n: number) => boolean' is not assignable ...
src/compat/__tests__/polyfills.spec.ts(205,49): error TS18046: 'b' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(205,53): error TS18046: 'a' is of type 'unknown'.
src/compat/__tests__/polyfills.spec.ts(292,5): error TS2532: Object is possibly 'undefined'.
src/compat/__tests__/polyfills.spec.ts(292,5): error TS7053: Element implicitly has an 'any' type because expression of type '0' can't be used to index type 'number | number[]'.
src/compat/__tests__/polyfills.spec.ts(293,12): error TS2532: Object is possibly 'undefined'.
src/compat/__tests__/polyfills.spec.ts(293,12): error TS7053: Element implicitly has an 'any' type because expression of type '0' can't be used to index type 'number | number[]'.
```

- 该文件不在我的写权限范围（`src/compat/**`），且正被他人编辑，我**没有改动它**。
  已同步给 lead：**blocking 构建的红色不在同步链路上，需要该文件 owner 修**（典型修法：
  `const copy = structuredClonePolyfill(source) as (number | number[])[]`，或给 spec 内的工具函数补类型注解）。
