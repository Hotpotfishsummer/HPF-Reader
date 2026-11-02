-- +goose Up
-- 多租户隔离兜底：Repository 层已经强制带 user_id，这里再用 RLS 挡一层，
-- 防止将来新增查询时漏掉 user_id 过滤。
--
-- 策略设计：当会话未设置 app.current_user_id（例如迁移任务、后台 worker）时策略放行；
-- 只有显式设置了当前用户才收紧。这样迁移与运维脚本不需要额外的 BYPASSRLS 角色。

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- 设置当前请求用户（每个事务开始时由 API 层调用）
CREATE OR REPLACE FUNCTION app_set_user(p_user_id uuid) RETURNS void AS $$
    SELECT set_config('app.current_user_id', COALESCE(p_user_id::text, ''), true);
$$ LANGUAGE sql;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'devices', 'refresh_tokens', 'books', 'reading_progress',
        'annotations', 'change_log', 'sync_idempotency', 'ai_jobs', 'ai_usage'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING '
            '(app_current_user_id() IS NULL OR user_id = app_current_user_id()) '
            'WITH CHECK (app_current_user_id() IS NULL OR user_id = app_current_user_id())',
            t || '_tenant_isolation', t);
    END LOOP;
END $$;

-- books 表的读取还需要覆盖「按 user_id 的软删除」等场景，策略已包含；
-- book_files 是跨书共享的字节，不含 user_id，因此不启用 RLS（由 books 的访问控制间接保护）。

-- +goose Down
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'devices', 'refresh_tokens', 'books', 'reading_progress',
        'annotations', 'change_log', 'sync_idempotency', 'ai_jobs', 'ai_usage'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
        EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;
DROP FUNCTION IF EXISTS app_set_user(uuid);
DROP FUNCTION IF EXISTS app_current_user_id();
