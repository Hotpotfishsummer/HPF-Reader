-- +goose Up
-- +goose StatementBegin

-- ---------- M5-3 术语表服务端化 ----------
--
-- 为什么需要独立表（而不是只靠 change_log）：
--
--   1. **翻译时要一次性取全书术语**。翻 change_log 到上百条再去重太慢，
--      而翻译是热路径（每块前都要拿术语表算 input_hash）。
--   2. **需要按 key 反查**（用户手动确认某个写法时）。
--   3. **需要记来源**（user_confirmed / llm_extracted / deterministic）。
--   4. **需要 version 作译文缓存键**：术语变了，受影响块的 input_hash 必须变。
--
-- 所以：本表存**权威值**，任何写入同时写 change_log（同步通道）。
-- 两者不是重复存储：本表为「读」优化，change_log 为「同步」服务。
CREATE TABLE glossaries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    book_id     UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    target_lang TEXT NOT NULL,
    -- version 每次术语变更 +1。它参与译文的 input_hash：
    -- 术语改了，旧译文就是错的，必须重译。
    version     BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 一个用户一本书一种目标语言，只有一份术语表。
CREATE UNIQUE INDEX glossaries_user_book_lang_idx
    ON glossaries(user_id, book_id, target_lang);

CREATE TABLE glossary_terms (
    glossary_id UUID NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
    -- key 是归一化后的原文键（如 'darcy'），由 internal/normalize 计算。
    -- 用归一 key 而不是原始写法做主键：同一人的多种写法必须落在同一行，
    -- 否则「Mr. Darcy」和「Darcy」会变成两条术语，译文一致性就无从谈起。
    key         TEXT NOT NULL,
    -- display 是展示用原文写法（保留大小写与尊称），给人看。
    display     TEXT NOT NULL,
    -- target 是标准译名。
    target      TEXT NOT NULL,
    -- aliases 是别名集合。
    --
    -- 用数组而不是子表：别名数量很少（通常 <5），读的时候总是整组读，
    -- 数组省一次 join。这是取舍不是教条——若以后要「按别名反查」，
    -- 再加 GIN 索引即可。
    aliases     TEXT[] NOT NULL DEFAULT '{}',
    -- source 标记术语来源，决定优先级：
    --   user_confirmed  用户手工确认，**重跑不得覆盖**
    --   llm_extracted   LLM 抽取，可被重跑更新
    --   deterministic   确定性规则产出（如繁简归一），可被更新
    source      TEXT NOT NULL DEFAULT 'deterministic',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (glossary_id, key)
);

ALTER TABLE glossary_terms ADD CONSTRAINT glossary_terms_source_check
    CHECK (source IN ('user_confirmed', 'llm_extracted', 'deterministic'));

-- 按 key 反查（用户手动确认单个写法时用）。
CREATE INDEX glossary_terms_glossary_idx ON glossary_terms(glossary_id);

-- ---------- 人名归一化（M5-4 一期）----------
--
-- book_entity 存**自动流水线的可重算输出**，不是权威数据。
-- 权威数据是 book_correction 的修正日志（用户意图）。
--
-- 区分这两者很重要：book_entity 每次重跑都可以整表重建，
-- 而用户修正永远不会因为重跑而丢失（重放日志恢复）。
CREATE TABLE book_entity (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id     UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- canonical 是组内展示名（原文写法）。
    canonical   TEXT NOT NULL,
    -- target_name 是译名（可为空，翻译前可能还没定）。
    target_name TEXT,
    kind        TEXT NOT NULL DEFAULT 'person',
    -- locked 表示用户锁定了该实体，自动流水线不得改动。
    locked      BOOLEAN NOT NULL DEFAULT false,
    -- from_user 表示这组的形成有用户修正参与（UI 需区分「自动推测」与「用户确认」）。
    from_user   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE book_entity ADD CONSTRAINT book_entity_kind_check
    CHECK (kind IN ('person', 'place', 'org', 'term'));

CREATE UNIQUE INDEX book_entity_book_canonical_idx ON book_entity(book_id, canonical);
CREATE INDEX book_entity_book_idx ON book_entity(book_id);

-- book_entity_member 是「归一 key → 实体」的映射。
--
-- 存 norm_key 而不是原始写法：同一人的多种写法（Mr. Darcy / Darcy / 达西先生）
-- 都归一到同一个 key，因此这张表天然不会因为写法差异而分裂。
CREATE TABLE book_entity_member (
    entity_id  UUID NOT NULL REFERENCES book_entity(id) ON DELETE CASCADE,
    norm_key   TEXT NOT NULL,
    -- surfaces 是观察到的原始写法集合，供 UI 展示「他都以哪些形式出现」。
    surfaces   TEXT[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (entity_id, norm_key)
);

CREATE INDEX book_entity_member_key_idx ON book_entity_member(norm_key);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS book_entity_member;
DROP TABLE IF EXISTS book_entity;
DROP INDEX IF EXISTS glossary_terms_glossary_idx;
DROP TABLE IF EXISTS glossary_terms;
DROP INDEX IF EXISTS glossaries_user_book_lang_idx;
DROP TABLE IF EXISTS glossaries;
-- +goose StatementEnd