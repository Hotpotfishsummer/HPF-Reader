# HPF-Reader 部署（Docker Compose）

一条命令起服务：**api + postgres16(+pgvector) + redis7 + caddy**（MinIO 为可选 profile，默认不启动）。

> 存储默认是**本地文件系统**（`HPF_STORAGE_DRIVER=local`，书存在 `bookfiles` 卷），**没有对象存储也能完整运行**。
> 需要 S3/MinIO 时：`docker compose --profile minio up -d`。

## 快速开始

```bash
cd deploy
cp .env.example .env

# 必改：所有 CHANGE_ME_*（尤其 HPF_JWT_SECRET / POSTGRES_PASSWORD；MINIO_* 仅启用 minio profile 时需要）
#   openssl rand -base64 32
# 也把 HPF_DOMAIN 改成你的域名；本地调试可填 localhost
${EDITOR:-vi} .env

docker compose up -d
docker compose ps
curl -sS http://127.0.0.1/healthz      # 经 Caddy
docker compose logs -f api
```

首次启动顺序由 healthcheck 保证：postgres 就绪 → migrate/api 起来 → api 健康 → caddy 才开始转发。
api 启动时会自动执行迁移（`HPF_AUTO_MIGRATE=true`）；也可以单独跑：

```bash
docker compose run --rm migrate            # 执行迁移
docker compose run --rm migrate -status    # 只查看已应用记录
```

## 冒烟验证

```bash
# 69 项断言的端到端冒烟（推荐先跑这个，任何一条不符即非 0 退出）
docker run --rm --network hpf-reader_edge \
  -v "$PWD/smoke-test.sh:/smoke.sh:ro" alpine:3.20 \
  sh -c "apk add --no-cache curl >/dev/null && sh /smoke.sh"
```

手动逐条验证：

```bash
# 1) 注册（返回 accessToken / refreshToken）
curl -sS -X POST http://127.0.0.1/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"supersecret1","displayName":"Me"}'

# 2) 创建一本书
curl -sS -X POST http://127.0.0.1/v1/books \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Pride and Prejudice","format":"epub"}'

# 3) 推送一次进度（把 $TOKEN / $BOOK_ID 换成上面的返回值）
curl -sS -X POST http://127.0.0.1/v1/sync/push \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"deviceId":"11111111-1111-4111-8111-111111111111","ops":[{"opId":"22222222-2222-4222-8222-222222222222","entity":"progress","entityId":"BOOK_ID","kind":"upsert","hlc":"00192a3f4c1b0-0000000a-7f3c9d21","payload":{"locator":{"href":"c1.xhtml","type":"application/xhtml+xml"},"totalProgression":0.42}}]}'

# 4) 拉取（cursor 用上一步返回的 cursor）
curl -sS "http://127.0.0.1/v1/sync/pull?cursor=0&limit=50" -H "Authorization: Bearer $TOKEN"
```

## 端口

| 服务 | 端口 | 说明 |
|---|---|---|
| Caddy | 80 / 443 | 唯一对外入口，自动 HTTPS |
| api | 8080（仅内网） | 不发布到宿主机 |
| postgres | 5432（仅内网） | `backend` 网络是 internal |
| redis | 6379（仅内网） | 队列预留 |
| minio（可选） | 9000 / 9001（仅 127.0.0.1） | 仅在 `--profile minio` 时启动；HPF 默认不用它 |

本地调试需要直连 api 时，在 `docker-compose.yml` 的 api 服务下临时加 `ports: ["127.0.0.1:8080:8080"]`。

## 卷属主（很关键）

api 以 **非 root（uid 65532）** 运行。命名卷会继承镜像里 `/data/files` 的属主（Dockerfile 已 chown），所以 `bookfiles` 卷开箱即用。
若改用 **bind mount**（例如 `- ./data/files:/data/files`），必须先：

```bash
mkdir -p ./data/files && sudo chown -R 65532:65532 ./data/files
```

否则服务会在启动阶段明确失败（`storage root ... is not writable`），而不是等到用户上传时才 500。

## 数据卷

| 卷 | 内容 | 是否必须备份 |
|---|---|---|
| `pgdata` | 用户 / 书库 / 进度 / 标注 / change_log | **是（核心）** |
| `bookfiles` | 书籍文件（本地目录驱动） | **是（与库同源，缺一不可）** |
| `miniodata` | 对象存储（S3 驱动启用后） | 启用后必须 |
| `caddydata` | TLS 证书与 ACME 账号 | 建议（可重建，但会重新签证书） |
| `redisdata` | 队列 / 缓存 | 否 |
| `staticweb` | 前端静态产物 | 否（可从 CI 重新构建） |

## 备份策略（必须做，不是可选）

保留策略：**日备 7 份、周备 4 份、月备 6 份**，并且**每季度做一次恢复演练**（没演练过的备份等于没有备份）。

```bash
# PostgreSQL：逻辑备份（PITR 需另配 WAL 归档）
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > backup/db-$(date +%F).dump

# 书籍文件：直接备份卷（内容按 sha256 寻址，天然可增量去重）
docker run --rm -v hpf-reader_bookfiles:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/files-$(date +%F).tar.gz -C /data .

# 恢复（务必先在演练环境跑通）
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup/db-2026-11-02.dump
```

要点：

1. **数据库与文件必须落在同一个备份时间点**。文件按 `sha256` 去重，库里只存 hash → key 映射；只备份其中一个会得到“有记录没内容”的坏状态。
2. 备份要**加密后异地存放**（`restic`/`rclone` 均可）：卷里既有用户书籍也有阅读进度，属于个人数据。
3. `change_log` 会持续增长。它是增量同步的权威来源，按用户游标查询；**不要手工删除**（清理走墓碑 + 客户端 snapshot 兜底）。
4. 迁移是**只进不退**的：升级前先备份，回滚镜像不等于回滚 schema。

## 常见运维操作

```bash
docker compose logs -f api           # 结构化 JSON 日志
docker compose restart api           # 重启 API（不影响数据库）
docker compose down                  # 停止（保留卷）
docker compose down -v               # 危险：连数据卷一起删除
docker compose build --no-cache api  # 重建镜像
```

## 安全清单

- [ ] `.env` 里的 `CHANGE_ME_*` 已全部替换为随机值（`grep CHANGE_ME .env` 应为空）
- [ ] `HPF_DOMAIN` 指向真实域名且 80/443 可达（否则 Caddy 签不出证书）
- [ ] 公网只暴露 80/443；postgres/redis/minio 保持 internal 网络
- [ ] `/metrics` 与 `/healthz` 已限制为内网访问：用**公网来源**验证返回 403（从 Docker 网络内部访问会按设计放行，属正常）
- [ ] 已配置备份任务，并完成一次恢复演练
---

## 部署到 kr-server（用户的服务器）

目标环境（用户已确认）：**kr-server**，通过本地 SSH 访问；**没有对象存储**；部署是最后一步。

### 前置：服务器上需要什么

| 项 | 要求 | 说明 |
|---|---|---|
| Docker Engine | 24+ | 带 compose v2 插件 |
| 端口 | 80 / 443 可入 | Caddy 自动签 TLS 用 |
| 资源 | 建议 ≥ 2C4G / ≥ 20G 可用磁盘 | postgres + api + caddy 的实际占用很小；`pgdata` 与 `bookfiles` 会随书增长 |
| 对象存储 | **不需要** | 默认 `HPF_STORAGE_DRIVER=local` |

### 步骤

```bash
# 1) 把仓库同步到服务器（任选其一）
rsync -av --exclude node_modules --exclude .git ./ kr-server:~/hpf-reader/
#   或  git clone <你的远端> ~/hpf-reader

# 2) 准备 .env（在服务器上编辑，不要在本地提交）
cd ~/hpf-reader/deploy
cp .env.example .env
grep CHANGE_ME .env            # 必须为空，否则继续改
#   HPF_DOMAIN=你的域名   ACME_EMAIL=你的邮箱
#   HPF_JWT_SECRET / POSTGRES_PASSWORD 用 openssl rand -base64 32 生成
#   HPF_ENV=prod，HPF_REGISTER_OPEN 视需要关闭

# 3) 起栈（首次会构建 api 镜像）
docker compose up -d --build
docker compose run --rm migrate       # api 也会自动迁移，这一步用于单独确认

# 4) 验证
curl -sS https://$HPF_DOMAIN/healthz    # {"status":"ok"}
curl -sS https://$HPF_DOMAIN/readyz     # 应真 ping 数据库
docker compose ps                       # 全部 healthy
```

### 首次部署后立刻要做的两件事

1. **改默认域名与邮箱**：`HPF_DOMAIN` 不对，Caddy 会反复重试签证书并可能触发 Let\'s Encrypt 限流。
2. **验证注册开关**：`HPF_REGISTER_OPEN=true` 时任何人都能注册。公网部署建议先设 `false`，用第一次注册的管理员账号，再决定是否开放。

### 无对象存储的注意事项

- 书籍文件存在 `bookfiles` 卷：**它和 `pgdata` 必须一起备份**（库里只存 sha256 → key 映射，缺一个就是坏状态）。
- 单机磁盘就是容量上限。磁盘将满时最稳妥的做法是扩容卷，而不是把老书删掉（进度记录会指向不存在的文件）。
- 迁移到 S3/MinIO 是**后续里程碑**：服务端的 S3 driver 尚未实现（设 `HPF_STORAGE_DRIVER=s3` 会启动即报错），所以现在不要启用 `--profile minio` 后就去改 driver。
