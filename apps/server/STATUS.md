# apps/server STATUS — HPF-Reader 服务端

> 交付人：server-dev（task-8）｜接口契约：`api/openapi.yaml`（只读，未修改）
> DDL / 同步设计参考 docs/TECH-PLAN.md §4.2、§4.3
> 结论：**编译、单测、迁移、起服务、端到端 push/pull 全部实测通过**。

## 0. 验证证据（都是实际执行结果）

```
go build ./...   → exit=0
go vet ./...     → exit=0
go test ./... -count=1
  ok  internal/auth      0.152s      # argon2id / JWT / refresh 轮换 / 限流
  ok  internal/config    0.114s      # 默认值 / prod 强制密钥 / 枚举校验
  ok  internal/httpapi   1.062s      # 探针 / 401 / 限流 / CORS / 指标文本
  ok  internal/sources   0.969s      # gutendex 解析 / SSRF 白名单 / 超时
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
