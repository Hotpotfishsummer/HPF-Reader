-- 重置同步联调库：只清数据，保留 schema_migrations（迁移不回滚）。
-- 目的：让「首次上传 → 201/deduplicated=false」「change_log 从 seq=1 开始」这些证据可重复。
TRUNCATE TABLE
    ai_jobs,
    ai_usage,
    annotations,
    audit_logs,
    book_files,
    book_sources,
    books,
    change_log,
    chunk_embeddings,
    devices,
    reading_progress,
    refresh_tokens,
    sync_idempotency,
    users
RESTART IDENTITY CASCADE;
