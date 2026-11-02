# HPF-Reader 部署（Docker Compose）

一条命令起服务：**api + postgres16(+pgvector) + redis7 + minio + caddy**。

## 快速开始

```bash
cd deploy
cp .env.example .env

# 必改：所有 change-me（尤其 HPF_JWT_SECRET / POSTGRES_PASSWORD / MINIO_ROOT_PASSWORD）
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
| minio | 9000 / 9001（仅 127.0.0.1） | 控制台仅本机可访问 |

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

- [ ] `.env` 里的 change-me 已全部替换为随机值
- [ ] `HPF_DOMAIN` 指向真实域名且 80/443 可达（否则 Caddy 签不出证书）
- [ ] 公网只暴露 80/443；postgres/redis/minio 保持 internal 网络
- [ ] `/metrics` 与 `/healthz` 已限制为内网访问：用**公网来源**验证返回 403（从 Docker 网络内部访问会按设计放行，属正常）
- [ ] 已配置备份任务，并完成一次恢复演练