# apps/server STATUS — HPF-Reader 服务端

> 交付人：server-dev（task-8）、client-dev（task-21 书源）｜接口契约：`api/openapi.yaml`
> DDL / 同步设计参考 docs/TECH-PLAN.md §4.2、§4.3
> 结论：**编译、单测、迁移、起服务、端到端 push/pull 全部实测通过**。
>
> **task-21 书源（§8）**：只做 OPDS（开放标准）+ 内置合法公版源，
> **不含**通用抓取规则引擎（方案按法律意见修正，见 `docs/M5-PLAN-LEGAL-CORRECTION.md` §12）。
> 合法性判据在协议层：只对 `http://opds-spec.org/acquisition/open-access` 给下载链。

## 0. 验证证据（都是实际执行结果）

```
go build ./...   → exit=0
go vet ./...     → exit=0
go test ./... -count=1
  ok  internal/auth      0.152s      # argon2id / JWT / refresh 轮换 / 限流
  ok  internal/config    0.114s      # 默认值 / prod 强制密钥 / 枚举校验
  ok  internal/httpapi   1.062s      # 探针 / 401 / 限流 / CORS / 指标文本
  ok  internal/sources   0.804s      # gutendex 解析 / SSRF 白名单 / 超时
                                     # + task-21：OPDS 解析 / open-access 判据 / DNS 重绑定防护
  ok  internal/storage   0.103s      # 分片布局 / 原子写 / 路径穿越 / 哈希
  ok  internal/store     0.636s      # 游标编解码 / 错误翻译 / 载荷助手
  ok  internal/sync      0.566s      # ★ HLC 单调+因果、幂等、合并、游标
  test exit=0

docker compose -f deploy/docker-compose.yml config -q   → exit=0

空库迁移（DROP/CREATE DATABASE 后执行 cmd/migrate）：
  applying 00001_init.sql → applied
  applying 00002_rls.sql  → applied
  applying 00003_pgvector.sql → applied
  applying 00004_progression_double.sql → applied
  再跑一次 → "migrations up to date"（幂等）
  结果：schema_migrations 4 行、public 下 15 张表（含 chunk_embeddings，pgvector 已启用）

端到端冒烟（deploy/smoke-test.sh，在 compose 网络内真实调用 HTTP）：
  ==== 冒烟结果: PASS=69 FAIL=0 ====
  ALL SMOKE CHECKS PASSED

Caddy 自动 HTTPS + 反代 api：
  curl -sk --connect-to localhost:443:caddy:443 https://localhost/healthz
  → {"status":"ok","time":"2026-11-02T16:01:33Z"}
```

冒烟覆盖（69 项断言）：

- 探针：`/healthz`、`/readyz`（真 ping DB）、`/metrics`
- 认证：注册 201、重复邮箱 409、登录 200、错误口令 401、伪造 token 401、`/v1/me`、`/v1/devices`、刷新 200、**旧 refresh 重用 401（轮换 + 重用检测）**
- 文件：上传 201、**同内容再传 200 `deduplicated:true`（秒传）**、声明哈希与实际字节不符 400、`books_user_hash_idx` 冲突 409、**Range 206 + 只回 16 字节 + Content-Range + ETag**
- 同步：首次写入 applied + 返回游标；**同 opId 重放 `reason=duplicate` 且游标不动**；**同副本更旧 HLC `reason=older_hlc` 且游标不动**；**跨副本前进后 snapshot 位置/最远均为 0.8**；**跨副本显式回滚后位置 0.1、最远仍 0.8（回滚不覆盖最远位置）**；**跨副本未声明回退 `reason=stale_no_rewind`**；pull 增量 + limit 分页；snapshot
- 标注：建 201、列 200、改 200、删 204、重复删 204（幂等）
- AI：SSE 200 + `event: delta` + `event: done` + `Content-Type: text/event-stream`
- 书源：未知源 400 且响应列出可用源、缺 `q` 400

## 1. 完成项

### 1.1 可运行骨架

| 项 | 位置 | 说明 |
|---|---|---|
| 入口 | `cmd/api/main.go` | 配置→日志→DB(迁移)→store→同步引擎→AI→HTTP；信号优雅关闭（20s 排空 + worker 停止） |
| 迁移命令 | `cmd/migrate/main.go` | `-status` 查看已应用；供独立 migration job 使用；用 `config.LoadMigrate`（只校验数据库，缺 JWT 密钥也能跑） |
| 健康检查子命令 | `cmd/api healthcheck --url ...` | distroless 没有 shell/curl，探针由二进制自身实现 |
| 探针 | `internal/httpapi/system.go` | `/healthz` 不依赖外部；`/readyz` 真 ping DB，失败 503 |
| 指标 | `internal/httpapi/metrics.go` | `/metrics` Prometheus 文本格式（零依赖手写，标签值 `%q` 转义） |
| 配置 | `internal/config/config.go` | 纯环境变量；dev 有安全默认值，prod 强制 `HPF_JWT_SECRET` |
| 日志 | `internal/logging` + `middleware.go` | log/slog JSON，字段 requestId/route/status/duration/ip |

中间件链（外→内）：requestId → recover → logging → CORS → metrics → rateLimit → auth。

### 1.2 数据库迁移（`internal/db/migrations/`，goose 兼容格式，`//go:embed` 进二进制）

| 文件 | 内容 |
|---|---|
| `00001_init.sql` | users, devices, refresh_tokens, books, book_files, reading_progress, annotations, **change_log（seq BIGINT GENERATED ALWAYS AS IDENTITY）**, sync_idempotency, book_sources, ai_jobs, ai_usage, audit_logs + 索引 |
| `00002_rls.sql` | 租户隔离兜底：`app_current_user_id()` + 9 张表 RLS 策略（未设会话变量时放行，供迁移/运维） |
| `00003_pgvector.sql` | 有 pgvector 则建 `chunk_embeddings` + HNSW 索引，没有就跳过（兼容普通 postgres:16） |
| `00004_progression_double.sql` | 进度列 `real` → `double precision`：float4 会把 0.8 读成 0.800000011920929，客户端 JSON 很难看 |

执行器是自研的 ~60 行实现（`internal/db/migrate.go`）：随镜像分发，**运行环境不需要再装 goose**；每个迁移独立事务；`schema_migrations` 记录 sha256，已应用迁移被改写会告警而不是静默重放。

### 1.3 认证

| 接口 | 说明 |
|---|---|
| `POST /v1/auth/register` | argon2id（PHC，默认 m=64MiB/t=3/p=4）；邮箱冲突 409 |
| `POST /v1/auth/login` | 失败计数 + 锁定（5 次 / 15 分钟）；邮箱不存在与口令错误同一响应且耗时对齐（dummy hash），防账号枚举 |
| `POST /v1/auth/refresh` | **轮换 + 重用检测**：旧 token 被复用即吊销整个 family |
| `POST /v1/auth/logout` | 吊销单个 token，或 `allDevices` 吊销全部 |
| `GET /v1/me`、`GET /v1/devices` | 当前用户 / 设备列表 |

access token 15min（HS256，校验 issuer + 算法白名单），refresh 30 天，明文 refresh 不落库（只存 sha256）。

### 1.4 书籍与文件

- `GET /v1/books`（**复合游标** `(created_at, id)`，避免 offset 分页在并发插入时漏记录）、`POST`、`GET/{id}`、`PATCH/{id}`、`DELETE/{id}`（软删除）
- `PUT /v1/books/{id}/file?contentHash=sha256:...`：边落盘边算 sha256；与声明不符立即 400 并删除已写对象；命中已有 hash 走**秒传**（只 `ref_count+1`，不重复写盘）
- `GET /v1/books/{id}/file`：`http.ServeContent` 提供 **Range / If-Range / ETag**（内容哈希即 ETag）
- 存储抽象 `storage.Store`：本地实现按 `ab/cd/<sha256>` 分片、临时文件 + 原子 rename、拒绝路径穿越；**启动时探测根目录可写**，不可写直接启动失败并提示 chown（避免用户上传时才 500）
- **产品规则（有意为之）**：`books_user_hash_idx UNIQUE (user_id, file_hash) WHERE deleted_at IS NULL` —— 同一用户对同一份文件只有一条有效书目，重复挂载返回 409 且说明原因

### 1.5 同步引擎（核心；独立成包 `internal/sync`，不依赖 DB/HTTP，纯函数 + 可注入 store）

| 能力 | 实现 |
|---|---|
| HLC 解析/比较 | `<13位十六进制毫秒>-<8位计数器>-<8位设备前缀>` = **31 字符定长**，因此字典序 == 时间序，SQL 可直接 `hlc > $1` |
| HLC 单调 | `Clock.Send`：墙钟不前进或回拨时靠计数器/逻辑毫秒推进，单设备严格递增 |
| HLC 因果 | `Clock.Observe`：观测远程事件后本地一定产生更大值（两设备互 observe 必然收敛） |
| opId 幂等 | `sync_idempotency` 7 天窗口；重放复用首次结果（**被忽略的 op 也写幂等记录**，否则客户端会无限重试）；同 opId 不同 payload 仍复现首次结果 |
| 进度合并（同 contentHash） | HLC 新者胜；同 HLC 用 deviceId 字典序 tie-break（可复现） |
| 进度合并（跨 contentHash） | CFI 不可比 ⇒ 只比 `totalProgression`，epsilon 0.002 内视为噪声不允许回退 |
| 回滚不覆盖最远 | `furthest_progression = GREATEST(...)` 只增不减；`explicitRewind=true` 允许当前位置后退但不动最远基线（实测：位置 0.1 / 最远仍 0.8） |
| 删除 | 墓碑 remove-wins；墓碑窗口 30 天后才允许重建同 ID 实体 |
| 标注 | 字段级 LWW（逐字段比 HLC），删除即墓碑 |
| 单调游标 | `change_log.seq` 服务端 identity 分配；**REST 写入的标注也走 `AppendServerChange`**，否则其它设备永远拉不到服务端的修改 |
| 原子性 | 一次 push 的「幂等记录 + 实体写入 + change_log 分配」在**同一事务**内完成 |

接口行为要点：

- `POST /v1/sync/push`（≤500 op/批）。响应 `status` 只取 `applied|rejected`（契约约束）；`reason` **只在非平凡裁决时出现**：`duplicate`（幂等重放）、`older_hlc`、`stale_no_rewind`（陈旧写入 → 对外仍是 applied，因为服务端权威状态没变、客户端可以安全出队）；成功的 applied 不带 reason。
- `GET /v1/sync/pull?cursor=&limit=`：`change_log` 里存的是**客户端上传的 op 载荷**（用于增量重放），不是服务端合并后的状态；合并结果（总有一天最远进度）在 `snapshot` 与进度查询里。客户端 apply 时自己会 bump furthest，因此两边收敛。
- `GET /v1/sync/snapshot`：新设备首同步全量投影，已剔除墓碑。

### 1.6 标注 / AI / 书源

- 标注：`GET|POST /v1/books/{id}/annotations`、`PATCH|DELETE /v1/annotations/{id}`，全部写 change_log 参与同步
- AI：`POST /v1/ai/translate` **SSE 流式**（`delta`/`done`/`error`；`HPF_AI_PROVIDER=fake` 可离线端到端跑通，`openai` 直连任意 OpenAI 兼容端点并透传上游 SSE）；`POST /v1/ai/jobs` + `GET /v1/ai/jobs/{id}`
- 书源：`GET /v1/sources/search`，内置 **Project Gutenberg（gutendex）真实源**：硬超时、4MiB 响应体上限、只取 EPUB、**SSRF 白名单拒回环/私有网段**、部分失败降级；未知源 400 并列出可用源

### 1.7 Docker 与部署（`deploy/`）

| 文件 | 说明 |
|---|---|
| `apps/server/Dockerfile` | 多阶段：golang:1.26-alpine 静态编译（CGO_ENABLED=0、-trimpath、版本注入）→ **distroless static + nonroot**；HEALTHCHECK 调自带子命令；**`/data/files` 预先 chown 65532**，命名卷初始化后即属运行用户 |
| `deploy/docker-compose.yml` | api + postgres(pgvector:pg16) + redis:7 + minio(+minio-init 建桶) + caddy + web 占位；命名卷、healthcheck、`depends_on: condition: service_healthy`、`.env` 驱动；backend 网络 `internal: true` |
| `deploy/Caddyfile` | 自动 HTTPS + 反代 api；SSE 关闭缓冲（`flush_interval -1`）；`/metrics`、`/healthz` 限内网 |
| `deploy/.env.example` | 所有必需变量 + 注释（含生成随机密钥的方法） |
| `deploy/smoke-test.sh` | 69 项断言的端到端冒烟脚本，可接 CI |
| `deploy/README.md` | 一条命令起服务、冒烟脚本、端口/数据卷表、**备份策略（日7/周4/月6 + 季度恢复演练）**、安全清单 |

### 1.8 队列选型（任务书要求说明理由）

**不用 asynq/river，直接用 Postgres 表 + `FOR UPDATE SKIP LOCKED`**：

1. 单机自托管，为了队列再引入 Redis 只是多一个组件，运维成本不划算；
2. `ai_jobs` 本身就是任务状态的权威来源（前端要轮询进度），再引入外部队列就要维护两份状态；
3. Postgres 的 `SKIP LOCKED` 已能安全支撑多 worker 抢占；
4. 迁移路径清晰：把 `ClaimAIJob` 换成 asynq 客户端即可，业务代码不动。

`REDIS_URL` 已在配置与 compose 预留；`HPF_QUEUE_DRIVER=asynq` 缺 `REDIS_URL` 会启动失败（不静默降级）。

## 2. 未完成项 / 边界（明确列出，不做假实现）

| 项 | 现状 |
|---|---|
| AI 后台任务处理器 | worker 能消费并正确推进状态机，但**未接入模型调用**：任务被标记 `failed` 并写明「M5 范围」，而不是伪造 `succeeded`（虚假成功会让用户以为整书已翻译完） |
| S3/MinIO 存储驱动 | 接口与 compose 里的桶/权限已就绪，驱动未实现；`HPF_STORAGE_DRIVER=s3` 启动即报错 |
| 整书翻译 / 实体归一化 / RAG | 仅预留 schema（`ai_jobs`、`chunk_embeddings`），无业务逻辑 |
| 书源 | 只有 Gutenberg 一个真实源；OpenLibrary / Internet Archive / OPDS 未接入 |
| 多副本部署 | 限流是进程内计数（单实例语义）；服务端 HLC 设备前缀每进程随机，多副本需改为持久化/集中分配 |
| 认证边界 | 无邮箱验证、无找回密码、无 2FA、无管理员接口 |
| RLS | 策略已建作兜底，但 API 路径主要靠显式 `user_id` 过滤；事务内 `app.current_user_id` 封装（`db.WithUser`）尚未全量接入 |
| 进度存 double 而非 numeric | 0.8 这类值本身无法用二进制精确表示，客户端比较必须带 epsilon（引擎已按 0.002 处理） |

## 3. 如何本地跑

```powershell
# 0) 环境（Go 便携版 + 自动工具链）
$env:PATH = 'C:\Users\HOTPOTFISH\go-portable\go\bin;' + $env:PATH
$env:GOTOOLCHAIN = 'auto'
$env:GOPROXY = 'https://goproxy.cn,direct'

# 1) 起依赖（deploy/ 里就有 PostgreSQL 16 + pgvector 与 Redis）
cd deploy; docker compose up -d postgres redis; cd ../apps/server

# 2) 迁移 + 起服务（开发模式：本地目录存储、假 AI）
$env:DATABASE_URL = "postgres://hpf:<password>@127.0.0.1:5432/hpf_reader?sslmode=disable"
go run ./cmd/migrate -status     # 查看迁移状态
go run ./cmd/migrate            # 执行迁移
go run ./cmd/api                # 默认监听 :8080
```

## 4. 如何验证

```powershell
cd apps/server
go build ./... && go vet ./... && go test ./... -count=1        # 1) 编译 / 静态检查 / 单测
cd ../../deploy
docker compose -f docker-compose.yml config -q                 # 2) compose 语法
cp .env.example .env   # 改掉 change-me，HPF_DOMAIN 本地可填 localhost
docker compose -f docker-compose.yml up -d                     # 3) 起全栈
# 4) 端到端冒烟（69 项断言）
docker run --rm --network hpf-reader_edge -v "${PWD}/smoke-test.sh:/smoke.sh:ro" `
  alpine:3.20 sh -c "apk add --no-cache curl >/dev/null && sh /smoke.sh"
```

## 5. 已知问题与绕过

1. **本机 Docker 拉不到 `minio/minio` 与 `minio/mc`**（registry 返回 `pull access denied`，属构建环境镜像白名单限制，非配置错误）。完整栈验证用 `docker compose up -d postgres redis` + `docker compose up -d --no-deps api caddy web` 绕过 minio；能正常访问 Docker Hub 的机器直接 `docker compose up -d` 即可，compose 与 Caddyfile 无需改动。
2. `# syntax=docker/dockerfile:1.7` 已移除：该声明会在构建时额外拉取 Docker Hub 的 dockerfile 前端镜像，受限网络下直接失败；本 Dockerfile 未用任何需要新前端的特性。
3. 卷属主：命名卷会继承镜像里 `/data/files` 的属主（已 chown 65532）。若改成 **bind mount**，宿主机目录必须先 `chown -R 65532:65532`，否则启动即失败（`storage.NewLocal` 会明确报错，不再等到上传时才 500）。
4. `/metrics` 与 `/healthz` 的内网限制用 Caddy `remote_ip` 实现：从 Docker 网络内部访问（172.16/12 网段）会**按设计放行**，因此只能用公网来源验证 403；内网验证会看到 200。
5. Windows 上删除「已被打开」的文件会失败：存储测试与实现都已先关闭句柄，生产路径（临时文件 + rename）不受影响。
6. `go.mod` 声明 `go 1.26.0`：本机 Go 1.22.10 + `GOTOOLCHAIN=auto` 自动切换（已验证）；离线环境需预热工具链。
7. 全程**未执行任何 git 命令**，提交由 lead 统一完成。

---

## 6. 缺陷修复（task-16）：同步联调暴露的 3 个服务端缺陷 + 契约缺口

> 来源：`spikes/sync/RESULTS.md` 与 `spikes/sync/evidence/{http-trace.jsonl,db-evidence.txt}`（task-13 联调）。
> 改动范围：只在 `apps/server/**` 与 `api/openapi.yaml`（契约补齐，明细见 §6.5）。

### 6.1 F-01 · deviceId 被其它账号占用时：404 + 孤儿用户行

**根因**：register 先 `CreateUser`（独立提交），再 `ensureDevice` 绑设备。第二步撞上
`devices` 的「已属他人」分支时返回 0 行 → `pgx.ErrNoRows` → `wrap()` 翻成 `ErrNotFound`，
于是 HTTP 层回 **404**，而用户行**已经提交**，留下 `devices=0` 的孤儿账号
（`db-evidence.txt` §5：`spike-f1b-…@example.com | 0`）。

**修复**：
- `store.RegisterAccount(ctx, email, passwordHash, displayName, dev)`：Begin → 插用户 → 绑设备 → Commit，任一步失败整体回滚（`defer tx.Rollback`）。
- `upsertDevice` 抽成吃 `rowQuerier`（`*pgxpool.Pool` / `pgx.Tx` 都满足），冲突时显式返回 `ErrDeviceTaken`，不再靠 `ErrNoRows` 猜。
- HTTP：`ErrDeviceTaken` → **409** `code=conflict`；与「邮箱已注册」同为 409，但 message 可区分（客户端能判断该换设备 ID 还是换账号）。

**实测（真实 PostgreSQL 16 + pgvector；API 用 `go run ./cmd/api` 起在 127.0.0.1:18081）**

```
--- F-01 步骤1：A 正常注册（占用 deviceId）
POST /v1/auth/register
request : {"email":"f01-a-010637-3035@example.com","platform":"windows","deviceId":"6f889003-…-823856a0d472","password":"…","deviceName":"spike-device-A"}
status  : 201
response: {"accessToken":"…","refreshToken":"…","expiresIn":900,"user":{"id":"a236a340-…","email":"f01-a-010637-3035@example.com",…}}

--- F-01 步骤2：B 用同一个 deviceId 注册
POST /v1/auth/register
request : {"password":"…","deviceId":"6f889003-…-823856a0d472","deviceName":"spike-device-B","platform":"android","email":"f01-b-010637-3035@example.com"}
status  : 409                              ← 修复前是 404
response: {"code":"conflict","message":"deviceId is already registered to another account"}

--- F-01 断言：B 的孤儿用户行数（expect 0；修复前为 1）
0
--- F-01 断言：A 的设备绑定仍然完好（expect 1）
1
```

### 6.2 F-02 · 非法 opId（非 UUID）→ 500，客户端无限重试

**根因**：`POST /v1/sync/push` 不校验 op 字段，`opId` 原样绑进 `uuid` 列，PostgreSQL 抛
SQLSTATE 22P02 → `handleSyncPush` 无条件回 **500**。客户端把 5xx 当可重试，于是
「一条永远不可能成功的 op」被永久重试（`http-trace.jsonl` line 22）。

**修复（策略：整批 400 + 逐条指明，不跳过坏 op）**：
- `sync.ValidateOp` 增加字段级校验：`opId` / `entityId` / `bookId` 必须 UUID、`entity` / `kind` 必须在枚举内、HLC 必须合法，返回结构化 `*InvalidOpError{Field}`。（`entity=book_config` 的 `entityId` 是配置键，**故意豁免** UUID 校验。）
- `handleSyncPush` 在**任何触库动作之前**逐条校验；有任一不合法 → **400** + `details.ops[]`（`index` / `opId` / `field` / `message`），整批不写入。
- 兜底：`store.wrap()` 把 22P02 与 23503 映射为 `ErrInvalidInput`，HTTP 层 → **400**，保证任何入口漏校验也不会变成 500。

**为什么整批拒绝，而不是跳过坏 op 继续**：
1. HTTP 200 的语义必须是「本批每条 op 都拿到了服务端裁决」。若有 op 根本没被处理仍回 200，客户端会把它当已出队 → **静默丢数据**；
2. 非法 opId/entityId 是客户端 bug，重放一百次也不会成功，一次列全比让它盲目重试高效；
3. 400 时没有任何半成品状态（校验先于所有写操作），客户端修好该条后可安全重放整批。

**实测**：

```
--- F-02：非法 UUID 的 opId
POST /v1/sync/push
request : {"deviceId":"6f889003-…","ops":[{"opId":"01a19d1b-66b3-000-7b27-85780e478194",
           "entity":"progress","entityId":"a4eb913c-…","kind":"upsert",
           "hlc":"001a19d234913-00000000-a1a1a1a1","payload":{"totalProgression":0.01}}]}
status  : 400                              ← 修复前是 500
response: {"code":"invalid_request","message":"1 of 1 ops are invalid; the batch was not applied",
           "details":{"ops":[{"index":0,"opId":"01a19d1b-66b3-000-7b27-85780e478194",
           "field":"opId","message":"opId must be a UUID"}]}}

--- F-02 对照：合法 op 仍然正常（证明修复没有误伤正常链路）
status  : 200
response: {"results":[{"opId":"22222222-…","status":"applied"}],"cursor":1}
```

**顺带修掉的第二条 5xx（同类缺陷）**：push 的 progress 引用了不存在的书时，PostgreSQL 抛
23503（外键违例），旧代码同样冒成 500。现在 `wrap()` 把它归为 `ErrInvalidInput`，且
`handleSyncPush` 不再无条件 500，而是走 `writeStoreError`：

```
--- 引用不存在的书（修复前=500 FK 23503，修复后=400）
POST /v1/sync/push
request : {"deviceId":"6f889003-…","ops":[{"opId":"44444444-…",
           "entity":"progress","entityId":"99999999-9999-4999-8999-999999999999",…}]}
status  : 400                              ← 修复前是 500
response: {"code":"invalid_request","message":"request contains a value the server cannot interpret"}
```

### 6.3 F-03 · GET /v1/devices 的 name 恒为空字符串

**根因**：`ensureDevice` 调用 `UpsertDevice(ctx, id, userID, "", platform, appVersion)` —— 设备名
位置写死空串，注册/登录里的 `deviceName` 从未落库；`ListDevices` 又用 `COALESCE(name,'')`，
把 NULL 也压成空串，于是「没有名字」和「名字是空字符串」无法区分。

**修复**：`Device.Name` 改 `*string`；register/login 把 `deviceName` 原样传入；
`ListDevices` 不再 `COALESCE`；DTO 的 `name` 也是 `*string`，未提供时 JSON 输出 **null**。

**实测**：

```
--- F-03：GET /v1/devices（修复前 name 恒为空字符串）
GET /v1/devices
status  : 200
response: [{"id":"6f889003-…","name":"spike-device-A","platform":"windows",
            "lastSeenAt":"2026-11-02T17:06:38Z"}]

--- 数据库侧 device name（expect spike-device-A）
spike-device-A

--- 第二例：登录时未提供 deviceName 的设备应回显 null 而不是空串
POST /v1/auth/login   request: {"email":"f01-a-…","deviceId":"7f198979-…","platform":"linux","password":"…"}
status  : 200
GET /v1/devices
status  : 200
response: [{"id":"7f198979-…","name":null,"platform":"linux","lastSeenAt":"2026-11-02T17:06:39Z"},
           {"id":"6f889003-…","name":"spike-device-A","platform":"windows",…}]
```
### 6.4 回归测试（防止缺陷复活）

| 测试 | 位置 | 断言 | 需要数据库 |
| --- | --- | --- | --- |
| `TestRegisterAccountDeviceConflictLeavesNoOrphanUser` | `internal/store/register_account_test.go` | deviceId 冲突 → `ErrDeviceTaken`；**users 表无该邮箱行**（事务回滚）；原账号绑定未破坏 | 是 |
| `TestUpsertDeviceRejectsForeignDevice` | 同上 | 直接抢占他人 deviceId → `ErrDeviceTaken` | 是 |
| `TestDeviceNameIsPersistedAndEchoed` | 同上 | 注册传的 `deviceName` 落库且 `ListDevices` 读回 | 是 |
| `TestDeviceNameNullWhenNotProvided` | 同上 | 未提供名字 → `Name == nil`（不是空串） | 是 |
| `TestPushForeignKeyViolationIsClientError` | 同上 | 引用不存在的书 → `ErrInvalidInput`（不是未知错误） | 是 |
| `TestSyncPushInvalidOpIDReturns400Not500` | `internal/httpapi/sync_validate_test.go` | 非法 opId → **400**（若校验晚于触库，此测试会因 nil pool panic 变 500 而失败） | 否 |
| `TestSyncPushBatchReportsEveryInvalidOp` | 同上 | 坏 op 与好 op 混批 → 400 且 `details.ops[]` 逐条列出 index/field | 否 |

**关键设计**：F-02 的两个 httpapi 测试**刻意不接数据库**（`newTestServer` 不建 pool）。
如果哪天有人把校验挪到触库之后，测试服务器会直接 panic → recover 中间件 → 500 → 测试失败。
也就是说，这两个用例同时守住了「返回 400」和「校验先于一切写操作」两条性质。

F-01 的用例必须连真实库才有意义（mock 断言不出「没有孤儿行」），因此通过环境变量开启：

```powershell
$env:HPF_TEST_DATABASE_URL = "postgres://hpf:<password>@127.0.0.1:5432/hpf_reader?sslmode=disable"
go test ./internal/store/ -count=1 -run TestRegisterAccount -v
```

未设置该变量时这些用例 `t.Skip`，CI 默认路径（无 DB）依旧全绿。
**注意**：这些用例会 `TRUNCATE users CASCADE`，只能指向空的专用测试库。

本机实测结果（真实库）：

```
--- PASS: TestRegisterAccountDeviceConflictLeavesNoOrphanUser (0.15s)
--- PASS: TestUpsertDeviceRejectsForeignDevice (0.13s)
--- PASS: TestDeviceNameIsPersistedAndEchoed (0.14s)
--- PASS: TestDeviceNameNullWhenNotProvided (0.15s)
--- PASS: TestPushForeignKeyViolationIsClientError (0.15s)
PASS
```

### 6.5 契约缺口（`api/openapi.yaml`，本次唯一改动的非服务端文件）

改动文件：**`api/openapi.yaml`**（611 → 约 730 行）。逐处如下：

**① `PUT /v1/books/{bookId}/file` 的 200/201 没有 schema**
- 原：`200: {description: 已存在（去重命中）}` / `201: {description: 已上传}`，无 `content`。
- 现：两者都指向新增的 `components.schemas.BookFileUploadResult`，
  字段为 `contentHash` / `sizeBytes` / `deduplicated`；并补 `400` / `409` 响应引用。
- 该结构与真实实现逐字一致（曾写成含 `bookId`/`storageKey` 的版本，实测后按实际响应纠正）。
- **语义澄清**：200 与 201 返回**同一结构**，只能靠 `deduplicated` 区分（200⟺`true`，201⟺`false`）。
  实测：
  ```
  PUT …?contentHash=sha256:20a7ec…  → 201 {"contentHash":"sha256:20a7ec…","deduplicated":false,"sizeBytes":64}
  再传同一 hash（已有字节）        → 200 {"contentHash":"sha256:20a7ec…","deduplicated":true,"sizeBytes":64}
  ```

**② push 响应的 `reason` 是可选还是必填**
- 结论：**可选（optional）**。原 schema 已是 `nullable: true` 但没写何时出现，客户端无从判断。
- 现：在 schema 与 `SyncPushResponse.results[]` 上写明——普通 `applied` **不带** `reason`；
  只在裁决非平凡时出现：`newer_hlc` / `explicit_rewind` / `monotonic_forward` / `new_entity` /
  `duplicate` / `older_hlc` / `stale_no_rewind` / `tombstone_wins`（拒绝原因另带 `rejected:` 前缀）。
- 因此 `required` 列表里**不含** `reason`，客户端不要依赖它存在。

**③ push 响应 `cursor` 的语义**
- 结论：是「**推送提交后**的服务端游标」，**不是**下一次 pull 的起点。
- 现已在 schema 里写明：本批提交成功后 `change_log` 的最大 `seq`；整批没有写入时等于该用户当前的 `MAX(seq)`。
- 客户端应保存**最近一次 pull 响应**里的 `cursor` 用于续拉；直接拿 push 的 `cursor` 去 pull 会跳过尚未拉取的变更。
- 同时把 `GET /v1/sync/pull` 的 `cursor` 参数写成半开区间 `(cursor, +∞)`，并说明 `nextCursor` 直接回传、**不要自行 +1**。

**④ 其它因本次修复而必须同步的契约点**
- `GET /v1/sync/push` 新增 `400` 响应：说明「整批不写入 + `details.ops[]` 逐条指明」，标明这是不可重试的客户端错误。
- `POST /v1/auth/register`：补 `deviceName` / `platform` / `deviceId`（`format: uuid`）三个请求字段（原来只有 email/password/displayName，联调方只能靠猜）；补 `400`；`409` 写明两种冲突及「事务回滚、不留孤儿用户」。
- `GET /v1/devices` 的 `Device.name` 改 `nullable: true`，并说明「没有设备名时为 null，不是空串」。
- 新增 `components.responses.BadRequest`（原来只有 Unauthorized/NotFound/Conflict），供上面各处复用。

校验：用 PyYAML 解析通过，26 个 `$ref` 全部可解析、无悬空引用。

### 6.6 本轮验证汇总

```
gofmt -l .                 → 空（无未格式化文件）
go build ./...             → exit=0
go vet ./...               → exit=0
go test ./... -count=1     → 7 个包全 ok（无 DB 路径）
go test ./internal/store -run "TestRegisterAccount|TestUpsertDevice|TestDeviceName|TestPushForeignKey"
                           → 5 个集成用例全 PASS（接真实 PostgreSQL）
```

**全栈实测**（`docker compose`：postgres:16 + redis:7 + api + caddy + web，镜像 `hpf-reader-api:verify`）：

```
docker compose up -d postgres redis && docker compose run --rm migrate
  → migrations up to date
docker compose up -d --no-deps api caddy web
  → api healthy / caddy healthy / web running
deploy/smoke-test.sh（69 项断言，在 compose 网络内真实调用 HTTP）
  → ==== 冒烟结果: PASS=69 FAIL=0 ====
```

三个缺陷在**部署栈**上的复现验证（§6.1–§6.3 的 curl 即来自该栈；
其中 F-01 的数据库侧断言直接查容器内 postgres）：

```
SELECT count(*) FROM users WHERE email LIKE 'f01-b-%'   → 0    ← 无孤儿用户行
SELECT email,(SELECT count(*) FROM devices d WHERE d.user_id=u.id) devices
  FROM users u WHERE email LIKE 'f01-b-%'                 → (0 rows)
```

**部署环境说明**：`deploy/.env` 为本轮验证临时生成（未被提交，含验证用随机密钥），
`HPF_API_IMAGE=hpf-reader-api:verify`；验证结束后容器与镜像保留在本地，
「已知问题」§5 第 1 条所述 minio 限制仍适用（本轮走 `HPF_STORAGE_DRIVER=local`）。

---

## 7. M5-1 成本与配额闸门（task-19）

> 背景：这是**上线阻塞**的真实缺陷，不是优化项。
> 修复前：`ai_usage» 表从建库起从未被 INSERT，`users.quota_ai_calls» 只被读进结构体从未参与比较，
> `handleTranslate» 直接进流式、无任何前置校验 —— 任何人拿到账号就能无限刷 LLM，账单直接失控。

### 7.1 配额为什么是双维度（按 lead 的修正落地）

按「调用次数」单一维度会严重失真：

| 场景 | 单次规模 | 单次成本 | 计为调用次数 |
| --- | --- | --- | --- |
| 划词翻译 | ≤ 2000 字 | 几厘钱 | 1 |
| 整书翻译（后台任务） | 约 28 万输入 + 20 万输出 token | **约 1~2 元** | 1 |

两者差 3 个数量级，却都算「1 次调用」。若默认 1000 次/月配额被刷满整书任务 = **2000 元/用户/月**。

因此**两个维度都要过，任一超限即 429**：

- `calls»：防高频小请求刷爆 QPS 与账单（沿用 `quota_ai_calls»，默认 1000）；
- `tokens»：防单次大任务烧钱（新增 `quota_ai_tokens»，默认 500 万 ≈ 每月 10 本整书翻译）。

429 的 `details» 里用 `dimension» 区分（`calls» / `tokens»）——否则用户只知道被拒，不知道该怎么办。

**周期语义：自然月（UTC 边界）**。选 UTC 而不是服务器本地时区，是为了多副本/多区域部署时
所有实例对「本月」的判定完全一致，不会出现两台机器各算各的账。`resetAt» = 下一个月首。

### 7.2 并发不超发：单条原子 SQL，而不是「先查再写」

`Reserve» 把「判定」与「累加」压进同一条 `UPDATE»：

```sql
UPDATE users u SET
    ai_calls_used  = (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_calls_used  END) + 1,
    ai_tokens_used = (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_tokens_used END) + $2,
    ai_period_start = p.period
FROM (SELECT ai_period_for(now()) AS period) p
WHERE u.id = $1
  AND (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_calls_used  END) + 1 <= u.quota_ai_calls
  AND (CASE WHEN u.ai_period_start <> p.period THEN 0 ELSE u.ai_tokens_used END) + $2 <= u.quota_ai_tokens
RETURNING ...
```

三个要点：

1. **靠行锁串行化**：后到的事务等前一个提交，再基于最新值重新判定，因此不会出现
   「10 个请求都读到 used=2、全部判定通过」这种 TOCTOU 超发。
2. **周期翻转与累加同一条语句**：跨月时若「判定用旧周期、累加用新周期」，账目会错乱。
3. **预扣 + 结算**，而不是「先调用后记账」。后者等于没有闸门：并发的 N 个请求会同时穿过判定，
   然后才一起把额度用掉。进流式前先预扣估计值，流结束后用真实用量结算差额。

**这个结构是为 M5-2 留的**：整书任务在**每个块处理前**调用同一个 `Reserve»，超限时把任务置为
`paused»（可续跑）而不是 `failed»。入场预扣是占位，不是一次性买断。

### 7.3 Token 计数：不要假装精确

请求体带 `stream_options: {include_usage: true}» 让上游在流末尾单独回一帧 usage。
拿不到时（Ollama 不支持该字段）降级为本地粗估，并在 `ai_usage.usage_source» 标 `estimated»：

| usage_source | 含义 |
| --- | --- |
| `upstream» | 上游真的回了 usage |
| `estimated» | 本地粗估（中文约 1.5 字/token，英文约 4 字符/token） |

两者在成本分析里可信度完全不同，混为一谈会让「按 usage 计费」的结论站不住脚。
`cost_cents» 只是量级参考，真实账单必须以上游为准。

**捕获 usage 的坑**：usage 帧的 `choices» 通常是空数组，若「没有 delta 就 continue」会把它跳过。
代码里在遍历 choices **之前**处理 usage 帧。

### 7.4 失败调用也记账

失败也是花钱的：上游可能已经生成并计费了部分 token，不记就是账目缺口。
`outcome» 三种取值：`ok» / `failed» / `canceled»（客户端中途断开）。

实测（上游指向不可达地址 127.0.0.1:9，openai provider）：

```
POST /v1/ai/translate → 200 SSE
event: error
data: {"code":"service_unavailable","message":"ai: upstream request failed: ... connection refused"}

ai_usage 实际写入的行：
 id | feature   | model                | input | output | usage_source | outcome | error
  1 | translate | openai:deepseek-chat |     0 |      0 | estimated    | failed  | ai: upstream request failed: ...
```

### 7.5 迁移 `00005_ai_usage_quota.sql»

- `ai_usage» 加 `usage_source»（upstream|estimated，带 CHECK 约束）、`outcome»（ok|failed|canceled）、
  `error»、`request_id»，并加 `(user_id, created_at)» / `(feature, created_at)» 两个索引；
- `users» 加 `quota_ai_tokens»（默认 500 万）、`ai_calls_used»、`ai_tokens_used»、`ai_period_start»，
  外加 `CHECK (ai_calls_used >= 0 AND ai_tokens_used >= 0)»；
- `ai_period_for(timestamptz)» 函数：UTC 自然月首。**独立成函数**而不是把表达式抄进每条 SQL，
  因为它要出现在 UPDATE 的 SET、WHERE 与诊断查询三处，抄三遍必然在某次改动后漂移，
  而漂移会导致「判定用旧周期、累加用新周期」这种最难查的账目错误。
  （函数名用 `ai_period_for» 而不是 `ai_period_start»，避免与同名列产生解析歧义。）

为什么用新增列而不是每次现算周期：让「跨月重置」与「累加」能在同一条 UPDATE 里原子完成。

### 7.6 顺带修掉的第四个缺陷：`HPF_AI_DAILY_QUOTA» 读了不用

`config.AIMaxPerUser»（来自环境变量 `HPF_AI_DAILY_QUOTA»）此前被读进 Config 后**从未被任何代码使用**，
运维改了环境变量却毫无效果。现在它作为新用户的 `quota_ai_calls» 在注册事务内生效。

### 7.7 新接口 `GET /v1/ai/usage»

返回 `periodStart» / `resetAt» / `calls{used,quota,remaining}» / `tokens{used,quota,remaining}»，
外加按 feature 的实际记账汇总（用于核对「配额消耗」与「真实成本」是否一致）。
**只读**：不能顺手把跨月周期翻篇，否则「看一眼用量」就会重置已用量。
### 7.8 验收证据（真实栈，非 mock）

**环境**：`docker compose» 全栈（postgres:16 + redis:7 + api + caddy + web），镜像 `hpf-reader-api:verify»，
`HPF_AI_DAILY_QUOTA=1»（把新用户配额压到 1，便于在冒烟里验证 429）。

#### ① 并发不超发：配额 3、并发 10 → 恰好 3 个成功

先把配额真实改成 3（`UPDATE users SET quota_ai_calls = 3»），再并发 10 个请求：

```
各请求状态码:
  req1  429      req6  200
  req2  429      req7  200
  req3  429      req8  429
  req4  429      req9  429
  req5  429      req10 200
→ 200 成功 3 个，429 拒绝 7 个
```

数据库侧对账（关键：计数器与记账行数、token 数完全一致）：

```
         email        | quota_ai_calls | ai_calls_used | usage_rows | tokens
----------------------+----------------+---------------+------------+--------
 q3-185358@example.com |              3 |             3 |          3 |    195
```

429 响应体：

```json
{"code":"quota_exceeded","message":"monthly AI quota exceeded: call count limit reached",
 "details":{"dimension":"calls","limit":3,"used":3,"resetAt":"2026-12-01T00:00:00Z"}}
```

#### ② token 维度耗尽（次数还够也不行）

把 `quota_ai_tokens» 压到 1000、次数保持 1000，发一个约 3400 token 的长文本：

```json
status=429
{"code":"quota_exceeded","message":"monthly AI quota exceeded: token budget exhausted",
 "details":{"dimension":"tokens","limit":1000,"used":0,"resetAt":"2026-12-01T00:00:00Z"}}
```

两个维度的 `dimension» 分别正确报出 —— 这正是 lead 要求的「用户能知道该怎么办」。

#### ③ 失败调用也记账

见 §7.4：上游不可达时 `ai_usage» 仍写入一行，`outcome=failed»、`error» 有内容、
且 `ai_calls_used» 计为 1（失败也消耗了调用次数）。

#### ④ ai_usage 表实际行内容

```
 id | feature   | model | input_tokens | output_tokens | cost_cents | usage_source | outcome | error
----+-----------+-------+--------------+---------------+------------+--------------+---------+-------
 17 | translate | fake  |           51 |             3 |          0 | estimated    | ok      | -
 16 | translate | fake  |           53 |             4 |          0 | estimated    | ok      | -
 15 | translate | fake  |           53 |             4 |          0 | estimated    | ok      | -
 14 | translate | fake  |           57 |             8 |          0 | estimated    | ok      | -
 13 | translate | fake  |           57 |             8 |          0 | estimated    | ok      | -
 12 | translate | fake  |           57 |             8 |          0 | estimated    | ok      | -
 11 | translate | fake  |           61 |            12 |          0 | estimated    | ok      | -
 10 | translate | fake  |           61 |            12 |          0 | estimated    | ok      | -
```

按用户对账（`used_calls = rows»、`used_tok = sum_tok» 全部对齐）：

```
           email           | q_calls | used_calls |  q_tok  | used_tok | rows | sum_tok
---------------------------+---------+------------+---------+----------+------+---------
 q-185337@example.com      |    1000 |         11 | 5000000 |      803 |   11 |     803
 q3-185358@example.com     |       3 |          3 | 5000000 |      195 |    3 |     195
 quota-1366-1@example.com  |       1 |          1 | 5000000 |       54 |    1 |      54
 smoke-28538-1@example.com |       1 |          1 | 5000000 |       57 |    1 |      57
 smoke-6550-1@example.com  |       1 |          1 | 5000000 |       57 |    1 |      57
```

（`quota-debug-1@example.com» 与 `smoke-31986-1@example.com» 是注册后未调用的账号，
`used_calls=0 / rows=0» 同样自洽。）

#### ⑤ 冒烟测试

`deploy/smoke-test.sh» 原有 69 项断言 + 本轮新增 13 项配额断言 = **PASS=82 FAIL=0**：

```
== 6b. 成本与配额闸门（M5-1） ==
  PASS  用量接口 = 200
  PASS  用量返回 calls 维度
  PASS  用量返回 tokens 维度
  PASS  用量返回 resetAt
  PASS  周期为 UTC 自然月首
  PASS  调用后已记账（出现 translate 汇总）
  PASS  计数器与记账一致（tokens.used=57 = 53 + 4）
  -- 配额耗尽（配额=1，第 2 次必须 429）--
  PASS  配额账号注册 = 201
  PASS  第 1 次调用 = 200（额度内）
  PASS  第 2 次调用 = 429（超配额）
  PASS  429 错误码 = quota_exceeded
  PASS  429 指明维度 dimension
  PASS  429 带 resetAt

==== 冒烟结果: PASS=82 FAIL=0 ====
```

冒烟里的配额用例是**纯黑盒**：不碰 psql（alpine 容器里没有），只靠
`HPF_AI_DAILY_QUOTA=1» + `QUOTA_TEST=1» 环境变量驱动，保持脚本的可移植性。

#### ⑥ 迁移可重复执行

在一个全新的空库上从零跑 `go run ./cmd/migrate»，00001→00005 全部应用成功：

```
migration applied  version=00001_init.sql
migration applied  version=00002_rls.sql
migration applied  version=00003_pgvector.sql
migration applied  version=00004_progression_double.sql
migration applied  version=00005_ai_usage_quota.sql
migrations up to date
```

#### ⑦ 单元/集成测试

`internal/store/quota_test.go»（真实 PostgreSQL，未设 `HPF_TEST_DATABASE_URL» 时 skip）：

| 测试 | 断言 |
| --- | --- |
| `TestReserveRejectsWhenCallsExhausted» | 次数耗尽 → 维度 `calls»，`resetAt» 在未来 |
| `TestReserveRejectsWhenTokensExhausted» | token 耗尽 → 维度 `tokens»（次数还够也不行） |
| `TestReserveConcurrentDoesNotOverIssue» | **10 goroutine 抢 3 个名额 → 恰好 3 成功 / 7 拒绝**，库里计数恰好 3 |
| `TestSettleAdjustsReservationToActualUsage» | 预扣 1000、实际用 500 → 库里结算为 500 |
| `TestSettleFailureStillRecordsUsage» | 失败调用仍写入 `outcome=failed» 行且 `input_tokens» 保留 |
| `TestUsageSourceIsPersisted» | `usage_source=upstream» 如实落库 |
| `TestPeriodRolloverResetsUsage» | 周期回拨一个月后自动清零重新计数 |
| `TestReleaseTokensNeverGoesNegative» | 退回额度不会把已用量打成负数 |

其中「并发不超发」那条如果实现改成「先 SELECT 再 UPDATE」，会**稳定失败**（10 个都读到 used=0）。

### 7.9 契约变更（`api/openapi.yaml»）

| 位置 | 变更 |
| --- | --- |
| 新增 `GET /v1/ai/usage» | 完整定义，返回双维度 + 按 feature 汇总 |
| `POST /v1/ai/translate» | 补 400/401/429/503；描述说明「闸门在写 SSE 之前判定」与「失败也记账」 |
| `POST /v1/ai/jobs» | 补 400/401/404/429；说明入场预扣是占位、块级结算属 M5-2 |
| 新增 `components.schemas.QuotaDimension» | `used» / `quota» / `remaining» |
| 新增 `components.schemas.AiUsage» | 双维度 + `periodStart» / `resetAt» + 按 feature 汇总 |
| 新增 `components.schemas.QuotaExceededError» | `code=quota_exceeded»、`details.dimension» 枚举 `calls\|tokens»、`resetAt» |

校验：PyYAML 解析通过，29 个 `$ref» 全部可解析、无悬空引用，17 条 path。

### 7.10 本轮验证汇总

```
gofmt -l .                 → 空
go build ./...             → exit=0
go vet ./...               → exit=0
go test ./... -count=1     → 7 个包全 ok（无 DB 路径）
quota 集成测试（接真库）    → 8 个用例全 PASS
deploy/smoke-test.sh       → PASS=82 FAIL=0（全栈，含 13 项配额断言）
```

**已知边界**（不掩饰）：

1. `cost_cents» 按 DeepSeek flash **空闲档**单价折算，只是量级参考；真实账单必须以上游为准，
   上线后要用真实账单校准（见 `docs/M5-PLAN.md» §8）。
2. token 估算（1.5 字/token）是经验值，**未在真书上实测**；`usage_source» 已如实标注来源。
3. 预扣的输出侧估计取「输入估算的一半」，对长输出会偏低；结算时按实际用量补齐，因此账目最终精确，
   但**闸门判定**在极端长输出场景下可能偏松。真正的精确闸门需要上游 usage 预检，属后续优化。
4. 本轮只改 `apps/server/**»、`api/openapi.yaml»、`deploy/smoke-test.sh»（仅加断言），
   未动 `apps/client»、`docs»、`spikes»，**全程未执行 git**。

## 8. M5-5 书源：OPDS 客户端 + 合法公版书库（task-21）

> **方案按法律意见修正过。** 原规划的「声明式 JSON 书源引擎」**已废弃**：
> 该形态与已被判刑的「书源指令包」同构（预设抓取规则 + 指向第三方站点）。
> 详见 `docs/M5-PLAN-LEGAL-CORRECTION.md` §12。
> 本轮只做 **OPDS（开放标准）+ 内置合法公版源**，不含任何通用抓取引擎。

### 8.1 合法性判据落在协议层（这是整个设计的核心）

OPDS 协议定义了 acquisition relation。我们**只对**带
`http://opds-spec.org/acquisition/open-access` 的链接给出 `downloadUrl`。
这是可验证的协议事实，不是「我们觉得它合法」。

必须区分的 relation（都在 `internal/sources/opds.go` 里做成常量）：

| relation | 含义 | 是否给下载链 |
|---|---|---|
| `acquisition/open-access` | 开放获取 | **是（唯一）** |
| `acquisition`（裸的） | 「可获取」，不声明开放 | 否 |
| `acquisition/borrow` | 借阅，需授权 | 否 |
| `acquisition/sample` | 试读 | 否 |
| `acquisition/subscribe` | 订阅 | 否 |
| `enclosure`（Atom 原生） | 附件，无 OPDS 授权语义 | 否 |

实现要点：`IsOpenAccess` 用**精确相等**匹配（`EqualFold`），
不做前缀匹配 —— 否则裸 `acquisition` 会被误判成开放获取（这个坑有专门的单测）。

### 8.2 ★ 实测发现：各源的 relation 形态**并不统一**

这是本轮最重要的发现，直接决定了实现的形状。抓取真实响应后（fixture 在 `testdata/`）：

| fixture | acquisition | open-access | enclosure | 结果 |
|---|---|---|---|---|
| `standardebooks-opds-austen.xml` | 35 | **35** | 0 | 7 条可下载 |
| `gutenberg-ebook-acquisition.opds.xml` | 6 | **0** | 0 | **0 条** |
| `gutenberg-search-navigation.opds.xml` | 0 | 0 | 0 | 0 条（导航型 feed） |
| `standardebooks-atom-austen.xml` | 0 | 0 | 35 | 0 条（普通 Atom） |

**关键结论**：Project Gutenberg 的 `/ebooks/{id}.opds` 用的是**裸** `acquisition`，
一个 `open-access` 都没有。如果严格按 open-access 判据，Gutenberg 的 OPDS 源**不会**给出任何下载链。

这是**故意保留**的行为，不是 bug：
- Gutenberg 的公有领域属性由**内置源的 `License` 字段**声明（我们核实过），
  走的是 `gutendex.com` JSON API（`sources.go` 里已有的 `Gutenberg`），不走 OPDS；
- OPDS 的 open-access 判据只对**「用户自行添加的 OPDS 地址」**这类场景起兜底作用。

**不能**因为「Gutenberg 是公版」就把裸 `acquisition` 也放行 ——
否则任何人挂一个 OPDS 地址、条目里随便写个 `acquisition`，就变成了可下载的盗版链。
两者的合法性来源不同，不能混用。

### 8.3 复用了什么（没重写）

按 Lead 的要求，`sources.go` 的架构**原样复用**：
- `Searcher` 接口、`Registry`、`SearchAll`（并发聚合 + 部分失败容错）
- `Item` 结构（已含 `License` 字段）
- `Gutenberg` 的超时 / 4MiB 响应上限 / `isPrivateHost` SSRF 白名单

新增文件：`opds.go`（协议解析 + 安全客户端）、`opds_source.go`（接 `Searcher`）。

### 8.4 SSRF 加固（比内置源更严）

| 防护 | 做法 |
|---|---|
| 强制 https | `checkURL` 拒绝非 https（测试可放开） |
| 禁内网/回环/链路本地 | `isPrivateHost`（沿用）+ `isPrivateIP`（新增，判解析后的 IP） |
| 禁重定向到内网 | `CheckRedirect` **逐跳**校验（最多 5 跳） |
| **DNS 重绑定防护** | `DialContext` 里先解析、校验**所有**候选 IP、再用校验过的 IP 拨号 |
| 响应体上限 | 8 MiB（`io.LimitReader`） |
| 硬超时 | 8s（`http.Client.Timeout`） |

DNS 重绑定防护是**本轮新增**的：只查主机名字面量拦不住「公网域名解析到 127.0.0.1」。
实现细节：**任何一个**候选 IP 是内网就拒绝整个主机（防轮询 DNS 绕过），
并且用校验过的那个 IP 去拨号（消除「校验后重新解析」的 TOCTOU 窗口）。

### 8.5 验证（全部原始输出见 `apps/server/evidence/task-21-opds-raw-output.txt`）

**单测 26 条全过**，其中核心正确性 4 条直接喂**真实 fixture**：

```
--- PASS: TestParseOPDSStandardEbooksOpenAccess          (35 个 open-access → 7 条可下载，且选 .epub 不是 xhtml)
--- PASS: TestParseOPDSGutenbergBareAcquisitionIsRejected (6 个裸 acquisition → 0 条)
--- PASS: TestParseOPDSNavigationFeedYieldsNoItems        (导航型 feed → 0 条)
--- PASS: TestParseOPDSAtomEnclosureIsNotOPDS             (Atom enclosure → 0 条)
```

**SSRF 反向验证**（证明测试不是空跑）：把 `DialContext` 里的 IP 校验短路成 `if false`，
测试立刻红：

```
ssrf_test.go:87: DialContext connected to loopback: SSRF guard is not effective
--- FAIL: TestDialRejectsPrivateIPBeforeConnecting
```

> 踩坑记录：第一版这条测试只断言 `err != nil`，结果**假阳性** ——
> 拨号到没监听的端口也会 `err != nil`（connection refused）。
> 改成「起一个真的在监听的回环服务 + 断言错误文案来自我们的防护」后才真正有效。
> 这是本轮最容易自欺的地方：**"有错误"不等于"防护生效"**。

**契约门禁**：`TestOpenAPINoDanglingRefs` + `TestSourceItemLicenseEnumMatchesCode`。
反向验证：注入 `$ref: #/components/schemas/DoesNotExist` → 
`dangling $ref(s): [#/components/schemas/DoesNotExist]` + exit 1；还原后 exit 0。

### 8.6 真实网络验证：一个通过，两个**未验证**（如实说明）

| 源 | 状态 | 证据 |
|---|---|---|
| Standard Ebooks | ✅ **已实测通过** | 7 条真实条目，如 "Northanger Abbey" → `.../northanger-abbey.epub` |
| Open Library | ⚠️ **未验证** | `openlibrary.org:443` 从本机不可达（Test-NetConnection=False） |
| Internet Archive | ⚠️ **未验证** | `archive.org:443` 同样不可达 |
| Project Gutenberg | ✅ 已实测（走 gutendex JSON，非 OPDS） | 原有 `Gutenberg` 测试全过 |

Open Library 与 Internet Archive **不是代码问题，是网络不可达**。我没有把它们标成"已验证"。
保守处理：
1. 两者都标 `mixed-open-access`（源内混合公版与借阅），**不**预设它们全是公版；
2. 合法性判据完全交给 open-access relation —— 即使 URL 参数有偏差，
   最坏结果是「搜不到」，**不会**给出未经授权资源的下载链；
3. 可用 `HPF_OPDS_OPEN_LIBRARY_URL` / `HPF_OPDS_INTERNET_ARCHIVE_URL` 覆盖地址。

⚠️ **接入前必须在真实网络下跑一遍 live test 并核对 relation**，确认不是把 HTML 页面当 OPDS 解析。

### 8.7 明确没做（与法律修正一致）

- ❌ 通用 XPath / JSONPath 规则引擎 —— **不做**
- ❌ JS 执行 —— **不做**
- ❌ 书源市场 / 榜单 —— **不做**
- ❌ 预留第三方侵权源加载点 —— **不预留**（预留本身就是帮助侵权的证据）
- ❌ 用户导入书源规则 —— **不做**（官方不提供任何规则文件）

### 8.8 契约变更（`api/openapi.yaml`）

- 新增 `GET /v1/sources` → 返回已注册书源标识（新增 `SourceList` schema）

---

## 9. M5-3 术语表服务端化 + M5-4 人名归一化一期（存事件不存结果）

### 9.1 一句话结论

术语表从「客户端本地字典」变成**服务端权威表 + 同步通道**；人名归一化一期落地了
确定性层（繁简/尊称/变音/拼音/编辑距离/并查集聚类），并把用户修正做成
**append-only 事件日志 + 重放**——自动流水线重跑不再冲掉用户的工作。

### 9.2 为什么术语表要上服务端（三个不能省的读路径）

原先术语表只在客户端内存里，随请求带 `options.glossary`。这有三个硬伤：

1. **整书翻译拿不到**。后台任务在服务端跑，客户端不在场，`options` 里的术语带不进去。
2. **换设备就丢**。用户整理了 50 个人名译名，换台电脑全没了。
3. **重跑不一致**。两次翻译用了不同的术语表，同一本书出现两套译名。

所以必须落库。但**不能只落库**——还必须进同步通道，否则设备 B 永远看不到设备 A 的改动。

### 9.3 关键设计：两套存储，一次用户动作

| 存储 | 用途 | 为什么不能用另一个 |
|---|---|---|
| `glossaries` / `glossary_terms` | 翻译热路径取全书术语 | 翻 `change_log` 到上百条再去重太慢；每块翻译前都要算 `input_hash` |
| `change_log`（`book_config` 通道） | 同步到其它设备 | 只写表则别的设备拉不到改动 |

写入时**两边都写**。顺序是先写权威表、再写同步日志——反过来若日志先成功而表写失败，
其它设备会拉到一条本地查不到的术语。

**复用 `book_config` 通道而不是新增同步实体**，entityId 形如
`glossary:<bookId>:<key>`。这样不用改 `ValidateOp` 的 UUID 豁免、merge 分发、RLS 策略、
客户端 apply —— 四处都要动，而 `book_config` 的语义（字段级 LWW 的书籍级配置）正好匹配。

> **踩到的坑（F-05 / F-06，Lead 修的）**：`book_config` 的 entityId 是任意键名而不是 UUID，
> 而 `LoadPending` 原本对所有 `book_config` 无条件走 `loadProgress`，
> 把键名绑进 `reading_progress.book_id`（uuid 列）→ SQLSTATE 22P02。
> 读路径（`loadBookConfig` 改读 `change_log`）和写路径（delete 分支
> 原与 `EntityBook` 共用、会 `UPDATE books WHERE id = $1`）两处都有。
> **教训：`Push` 循环里 `LoadPending` 是无条件调用的，所以这是「每一批 push 都 500」，
> 而且客户端把 5xx 当可重试 → 一条永远不可能成功的 op 会被无限重试。**
> 测试必须 **upsert + delete 成对覆盖**——只测 upsert 会漏掉 delete 路径。

### 9.4 来源优先级：用户确认不得被重跑覆盖

```
user_confirmed  (3)  ← 用户手工确认，重跑**不得覆盖**
llm_extracted   (2)  ← LLM 抽取，可被重跑更新
deterministic   (1)  ← 确定性规则产出，可被更新
```

用单条 SQL 的 `ON CONFLICT DO UPDATE ... WHERE` 做闸门（不是先读再判断，那有并发窗口）：

```sql
WHERE glossary_terms.source <> 'user_confirmed'
   OR EXCLUDED.source = 'user_confirmed'
```

**为什么这条比精度重要**：用户手工改了半天的译名，若被自动流水线冲掉，
用户会认为「这功能不可靠」——那是信任问题，比「译名不够准」严重得多。
但用户改自己的确认值是**允许**的（否则等于把人锁死）。

### 9.5 `glossaryVersion` 参与译文缓存键

每次术语变更 `version + 1`。术语改了而 `version` 不变 → 受影响块的 `input_hash` 不变
→ 复用旧译文 → **复用的是基于旧术语的错误译文**。宁可多一次重译，也不能漏。

### 9.6 术语表 API

| 端点 | 语义 |
|---|---|
| `GET /v1/books/{bookId}/glossary?targetLang=zh` | 读全书术语表（不存在时返回空表，不 404） |
| `PUT /v1/books/{bookId}/glossary` | 批量**合并**写入 + 批量删除 |

要点：
- **合并语义，不是替换**：只处理请求里出现的 key，未提及的保持不动。
  客户端因此可以只提交改动的那几条，不必回传整份术语表。
- **`key` 可省略，服务端从 `display` 算**。客户端不应自行实现归一化——
  那是一套有版本的规则，重复实现必然与服务端不一致，导致同一个人两条术语。
- `targetLang` **必填，不默认 zh**。猜语言会产生难以解释的行为
  （用户以为在改中文术语表，实际改了日文的）。
- `removeKeys` 与 `terms` 合并成一个请求，避免「先删后写」之间出现空窗。

### 9.7 人名归一化：确定性层（可测、可解释）

`internal/normalize` 实现 `Normalize(form) Key`，顺序固定：

```
繁转简(OpenCC t2s) → 剥变音符号 → 剥尊称 → 剥标点 → 小写+合并空格 → 拼音 key
```

`internal/normalize/cluster.go` 用并查集聚类，证据强度分级：

| 证据 | 强度 | 是否自动合并 |
|---|---|---|
| `exact`（归一 key 相同） | 3 | 是 |
| `pinyin`（拼音 key 相同，**且非空**） | 2 | 是 |
| `substring`（一个名字是另一个的子串） | 2 | 是 |
| `similarity`（Jaro-Winkler ≥ 0.80） | 1 | **否**，只作提示 |

#### 实测数据（本轮的关键依据）

| 用例 | 数值 | 结论 |
|---|---|---|
| `opencc t2s`: `伊麗莎白與達西` | → `伊丽莎白与达西` | 繁简归一有效 |
| `pinyin 伊丽莎白` / `pinyin 伊莉莎白` | 都是 `yilishabai` | **拼音是唯一能抓到这一对的方法** |
| `jaro(伊丽莎白, 伊莉莎白)` | **0.8333** | 低于常见的 0.85 阈值 |
| `jaro(郝思嘉, 斯嘉丽)` | 0.6296 | 归化译名，正确不合并 |
| `py("Darcy") == py("Elizabeth")` | 都是 `""` | **非中文拼音为空** |

#### 三个安全关键的判定

1. **拼音 key 为空时绝不合并**（`TestClusterNeverMergesDistinctEnglishNames`）。
   拼音库对非中文返回空串。若不判空，任意两个英文人名都会因为「拼音都是空」被合并——
   这是最严重的一类 bug（两个人变一个），且不报错、不会让别的测试变红。
2. **相似度阈值定 0.80 而不是 0.85**（`similarityThreshold`）。
   0.85 会漏掉 `伊丽莎白`/`伊莉莎白`（0.8333，真阳性）。
   但相似度**只作证据、不自动合并**，所以降低阈值不会带来误合并。
3. **`郝思嘉` / `斯嘉丽` 断言为「不合并」而非「合并失败」**
   （`TestClusterDoesNotMergeNaturalizedNames`）。这是 1940 年归化译本 vs 现代译名，
   纯字符串方法系统性做不到。写成「期望合并但失败」会让后人误以为实现有缺陷而去无谓调参。

#### 已知边界：多音字姓氏

实测拼音库对多音字取常见读音，姓氏读音会错：

| 姓氏 | 库返回 | 姓氏应读 |
|---|---|---|
| 曾 | `ceng` | zeng |
| 区 | `qu` | ou |
| 仇 | `chou` | qiu |
| 解 | `jie` | xie |
| 查 | `cha` | zha |
| 单 | `dan` | shan |

所以拼音 key **不能作为多音字姓氏的唯一判据**。一期如实记录为边界，不做静默处理。

### 9.8 「存事件不存结果」：重放引擎

`internal/corrections` 实现 append-only 事件日志的重放。

```
❌ 用户把 A 和 B 合并 → UPDATE 实体表
   → 下次自动流水线重跑 → 用户的工作被覆盖
✅ 用户把 A 和 B 合并 → INSERT 一条 correction 事件
   → 自动流水线重跑 → 重放所有 correction → 用户的工作保留
```

**根本理由：自动流水线的输出是可重算的，用户的输入是不可重算的。只有后者值得持久化。**
这也是「纯 LLM 一次性抽取」不可增量的根因——它没有日志层。

#### 重放顺序（固定，不可调换）

```
1. 自动聚类（auto）作为基线
2. 应用 blocked_pairs（禁止合并）
3. 应用 merge（强制合并）
4. 应用 split（强制拆分，**晚于 merge**）
5. 应用 rename / alias_add
6. 应用 lock（冻结，必须最后）
```

顺序不能乱的道理：split 必须在 merge 之后，否则「先合后拆」的用户意图会丢失；
lock 必须最后，否则会被前面的步骤改掉。

#### `seq` 而非时间戳

`book_correction.seq` 由客户端单调生成，`UNIQUE(book_id, seq)` 提供幂等。
**不用 `created_at` 排序**：时钟回拨会让重放顺序错乱，而 `seq` 不会。

#### 负样本对（防重跑回退）

`split` 的副产物写进 `book_blocked_pair`。没有这一条，用户拆完重跑又合回去——
体验是灾难性的。**负样本优先于 merge**：用户可能先拆后误操作合并，此时应尊重「拆」的意图。

### 9.9 实测证据

```
gofmt -l .                          → 无输出（clean）
go build ./...                      → 0
go vet ./...                        → 0
go test ./... -count=1              → 全部 ok（含真实 PostgreSQL）
go mod tidy                         → 干净，go.sum 无残留
```

新增测试（全部真实 DB，非 mock）：

```
internal/normalize    13 个：尊称/繁简/变音/拼音空值/同音合并/归化译名不合并/
                            英文不误合并/子串合并/单字母防护/确定性/空输入
internal/corrections  11 个：用户 merge 重跑不丢/拆分防回退/重放幂等/顺序/
                            rename/lock/alias/坏事件跳过/seq 排序
internal/store        16 个：术语表用户确认不被覆盖/version 递增/多用户隔离/
                            按目标语言隔离/负样本对/同步传播/墓碑/实体重建
internal/httpapi       4 个：鉴权/非 UUID bookId/缺 targetLang/key 派生
```

#### 最关键的三条断言（原样贴出通过状态）

```
--- PASS: TestReplayMergeKeepsUserWork                     # 用户 merge 后重跑，分组不被冲掉
--- PASS: TestRebuildEntitiesPreservesUserMergeAcrossRerun # 端到端，真实 DB
--- PASS: TestGlossaryUserConfirmedSurvivesRerun           # 用户确认的译名不被 llm_extracted 覆盖
--- PASS: TestClusterNeverMergesDistinctEnglishNames       # 空拼音不误合并（安全关键）
--- PASS: TestCorrectionsIsolatedBetweenUsers              # 多用户隔离
--- PASS: TestGlossarySyncPropagatesToOtherDevice          # 跨设备同步
```

#### 跨设备同步实测（真实栈）

设备 A `PUT /v1/books/{id}/glossary` 写入 `Mr. Darcy → 达西先生`，设备 B `GET /v1/sync/pull?cursor=0`：

```json
{"cursor":76,"entity":"book_config",
 "entityId":"glossary:4de235b9-...:darcy",
 "kind":"upsert",
 "payload":{"source":"user_confirmed","target":"达西先生","display":"Mr. Darcy"}}
```

#### 冒烟测试

```
deploy/smoke-test.sh  → PASS=95 FAIL=0（新增 6d 段 14 条断言）
```

```text
== 6d. 术语表服务端化（M5-3） ==
  PASS  读术语表（空表）= 200
  PASS  空术语表 version 为 0
  PASS  写术语 = 200
  PASS  写入后能读回译名
  PASS  key 由服务端归一得出（darcy）
  PASS  来源默认 user_confirmed
  PASS  再次写入后 version 递增（1 -> 2）
  PASS  用户确认值未被 llm_extracted 覆盖
  PASS  未登录读术语表 = 401
  PASS  非 UUID bookId = 400（不是 500）
  PASS  缺 targetLang = 400
  PASS  他人读我的术语表被拒（404）
  PASS  删除术语 = 200
  PASS  删除后术语表为空
```

### 9.10 顺带修掉的一个实现缺陷

术语表 handler 原本**先查 DB 再校验入参**。后果有两个：

1. 缺 `targetLang` 这种纯客户端错误会变成一次无谓的 DB 往返；
2. store 不可用时会返回 **500 而不是 400** —— 客户端把 5xx 当可重试，
   于是「缺参数」这个永远不会成功的请求会被无限重试。

已改成「解码 → 校验 → 查库」的顺序。这是写测试时才暴露的
（`TestGlossaryPutRequiresTargetLang` 在无 DB 的测试 Server 上直接 panic）。

### 9.11 已知边界（不掩饰）

1. **LLM 抽取人名未实现**。本轮只有确定性层（规则/拼音/编辑距离）。
   `entity_normalize` 任务仍是骨架，调用返回 `not_implemented`。
2. **归化译名合并做不到**（`郝思嘉`/`斯嘉丽`）。纯字符串方法系统性失效，
   需要外部知识（维基/译名表），属后续工作。
3. **多音字姓氏拼音不准**（见 §9.7 表）。一期记录边界，不静默处理。
4. **`book_entity` 是整体替换**（`DELETE` + 重插）。这是有意的：
   它是可重算输出，增量更新会残留旧实体导致「同一个人出现两次」。
   代价是实体数大时写入放大，但实体数通常 < 200，可接受。
5. **同步通道复用 `book_config`，未新增同步实体类型**。好处是不改客户端；
   代价是 `book_config` 的语义现在同时承载「书配置」与「术语表」，
   后续若术语表需要独立的冲突策略，需要拆出专门的实体类型。
6. **术语表未接入自动重译**。术语变了 `version` 会递增，
   但**不会自动触发重译**——那会改变成本模型，需单独设计配额策略。
7. **跨设备同步只验证了「能拉到」，未验证客户端 apply**。客户端不在本轮范围。

### 9.12 本轮改动范围

新增：
```
internal/normalize/{key.go,cluster.go,normalize_test.go}
internal/corrections/{replay.go,replay_test.go}
internal/store/{glossary.go,glossary_test.go,glossary_sync.go,glossary_sync_test.go,
                corrections.go,corrections_test.go,entities.go,entities_test.go}
internal/httpapi/{glossary.go,glossary_test.go}
internal/db/migrations/00007_glossary_and_entities.sql
```

修改：
```
internal/worker/translate.go     合并服务端术语表进 options.Glossary（服务端优先）
internal/httpapi/server.go       注册 GET/PUT /v1/books/{bookId}/glossary
api/openapi.yaml                 新增 2 path + 3 schema（31 schema / 34 $ref 全部可解析）
deploy/smoke-test.sh             新增 6d 段 14 条断言 + callfile/calljson 辅助
go.mod / go.sum                  新增 opencc / go-pinyin / smetrics
```

未动 `apps/client`、`docs`、`spikes`、`internal/sources/**`，**全程未执行 git**。

### 9.13 两个测试环境陷阱（值得记住）

#### 陷阱一：Git Bash 内联 UTF-8 会损坏

`deploy/smoke-test.sh` 在 **Git Bash（Windows）** 下运行，内联 UTF-8 中文
传给 `curl` 或写进脚本变量时会退化成 U+FFFD（实测响应里出现 `efbfbd` 序列），
导致中文断言全部假失败。

**这不是服务端问题**——同一条请求用 PowerShell 发完全正常（字节 `e8bebe...` 正确）。

解决办法：载荷与断言期望值都用 `printf %b` 加 `\x` 字节转义生成，
源码里只保留 ASCII。这样脚本文件本身的编码不再影响测试结果。

⚠️ `printf %s` **不**解析 `\x` 转义，必须用 `%b`——这一点也踩过。

#### 陷阱二：compose 的 backend 网络是 internal

`deploy/docker-compose.yml` 里 `backend` 标记 `internal: true`（postgres/redis 不对外）。
容器只连 backend 时**无法发布宿主机端口**（`docker ps` 的 Ports 为空，
`127.0.0.1:8081` 连不上）。要做宿主机直连验证必须让它同时连一个非 internal 网络
（`edge`），且必须在 `docker start` **之前** `docker network connect`，
否则启动瞬间 DNS 解析失败（`lookup postgres: no such host`）。

## 10. 真模型端到端验证（`liveai` tag，Lead 补做）

> 背景：M5-1/M5-2/M5-3 的全部测试此前都跑在 `provider=fake` 上。
> fake 能验证 SSE 链路、错误处理、取消、断点续跑，但**验证不了**三件最关键的事：
> 译文质量、上游 usage 帧的真实格式、术语表是否真被模型遵守。
> 这三件恰恰是「上线能不能用」和「账单对不对」的全部依据。

### 10.1 为什么单独加 build tag

真模型测试需要外部 API key，不能进 CI（无网/无 key 会红）。
但**不能因此就不做**——所以用 `//go:build liveai` 隔离：

```bash
HPF_LIVE_AI_BASE_URL=... HPF_LIVE_AI_KEY=... HPF_LIVE_AI_MODEL=... \
  go test -tags liveai ./internal/ai/ -run Live -v
```

已验证 `go build ./...` / `go vet ./...` / `go test ./...`（不带 tag）**完全不受影响**。

### 10.2 四条断言与实测输出

| 测试 | 断言什么 | 实测结果 |
|---|---|---|
| `TestLiveTranslateReturnsChinese` | 真的翻成中文，且不等于原文 | `凡是有钱的单身汉，总想娶位太太，这已经成了一条举世公认的真理。` |
| `TestLiveUsageFrameIsReal` | usage 通道有产出、数字合理、`source=upstream` | `input=168 output=310 source=upstream` |
| `TestLiveGlossaryIsHonored` | 术语表真的生效（模型用指定译名） | `达西先生对伊丽莎白微笑。` |
| `TestLiveReasoningTokensAreCounted` | 计费输出与可见字数的倍率 | `可见译文 31 字，计费输出 token=207` → **6.7 倍** |

### 10.3 ★ 最重要的一条发现：思考 token 让成本比「按字数估算」高一个量级

上游原始帧（直接 curl 抓的，不是我们的解析结果）：

```json
{"usage":{"prompt_tokens":62,"completion_tokens":232,"total_tokens":294,
 "completion_tokens_details":{"reasoning_tokens":210}}}
```

**232 个 completion token 里，210 个是 `reasoning_tokens`**——推理型模型把思考过程计入计费，
但**不把思考内容放进正文流**。用户为 232 个输出 token 付费，却只看到 31 个字的译文。

实测倍率：**计费输出 ≈ 可见字数的 6.7 倍**（不同文本/模型会浮动，这里只作量级参考）。

#### 这对我们意味着什么

1. **`EstimateTokens` 的本地估算会系统性低估输出成本**——它按可见文本算，看不到思考 token。
   所以 `usage_source=estimated` 时给出的成本数字**必须视为下界**，不能当账单依据。
2. **配额换算要按实测倍率校准**，不能按「译文字数」拍脑袋。
   之前规划里「5,000,000 token ≈ 10 整书」这个换算**需要按真模型实测重算**（见 §10.4）。
3. **选模型时「推理型 vs 非推理型」是成本分水岭**，不是参数细节。
   若整书翻译用推理模型，成本可能高一个量级；是否值得要按译文质量实测决定。

### 10.4 待办（明确未做，不要当成已完成）

- **整书真实成本未测**：本轮只测了单句/短段。要得出「一本书多少钱」，
  需要用真模型跑完一本真书（24 章约 3000 字/章），并核对 `ai_usage` 累加与上游账单。
- **未验证 `estimated` 与 `upstream` 的偏差幅度**：需要在拿不到 usage 帧时（如上游不返回）
  对比同一文本的估算值与真实值，得出修正系数。
- **未测非推理型模型做对比**：无法回答「用便宜的非推理模型是否够好」。

### 10.5 环境备注

真模型验证用的是本机可访问的 magpie 网关（OpenAI 兼容，`/v1`）。
配置通过 `HPF_AI_PROVIDER=openai` + `HPF_AI_BASE_URL` + `HPF_AI_API_KEY` 接入，
**没有硬编码任何 key 到仓库**（测试只从环境变量读，未设置则 skip）。
