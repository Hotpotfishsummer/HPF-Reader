# HPF-Reader 生产部署：kr-server

**实际拓扑（已上线验证）**

```
客户端 (Wails/WebView2)
   │  Go 侧中继严格 TLS（系统根证书 + 主机名校验）
   ▼
library.coldpotfish.lat  ← Cloudflare 橙云（WAF/限流）
   │  HTTPS Full(strict)
   ▼
47.80.61.154:443  宿主机 Caddy 2.11.7（Let's Encrypt 证书，非容器）
   │  仅放行 Cloudflare 边缘网段；其余 403
   │  X-Forwarded-For 用 CF-Connecting-IP 重建
   ▼
127.0.0.1:8080    api 容器（distroless, nonroot, 只读根文件系统）
   │
   ▼
postgres 容器（pgvector/pg16，不发布端口）
```

| 项 | 值 |
|---|---|
| 主机 | kr-server，Debian 12，1.6G RAM + 1G swap，40G 磁盘 |
| Docker | 29.9.3 + compose v5.7.1（镜像加速：daocloud/dockerproxy） |
| 数据卷 | `hpf-reader_pgdata`、`hpf-reader_bookfiles` |
| 备份 | root cron 每日 03:17，`/home/admin/hpf/backup/`，保留 7 天 |

## 文件布局（服务器上）

```
/home/admin/hpf/
├── compose.kr.yml        # 本目录同名文件
├── .env                  # 仅 POSTGRES_USER/PASSWORD/DB、HPF_VERSION（600）
├── etc/hpf.env           # 全部 HPF_* 运行配置含密钥（600，不进 git）
├── app/                  # apps/server 源码（镜像构建上下文）
├── backup.sh             # 每日备份
└── backup/               # dump + tgz
```

## 日常运维

```bash
cd /home/admin/hpf
sudo docker compose -f compose.kr.yml ps
sudo docker compose -f compose.kr.yml logs -f api
sudo docker compose -f compose.kr.yml restart api

# 升级（代码改完后）
rsync -av --exclude data --exclude evidence ./apps/server/ kr:/home/admin/hpf/app/
ssh kr 'cd /home/admin/hpf && sudo docker compose -f compose.kr.yml up -d --build'
```

## 创建账号（唯一入口）

本产品**不提供公开注册**：服务端连 `POST /v1/auth/register` 路由都不注册，
客户端只有登录入口。账号只能在这台服务器上用离线子命令创建。

```bash
# 口令从 stdin 读，不进 shell 历史 / ps / docker inspect
ssh kr "cd /home/admin/hpf && sudo docker compose -f compose.kr.yml exec -T api \
  /app/api createuser --email you@example.com --name 'Owner' --password-stdin"
```

> 没有「临时开放注册」这条路径 —— 没有开关可开。这既是安全设计，也省掉了
> 「注册完忘了关」这类事故：公网扫描器发现注册端点后几分钟内就能批量建号，
> 直接烧掉 AI 与存储额度。

## Caddy 配置

站点片段在 `/etc/caddy/conf.d/library.caddy`，由主 `Caddyfile` 末尾的 `import conf.d/*` 引入。

关键点（每一条都有对应的攻击面）：

| 配置 | 防的是什么 |
|---|---|
| `@fromCF remote_ip <CF 网段>` | 攻击者绕过 CF 直连源站 IP，跳过 WAF 与限流 |
| `handle @fromCF { ... }` / `handle { respond 403 }` | 非 CF 来源一律拒绝 |
| `header_up X-Forwarded-For {CF-Connecting-IP}` | 用可信来源**重建** XFF，丢弃客户端伪造值 |
| `flush_interval -1` | SSE（`/v1/ai/translate`）不被缓冲 |
| `import tlsopt`（HTTP-01） | 橙云下 TLS-ALPN 不可用 |

改完必须 `sudo caddy validate --config /etc/caddy/Caddyfile` 再 `systemctl reload caddy`。

## 已验证的安全性质（2026-11-12 实测）

| 检查 | 结果 |
|---|---|
| 非 CF 直连源站 443 | **403** |
| 伪造 `X-Forwarded-For` 爆破 | 仍然 **429**（限流未被绕过） |
| `/metrics` 公网 | **404**（`HPF_METRICS_ENABLED=false`） |
| 未认证 `/v1/books` | **401** |
| 注册接口 | **403** `registration is disabled` |
| 连续错误登录 | 第 8 次 **429** |
| 安全响应头 | HSTS / nosniff / X-Frame-Options / Referrer-Policy 全部存在 |
| refresh token 轮换重用 | **401** `already used; session revoked` |
| 改密（错误当前口令） | **401** |
| 改密（正确当前口令） | **204**，旧口令失效、全部会话吊销 |

## 内存预算（1.6G 机器，务必注意）

| 组件 | 上限 | 实测 |
|---|---|---|
| postgres 容器 | 512m | ~54MiB |
| api 容器 | 640m | ~153MiB |
| Caddy（宿主机） | — | ~87MiB |
| 其它共存服务 | — | ~400MiB |

`HPF_HASH_CONCURRENCY=3` 限制并发 Argon2（每次 64MiB）。**提高注册/登录并发前先加内存**，
否则 3 个并发哈希就会吃掉近 200MiB。

## 已知取舍与残留风险

1. **无 Redis**：`HPF_QUEUE_DRIVER=none`，AI 任务走 Postgres 表队列。单实例足够；多副本再上 asynq。
2. **全站 AI 预算非严格串行**：`SUM(users.ai_calls_used)` 无行锁，N 个并发可能同时通过，
   超额幅度约等于并发数。要严格需单行计数 + `SELECT FOR UPDATE`（引入单点锁），刻意没做。
3. **access token 无法逐个吊销**：不落库，改密后旧 access token 仍有效至多 15 分钟。
4. **`--disable-web-security` 仍在客户端**：只放宽渲染层同源策略，不改变证书校验；
   API token 已不经过 Chromium TLS，但内置浏览器页面的跨源隔离仍失效。
5. **源站 IP 可推断**：橙云不隐藏源站（证书透明日志/历史 DNS）。真正的边界是 Caddy 的 CF 白名单。
6. **Cloudflare SSL 模式**：当前源站有 Let's Encrypt 证书，模式为 Full(strict) 即可；
   若改成 Flexible 会退化为明文回源。
