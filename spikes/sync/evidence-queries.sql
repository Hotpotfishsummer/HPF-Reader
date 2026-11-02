\echo '=== 1) 行数总览 ==='
select 'users' as table_name, count(*) from users
union all select 'devices', count(*) from devices
union all select 'books', count(*) from books
union all select 'book_files', count(*) from book_files
union all select 'reading_progress', count(*) from reading_progress
union all select 'annotations', count(*) from annotations
union all select 'change_log', count(*) from change_log
union all select 'sync_idempotency', count(*) from sync_idempotency;

\echo ''
\echo '=== 2) change_log：服务端裁决轨迹（seq 单调递增 == 游标） ==='
select seq,
       entity,
       left(entity_id, 8) as entity_id8,
       op,
       hlc,
       left(device_id::text, 8) as device8,
       payload->>'totalProgression' as total_progression,
       left(payload->>'contentHash', 16) as content_hash16
from change_log
order by seq;

\echo ''
\echo '=== 3) reading_progress：服务端权威合并结果 ==='
select left(book_id::text, 8) as book8,
       total_progression,
       furthest_progression,
       explicit_rewind,
       left(content_hash, 16) as content_hash16,
       hlc
from reading_progress
order by updated_at;

\echo ''
\echo '=== 4) annotations：墓碑（deleted_at 非空 == 已删除但仍占墓碑窗口） ==='
select left(id::text, 8) as id8, kind, left(book_id::text, 8) as book8,
       case when deleted_at is null then 'active' else 'tombstone' end as state,
       (select count(*) from change_log c where c.entity_id = a.id::text) as change_rows
from annotations a
order by created_at;

\echo ''
\echo '=== 5) 缺陷取证：失败的 register 是否留下孤儿用户（devices=0 即孤儿） ==='
select u.email, count(d.id) as devices
from users u
left join devices d on d.user_id = u.id
group by u.email
order by u.email;
