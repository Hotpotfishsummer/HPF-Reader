-- +goose Up
-- M5-1 成本与配额闸门。
--
-- 背景（真实缺陷，非假想需求）：
--   * ai_usage 表从建库起从未被 INSERT，成本完全不可观测；
--   * users.quota_ai_calls 只被读进结构体，从未参与任何比较；
--   * 后果：拿到账号即可无限刷 LLM，账单直接失控。
--
-- 配额为什么是**双维度**（按调用次数 + 按 token 额度）：
--   划词翻译一次约 2000 字，成本几厘钱；整书翻译一次约 28 万输入 + 20 万输出 token，
--   按 DeepSeek flash 官方价约 1~2 元。两者都算「1 次调用」，只按次数计费会严重失真
--   （1000 次/月的默认配额若被刷满整书任务 = 2000 元/用户/月）。
--   因此：调用次数防高频小请求刷爆 QPS 与账单，token 额度防单次大任务烧钱，任一超限即拒绝。
--
-- 周期语义：**自然月（UTC 边界）**。选 UTC 而不是服务器本地时区，是为了多副本/多区域部署时
--   所有实例对「本月」的判定完全一致，不会出现两台机器各算各的账。
--   周期起点存成列（ai_period_start）而不是每次现算，是为了让「跨月重置」与「累加」能在同一条
--   UPDATE 里原子完成（见 internal/store/quota.go）。

-- 周期起点函数：UTC 自然月的第一天 00:00:00。
-- 函数名用 ai_period_for 而不是 ai_period_start，是为了不与 users.ai_period_start 列重名——
-- 列名与函数名相同时，`ai_period_start(now())` 这种调用在 PostgreSQL 里会产生解析歧义。
-- 独立成函数而不是把表达式抄进每条 SQL，是因为它要出现在 UPDATE 的 SET、WHERE 与诊断查询三处，
-- 抄三遍必然会在某次改动后漂移，而漂移会导致「判定用旧周期、累加用新周期」这种最难查的账目错误。
CREATE OR REPLACE FUNCTION ai_period_for(p_now TIMESTAMPTZ) RETURNS TIMESTAMPTZ AS $$
    SELECT date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$ LANGUAGE sql STABLE;

-- ---------- ai_usage：补齐记账所需的列 ----------
ALTER TABLE ai_usage
    ADD COLUMN IF NOT EXISTS usage_source TEXT NOT NULL DEFAULT 'estimated',
    ADD COLUMN IF NOT EXISTS outcome      TEXT NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS error        TEXT,
    ADD COLUMN IF NOT EXISTS request_id   TEXT;

-- usage_source 存在的意义是「不要假装精确」：
--   upstream  = 上游真的回了 usage（请求体带了 stream_options.include_usage）；
--   estimated = 上游没回，用本地粗估（中文约 1.5 字/token，英文约 4 字符/token）。
-- 两者在成本分析里可信度完全不同，混为一谈会让「按 usage 计费」的结论站不住脚。
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_usage_source_check
    CHECK (usage_source IN ('upstream', 'estimated'));

-- 失败调用**也要记账**：调用已经发出去了，上游可能已经计费，不记就是账目缺口。
-- canceled = 客户端中途断开（上游被取消，但已生成的部分仍可能计费）。
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_outcome_check
    CHECK (outcome IN ('ok', 'failed', 'canceled'));

CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx ON ai_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_feature_idx ON ai_usage(feature, created_at DESC);

-- ---------- users：配额额度与周期内已用量 ----------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS quota_ai_tokens BIGINT NOT NULL DEFAULT 5000000,
    ADD COLUMN IF NOT EXISTS ai_calls_used   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ai_tokens_used  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ai_period_start TIMESTAMPTZ NOT NULL
        DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

-- 默认 500 万 token/月 的由来：
--   一本 30 万字的整书翻译约 48 万 token（28 万输入 + 20 万输出）；
--   500 万 ≈ 每月 10 本书的整书翻译，或数千次划词翻译。
--   按 flash 空闲价折合约 10~20 元/用户/月，是自托管场景下可以接受的免费额度上限。
--   ⚠️ 这是量级判断，不是成本承诺；上线后要用真实账单校准（见 docs/M5-PLAN.md §8）。

-- 默认 1000 次/月 沿用 00001_init.sql 的 quota_ai_calls 默认值，不重复改动。

-- 已用量列**不允许**为负（结算时的退款路径由 GREATEST(0, ...) 兜底，这里再加一道约束）。
ALTER TABLE users ADD CONSTRAINT users_ai_usage_nonneg_check
    CHECK (ai_calls_used >= 0 AND ai_tokens_used >= 0);

-- ---------- 既有用户的周期起点对齐 ----------
-- ADD COLUMN 带 DEFAULT 会回填既有行，但回填用的是**当时的 now()**；
-- 若这次迁移正好在月初的毫秒间隙执行，值可能落在上个月。这里显式归一化一次，
-- 保证迁移后每个用户的周期起点都精确等于 UTC 月首。
UPDATE users SET ai_period_start = ai_period_for(now())
 WHERE ai_period_start <> ai_period_for(now());

-- +goose Down
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ai_usage_nonneg_check;
ALTER TABLE users
    DROP COLUMN IF EXISTS ai_period_start,
    DROP COLUMN IF EXISTS ai_tokens_used,
    DROP COLUMN IF EXISTS ai_calls_used,
    DROP COLUMN IF EXISTS quota_ai_tokens;

DROP INDEX IF EXISTS ai_usage_feature_idx;
DROP INDEX IF EXISTS ai_usage_user_created_idx;
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_outcome_check;
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_usage_source_check;
ALTER TABLE ai_usage
    DROP COLUMN IF EXISTS request_id,
    DROP COLUMN IF EXISTS error,
    DROP COLUMN IF EXISTS outcome,
    DROP COLUMN IF EXISTS usage_source;

DROP FUNCTION IF EXISTS ai_period_for(TIMESTAMPTZ);