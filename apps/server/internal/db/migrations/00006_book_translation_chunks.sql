-- +goose Up
-- M5-2 后台任务真执行：块级状态表 + 修正日志骨架。
--
-- 为什么必须有「块级状态表」而不是只靠 ai_jobs：
--   整书翻译一本 30 万字的书要切上百块、跑几十分钟。若只记录任务级状态，
--   进程重启 / worker 被 kill 后只能从头再来——重复花钱，且用户等了半天的进度归零。
--   把每一块的状态与产出落库，就能「从第一个未完成块继续」，已完成的块永不重译。

CREATE TABLE book_translation_chunks (
    job_id        UUID NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    chapter_index INTEGER NOT NULL,
    -- input_hash 是块级幂等的唯一依据：原文 + prompt 版本 + 术语表版本 + 模型 + 目标语言
    -- 的 sha256。任何一项变化都会产生不同的 hash，从而必须重译；
    -- 反之 hash 相同就一定能复用已有产出——这是「不重复计费」能成立的基础。
    input_hash    TEXT NOT NULL,
    -- source_text 存原文是必要的：断点续跑时要重新构造 prompt，
    -- 而重新从 EPUB 解析一遍既慢又可能因文件被替换而得到不同结果。
    source_text   TEXT NOT NULL,
    output_text   TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    usage_source  TEXT,
    attempt       INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, chunk_index)
);

-- status 取值：
--   pending  = 尚未开始（含断点续跑时未轮到的块）
--   running  = 正在翻译（进程崩溃后会被重置为 pending 重试）
--   done     = 已完成，output_text 可用
--   failed   = 该块重试次数耗尽
--   skipped  = 该块无需翻译（空段/纯标点），直接沿用原文
ALTER TABLE book_translation_chunks ADD CONSTRAINT book_translation_chunks_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped'));

ALTER TABLE book_translation_chunks ADD CONSTRAINT book_translation_chunks_usage_source_check
    CHECK (usage_source IS NULL OR usage_source IN ('upstream', 'estimated'));

-- 断点续跑的主查询：按 job 找第一个未完成块。
CREATE INDEX book_translation_chunks_pending_idx
    ON book_translation_chunks(job_id, chunk_index) WHERE status IN ('pending', 'running');

-- ai_jobs.status 新增 paused（列本身是纯 TEXT，无需改约束，这里只记录约定）：
-- 配额耗尽时置 paused 而非 failed。二者的区别是**可续跑性**：
--   failed = 需要用户重新发起，之前的进度作废；
--   paused = 额度恢复后（下个周期）继续，已完成块全部保留。
-- 这正是 M5-1 预留的「预扣/结算」结构所要求的语义。

-- ---------- 修正日志（M5-4 依赖，本期只建表，不写业务逻辑）----------
--
-- 设计要点（来自 docs/research/80-entity-normalization.md §A7）：
--   **存 append-only 的修正事件，而不是「改后的结果」**。
-- 理由：自动流水线（LLM 聚类）会重跑，重跑会覆盖它自己上次的产出。
-- 若把用户的人工修改存成「结果」，重跑时就会被冲掉，用户工作白做；
-- 存成事件日志，每次重跑后**重放**日志，用户的工作永远保留。
-- 日志同时充当负样本：记录「这两组禁止合并」，防止重跑把用户拆开的又合回去。
--
-- 所以这张表**永不 UPDATE / DELETE**，只有 INSERT 与全量重放。
CREATE TABLE book_correction (
    id         UUID PRIMARY KEY,
    book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- seq 由客户端生成，单调递增，决定重放顺序。
    -- 用 seq 而不是时间戳排序：时钟回拨会让重放顺序错乱，而 seq 不会。
    seq        BIGINT NOT NULL,
    op         TEXT NOT NULL,
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 幂等：同一本书同一个 seq 只能有一条事件（客户端重试不会产生重复事件）。
    UNIQUE (book_id, seq)
);

ALTER TABLE book_correction ADD CONSTRAINT book_correction_op_check
    CHECK (op IN ('merge', 'split', 'rename', 'alias_add', 'lock'));

CREATE INDEX book_correction_replay_idx ON book_correction(book_id, seq);

-- ---------- 负样本对（split 的副产物，防重跑回退）----------
-- 由 correction 日志派生，但独立成表是因为流水线查询它比解析 JSON 日志快得多。
CREATE TABLE book_blocked_pair (
    book_id    UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    norm_key_a TEXT NOT NULL,
    norm_key_b TEXT NOT NULL,
    PRIMARY KEY (book_id, norm_key_a, norm_key_b)
);

-- ---------- 既有任务兼容 ----------
-- 00006 之前的 book_translate 任务没有块表，worker 会因为拿不到块而无法执行。
-- 把它们标记为 failed 并说明原因，而不是让它们静默卡在 queued。
UPDATE ai_jobs SET status = 'failed',
       error = 'task predates chunk-level execution (M5-2); please re-submit'
 WHERE status IN ('queued', 'running') AND kind = 'book_translate';

-- +goose Down
DROP TABLE IF EXISTS book_blocked_pair;
DROP TABLE IF EXISTS book_correction;
DROP INDEX IF EXISTS book_translation_chunks_pending_idx;
DROP TABLE IF EXISTS book_translation_chunks;
