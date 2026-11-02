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
