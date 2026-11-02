-- +goose Up
-- 进度列原本是 real(float4)：0.8 存进去读回来是 0.800000011920929，
-- 客户端 JSON 里很难看，也容易让「相等 / 小于」的判断出现意外。
-- double precision 无精度损失（float4 -> float8 是安全加宽），输出也干净。
ALTER TABLE reading_progress
    ALTER COLUMN total_progression TYPE DOUBLE PRECISION,
    ALTER COLUMN furthest_progression TYPE DOUBLE PRECISION;

-- +goose Down
ALTER TABLE reading_progress
    ALTER COLUMN total_progression TYPE REAL,
    ALTER COLUMN furthest_progression TYPE REAL;
