# 使用内置 BuildKit 前端（不声明 # syntax=...，避免构建时额外拉取 dockerfile 前端镜像）
#
# 多阶段构建：
#   builder  -> 静态编译（CGO_ENABLED=0），把迁移文件内嵌进二进制
#   runtime  -> distroless static + nonroot，最小攻击面
#
# 构建（仓库根目录或 apps/server 下均可）：
#   docker build -f apps/server/Dockerfile -t hpf-reader-api:dev apps/server

FROM golang:1.26-alpine AS builder

# Go 模块代理：国内构建可通过 --build-arg GOPROXY=... 覆盖
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=$GOPROXY GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux

WORKDIR /src

# 先只复制依赖清单，最大化利用层缓存
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# -trimpath 去掉构建机路径；-s -w 去掉符号表；版本号注入 main.version
ARG VERSION=dev
RUN go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/api ./cmd/api \
 && go build -trimpath -ldflags "-s -w" -o /out/migrate ./cmd/migrate

# 迁移 SQL 同时复制一份到镜像里，方便用外部工具（psql / goose）单独执行
RUN mkdir -p /out/migrations && cp internal/db/migrations/*.sql /out/migrations/

# 书籍文件目录必须属于运行用户（uid 65532）。
# 关键点：Docker 为「命名卷」初始化内容时会保留镜像里该目录的属主，
# 因此在镜像里先建好并 chown，命名卷挂上去就是可写的；否则 nonroot 进程 mkdir 会 EACCES。
RUN mkdir -p /out/files && chown -R 65532:65532 /out/files

FROM gcr.io/distroless/static-debian12:nonroot AS runtime

ARG VERSION=dev
LABEL org.opencontainers.image.title="hpf-reader-api" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.description="HPF-Reader 自托管服务端（Go）"

WORKDIR /app

COPY --from=builder /out/api /app/api
COPY --from=builder /out/migrate /app/migrate
COPY --from=builder /out/migrations /app/migrations

# 书籍文件落地目录（生产应挂卷或用对象存储）
# 用 --chown 复制，保证命名卷初始化后属主正确；bind mount 时需在宿主机 chown 65532。
COPY --from=builder --chown=65532:65532 /out/files /data/files
VOLUME ["/data/files"]

ENV HPF_ADDR=:8080 \
    HPF_ENV=prod \
    HPF_STORAGE_DIR=/data/files \
    HPF_LOG_FORMAT=json \
    HPF_AUTO_MIGRATE=true

EXPOSE 8080

# distroless 没有 shell/curl，因此健康检查直接用二进制自带的 healthcheck 子命令。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/app/api", "healthcheck", "--url", "http://127.0.0.1:8080/healthz"]

# distroless:nonroot 已经是非 root（uid 65532），这里显式声明便于审计
USER nonroot:nonroot

ENTRYPOINT ["/app/api"]