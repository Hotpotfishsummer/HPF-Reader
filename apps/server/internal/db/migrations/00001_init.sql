-- +goose Up
-- HPF-Reader 初始 schema。DDL 参考 docs/TECH-PLAN.md §4.2。
-- 约定：
--   * 所有 id 由应用层生成（UUID v4 字符串），数据库不再依赖 uuid-ossp；
--   * 时间统一 TIMESTAMPTZ，服务端时间为权威；
--   * change_log.seq 使用 BIGINT GENERATED ALWAYS AS IDENTITY —— 这是客户端唯一可信游标。

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    email         CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,               -- argon2id PHC 字符串
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
    status        TEXT NOT NULL DEFAULT 'active', -- active | locked | disabled
    quota_bytes   BIGINT NOT NULL DEFAULT 5368709120,
    quota_ai_calls INTEGER NOT NULL DEFAULT 1000,
    -- 登录失败锁定：连续失败达到阈值后锁定到指定时间
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT,
    platform     TEXT,          -- web|windows|macos|linux|android|ios
    app_version  TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices(user_id, last_seen_at DESC);

-- refresh token 家族：轮换 + 重用检测（重用时吊销整个家族）
CREATE TABLE refresh_tokens (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    UUID REFERENCES devices(id) ON DELETE SET NULL,
    family_id    UUID NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,   -- sha256(token)，明文不落库
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,            -- 被消费的时间点（轮换）
    revoked_at   TIMESTAMPTZ,
    replaced_by  UUID,
    user_agent   TEXT
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

CREATE TABLE books (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    author      TEXT,
    series      TEXT,
    language    TEXT,
    format      TEXT NOT NULL DEFAULT 'epub',
    file_hash   TEXT,          -- sha256（可能尚未上传文件）
    file_size   BIGINT NOT NULL DEFAULT 0,
    storage_key TEXT,          -- 对象存储 key；本地目录实现下是相对路径
    cover_key   TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    reading_state TEXT NOT NULL DEFAULT 'unread',  -- unread|reading|finished|archived
    rating      INTEGER,
    -- 副本令牌：重新导入同一本书时分配新值，避免「重新下载后回到旧位置」
    reincarnation UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);
-- 同一用户同一文件只允许一条有效记录（秒传 / 去重的基础）
CREATE UNIQUE INDEX books_user_hash_idx ON books(user_id, file_hash)
    WHERE deleted_at IS NULL AND file_hash IS NOT NULL;
CREATE INDEX books_user_created_idx ON books(user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX books_user_updated_idx ON books(user_id, updated_at ASC, id ASC) WHERE deleted_at IS NULL;

-- 书籍文件实体：按 contentHash 跨书去重（同用户内共享一份字节）
CREATE TABLE book_files (
    content_hash TEXT PRIMARY KEY,          -- sha256 hex
    size_bytes   BIGINT NOT NULL,
    storage_key  TEXT NOT NULL,             -- 本地目录相对路径或 S3 key
    ref_count    INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 阅读进度：每用户每书一行 = 服务端已确认的最后值
CREATE TABLE reading_progress (
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id              UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    locator              JSONB NOT NULL,
    total_progression    REAL NOT NULL DEFAULT 0,
    furthest_locator     JSONB,
    furthest_progression REAL NOT NULL DEFAULT 0,
    explicit_rewind      BOOLEAN NOT NULL DEFAULT false,
    content_hash         TEXT,               -- 该进度对应的副本（跨副本比较的前提）
    hlc                  TEXT NOT NULL,
    device_id            UUID,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, book_id)
);
CREATE INDEX reading_progress_recent_idx ON reading_progress(user_id, updated_at DESC);

CREATE TABLE annotations (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,          -- highlight|underline|note|bookmark
    locator    JSONB NOT NULL,
    color      TEXT,
    text       TEXT,
    note       TEXT,
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 合并后的完整载荷（客户端直接 apply）
    hlc        TEXT,
    device_id  UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX annotations_book_idx ON annotations(user_id, book_id, updated_at);
CREATE INDEX annotations_user_idx ON annotations(user_id, updated_at);

-- 同步日志（核心）：append-only，seq 就是客户端游标。
-- 必须有 identity 自增：绝不能用客户端 updated_at 当游标（服务端合并过的行没有新的客户端时间，
-- 其它设备就永远拉不到这次合并结果）。
CREATE TABLE change_log (
    seq       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity    TEXT NOT NULL,          -- book|progress|annotation|book_config
    entity_id TEXT NOT NULL,
    book_id   UUID,
    op        TEXT NOT NULL,          -- upsert|delete
    payload   JSONB,
    hlc       TEXT NOT NULL,
    device_id UUID,
    op_id     UUID,
    server_ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX change_log_user_seq_idx ON change_log(user_id, seq);
CREATE INDEX change_log_op_id_idx ON change_log(op_id) WHERE op_id IS NOT NULL;

-- 幂等去重（保留 7 天，覆盖最长离线窗口）
CREATE TABLE sync_idempotency (
    op_id      UUID NOT NULL,
    user_id    UUID NOT NULL,
    device_id  UUID,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    result     JSONB,
    PRIMARY KEY (user_id, op_id)
);
CREATE INDEX sync_idem_expire_idx ON sync_idempotency(applied_at);

-- 书源（内置 + 用户自配；只存声明式规则，不执行任意脚本）
CREATE TABLE book_sources (
    id         UUID PRIMARY KEY,
    user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'builtin',  -- builtin|user
    rules      JSONB NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX book_sources_builtin_idx ON book_sources(name) WHERE user_id IS NULL;

-- AI 后台任务（整书翻译 / 实体归一化 / 摘要）。worker 逐条消费，用 FOR UPDATE SKIP LOCKED 抢占。
CREATE TABLE ai_jobs (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     UUID REFERENCES books(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,        -- entity_normalize|book_translate|summarize
    status      TEXT NOT NULL DEFAULT 'queued', -- queued|running|succeeded|failed|canceled
    progress    REAL NOT NULL DEFAULT 0,
    options     JSONB NOT NULL DEFAULT '{}'::jsonb,
    result      JSONB,
    error       TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    locked_at   TIMESTAMPTZ,
    locked_by   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_jobs_pending_idx ON ai_jobs(status, created_at) WHERE status IN ('queued','running');
CREATE INDEX ai_jobs_user_idx ON ai_jobs(user_id, created_at DESC);

CREATE TABLE ai_usage (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature       TEXT NOT NULL,
    model         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_cents    INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    UUID,
    action     TEXT NOT NULL,
    target     TEXT,
    ip         TEXT,
    ua         TEXT,
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS ai_usage;
DROP TABLE IF EXISTS ai_jobs;
DROP TABLE IF EXISTS book_sources;
DROP TABLE IF EXISTS sync_idempotency;
DROP TABLE IF EXISTS change_log;
DROP TABLE IF EXISTS annotations;
DROP TABLE IF EXISTS reading_progress;
DROP TABLE IF EXISTS book_files;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS users;
