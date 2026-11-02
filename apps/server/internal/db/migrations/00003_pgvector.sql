-- +goose Up
-- pgvector 预留：RAG 检索需要 embedding，但一期不依赖它。
-- 这里做「有就启用、没有就跳过」，让服务在普通 postgres:16 与 pgvector/pgvector:pg16 上都能跑。
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension unavailable (%): skipping vector schema', SQLERRM;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE '
            CREATE TABLE IF NOT EXISTS chunk_embeddings (
                id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                book_id     UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                chunk_idx   INTEGER NOT NULL,
                content     TEXT NOT NULL,
                token_count INTEGER,
                embedding   vector(1536),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (book_id, chunk_idx)
            )';
        EXECUTE 'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw_idx
                 ON chunk_embeddings USING hnsw (embedding vector_cosine_ops)';
    ELSE
        RAISE NOTICE 'pgvector not installed: chunk_embeddings table skipped (RAG is M5 scope)';
    END IF;
END $$;

-- +goose Down
DROP TABLE IF EXISTS chunk_embeddings;
