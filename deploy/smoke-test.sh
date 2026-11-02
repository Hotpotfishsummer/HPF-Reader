#!/bin/sh
# HPF-Reader 端到端冒烟测试（在 compose 网络内运行，需要 curl + sha256sum）。
#
#   docker run --rm --network hpf-reader_edge \
#     -v "$PWD/smoke-test.sh:/smoke.sh:ro" alpine:3.20 \
#     sh -c "apk add --no-cache curl >/dev/null && sh /smoke.sh"
#
# 覆盖链路：探针 -> 注册/登录/刷新轮换与重用检测 -> 建书 -> 上传/秒传/哈希校验/Range
#   -> 同步 push 幂等 + HLC 单调 + 过期 op 忽略 + 显式回滚不覆盖最远进度
#   -> pull 单调游标 -> snapshot -> 标注 CRUD -> AI SSE -> 书源错误分支。
# 任何一条不符预期即以非 0 退出，可直接接进 CI。

set -u
BASE="${BASE:-http://api:8080}"
PASS=0
FAIL=0
STATUS=""
BODY=""

ok()  { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got [$2] want [$3])"; fi; }
contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1 (missing [$3])";; esac; }

# call <method> <path> [token] [json|@file]
# 直接设置两个全局变量：STATUS（HTTP 状态码）、BODY（响应体）。
# 注意：绝不能用 BODY=$(call ...) 形式调用 —— 那会在子 shell 里执行，全局变量传不回父 shell。
call() {
  _m="$1"
  _p="$2"
  _tok="${3:-}"
  _data="${4:-}"
  set -- -s -o /tmp/body -w "%{http_code}" -X "$_m"
  if [ -n "$_tok" ]; then set -- "$@" -H "Authorization: Bearer $_tok"; fi
  case "$_m" in
    POST|PATCH) set -- "$@" -H "Content-Type: application/json" --data-binary "$_data" ;;
    PUT) set -- "$@" -H "Content-Type: application/octet-stream" --data-binary "@$_data" ;;
  esac
  STATUS=$(curl "$@" "$BASE$_p")
  BODY=$(cat /tmp/body 2>/dev/null || true)
}

# 极简 JSON 取值，避免依赖 jq
jget() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }
jnum() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1; }

echo "== 1. 探针 =="
call GET /healthz
check "GET /healthz = 200" "$STATUS" "200"
contains "/healthz 返回 ok" "$BODY" '"ok"'
call GET /readyz
check "GET /readyz = 200（数据库可达）" "$STATUS" "200"
call GET /metrics
check "GET /metrics = 200" "$STATUS" "200"
contains "/metrics 暴露 http 计数" "$BODY" "hpf_http_requests_total"

echo "== 2. 认证 =="
EMAIL="smoke-$RANDOM-$$@example.com"
call POST /v1/auth/register "" "{\"email\":\"$EMAIL\",\"password\":\"smoke-test-password-9x\",\"displayName\":\"Smoke\"}"
check "注册 = 201" "$STATUS" "201"
TOKEN=$(printf "%s" "$BODY" | jget accessToken)
REFRESH=$(printf "%s" "$BODY" | jget refreshToken)
if [ -n "$TOKEN" ]; then ok "拿到 accessToken"; else bad "注册未返回 accessToken"; fi
call POST /v1/auth/register "" "{\"email\":\"$EMAIL\",\"password\":\"another-password-11\"}"
check "重复注册同邮箱 = 409" "$STATUS" "409"
call POST /v1/auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"smoke-test-password-9x\"}"
check "登录 = 200" "$STATUS" "200"
call POST /v1/auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}"
check "错误口令 = 401" "$STATUS" "401"
call GET /v1/me "$TOKEN"
check "GET /v1/me = 200" "$STATUS" "200"
call GET /v1/devices "$TOKEN"
check "GET /v1/devices = 200" "$STATUS" "200"
call GET /v1/me "not-a-real-token"
check "伪造 token = 401" "$STATUS" "401"
call POST /v1/auth/refresh "" "{\"refreshToken\":\"$REFRESH\"}"
check "刷新 = 200" "$STATUS" "200"
call POST /v1/auth/refresh "" "{\"refreshToken\":\"$REFRESH\"}"
check "旧 refresh 重用被拒 = 401（轮换 + 重用检测）" "$STATUS" "401"

echo "== 3. 书籍与文件 =="
call POST /v1/books "$TOKEN" '{"title":"Smoke Book","author":"Tester","format":"epub","language":"en"}'
check "建书 = 201" "$STATUS" "201"
BOOK=$(printf "%s" "$BODY" | jget id)
if [ -n "$BOOK" ]; then ok "拿到 bookId"; else bad "建书未返回 id"; fi
call GET /v1/books "$TOKEN"
check "列书 = 200" "$STATUS" "200"
contains "列表包含新书" "$BODY" "$BOOK"

head -c 20000 /dev/urandom > /tmp/fake.epub
HASH=$(sha256sum /tmp/fake.epub | cut -d" " -f1)
call PUT "/v1/books/$BOOK/file?contentHash=sha256:$HASH" "$TOKEN" /tmp/fake.epub
check "上传文件 = 201" "$STATUS" "201"
call PUT "/v1/books/$BOOK/file?contentHash=sha256:$HASH" "$TOKEN" /tmp/fake.epub
check "同内容再传 = 200（秒传去重）" "$STATUS" "200"
contains "响应标记 deduplicated" "$BODY" '"deduplicated":true'
# 「声明哈希 != 实际字节」必须用一份全新的随机文件 + 尚未挂文件的书籍来测：
#   - 同书再传不同哈希会先被「该书已有其它文件」拦下（409）；
#   - 复用已有文件字节会被 books_user_hash_idx (user_id, file_hash) 拦下（同一用户同一文件只能有一条书目）。
head -c 7777 /dev/urandom > /tmp/fake2.epub
HASHB=$(sha256sum /tmp/fake2.epub | cut -d" " -f1)
call POST /v1/books "$TOKEN" '{"title":"Smoke Book 2","format":"epub"}'
BOOK2=$(printf "%s" "$BODY" | jget id)
call PUT "/v1/books/$BOOK2/file?contentHash=sha256:0000000000000000000000000000000000000000000000000000000000000000" "$TOKEN" /tmp/fake2.epub
check "声明哈希与实际字节不符 = 400" "$STATUS" "400"
call PUT "/v1/books/$BOOK2/file?contentHash=sha256:$HASHB" "$TOKEN" /tmp/fake2.epub
check "修正哈希后同一文件可上传 = 201" "$STATUS" "201"
# 同一用户对同一份文件只能有一条书目：把已有文件挂到第三本书必须 409 并给出明确原因
call POST /v1/books "$TOKEN" '{"title":"Smoke Book 3","format":"epub"}'
BOOK3=$(printf "%s" "$BODY" | jget id)
call PUT "/v1/books/$BOOK3/file?contentHash=sha256:$HASHB" "$TOKEN" /tmp/fake2.epub
check "同一用户重复挂同一文件 = 409" "$STATUS" "409"
contains "409 解释了是 contentHash 重复" "$BODY" "same content hash"

RSTATUS=$(curl -s -o /tmp/part -D /tmp/rhdr -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-15" "$BASE/v1/books/$BOOK/file")
check "Range 下载 = 206" "$RSTATUS" "206"
check "Range 只返回 16 字节" "$(wc -c < /tmp/part | tr -d " ")" "16"
contains "Range 响应带 Content-Range" "$(cat /tmp/rhdr)" "Content-Range: bytes 0-15/"
contains "下载带 ETag（内容哈希）" "$(cat /tmp/rhdr)" "Etag:"

echo "== 4. 同步引擎（核心） =="
HLC1="00192a3f4c1b0-0000000a-7f3c9d21"
HASH2="1111111111111111111111111111111111111111111111111111111111111111"
HASH3="2222222222222222222222222222222222222222222222222222222222222222"

push_op() { # push_op <json-file>：替换占位符后推送
  sed -e "s/BOOKID/$BOOK/" -e "s/HASHVALUE/$HASH/" -e "s/HASH2/$HASH2/" -e "s/HASH3/$HASH3/" "$1" > /tmp/op.final.json
  call POST /v1/sync/push "$TOKEN" "$(cat /tmp/op.final.json)"
}

# op1：同副本（同 contentHash）首次写入
cat > /tmp/op1.json <<JSON
{"deviceId":"11111111-1111-4111-8111-111111111111","ops":[{"opId":"22222222-2222-4222-8222-222222222222","entity":"progress","entityId":"BOOKID","kind":"upsert","hlc":"00192a3f4c1b0-0000000a-7f3c9d21","payload":{"locator":{"href":"c1.xhtml","type":"application/xhtml+xml"},"totalProgression":0.42,"furthestProgression":0.42,"contentHash":"sha256:HASHVALUE"}}]}
JSON
push_op /tmp/op1.json
check "push = 200" "$STATUS" "200"
contains "首次写入判定 applied" "$BODY" '"applied"'
CURSOR=$(printf "%s" "$BODY" | jnum cursor)
if [ -n "$CURSOR" ]; then ok "返回服务端游标 ($CURSOR)"; else bad "push 未返回 cursor"; fi

# 幂等：同 opId 再推一次，游标必须不动
push_op /tmp/op1.json
check "同 opId 重放 = 200" "$STATUS" "200"
contains "重放 reason=duplicate" "$BODY" '"reason":"duplicate"'
check "重放不推进游标（幂等）" "$(printf "%s" "$BODY" | jnum cursor)" "$CURSOR"

# 同副本更旧 HLC + 更低进度 → 必须被忽略，游标不动
cat > /tmp/opold.json <<JSON
{"deviceId":"33333333-3333-4333-8333-333333333333","ops":[{"opId":"44444444-4444-4444-8444-444444444444","entity":"progress","entityId":"BOOKID","kind":"upsert","hlc":"00192a3f4c000-00000001-33333333","payload":{"locator":{"href":"c0.xhtml","type":"application/xhtml+xml"},"totalProgression":0.05,"contentHash":"sha256:HASHVALUE"}}]}
JSON
push_op /tmp/opold.json
check "更旧 HLC + 更低进度 仍返回 200" "$STATUS" "200"
contains "过期 op reason=older_hlc（契约只允许 applied/rejected）" "$BODY" '"reason":"older_hlc"'
check "被忽略的 op 不推进游标" "$(printf "%s" "$BODY" | jnum cursor)" "$CURSOR"

# 跨副本前移：另一个 contentHash（同书不同文件），0.80 > 最远 0.42 + epsilon → 单调前移
cat > /tmp/opfwd.json <<JSON
{"deviceId":"33333333-3333-4333-8333-333333333333","ops":[{"opId":"66666666-6666-4666-8666-666666666666","entity":"progress","entityId":"BOOKID","kind":"upsert","hlc":"00192a3f4c1b5-00000000-33333333","payload":{"locator":{"href":"c9.xhtml","type":"application/xhtml+xml"},"totalProgression":0.8,"contentHash":"sha256:HASH2"}}]}
JSON
push_op /tmp/opfwd.json
contains "跨副本前进判定 applied" "$BODY" '"applied"'
call GET /v1/sync/snapshot "$TOKEN"
contains "跨副本前进后 snapshot 位置 = 0.8" "$BODY" '"totalProgression":0.8'
contains "跨副本前进后最远进度 = 0.8" "$BODY" '"furthestProgression":0.8'

# 跨副本显式回滚：0.1 + explicitRewind → 当前位置后退，但最远基线保留 0.8
cat > /tmp/oprewind.json <<JSON
{"deviceId":"33333333-3333-4333-8333-333333333333","ops":[{"opId":"55555555-5555-4555-8555-555555555555","entity":"progress","entityId":"BOOKID","kind":"upsert","hlc":"00192a3f4c1c0-00000000-33333333","payload":{"locator":{"href":"c2.xhtml","type":"application/xhtml+xml"},"totalProgression":0.1,"explicitRewind":true,"contentHash":"sha256:HASH3"}}]}
JSON
push_op /tmp/oprewind.json
check "显式回滚 push = 200" "$STATUS" "200"
contains "显式回滚判定 applied" "$BODY" '"applied"'
call GET /v1/sync/snapshot "$TOKEN"
contains "回滚后当前位置 = 0.1" "$BODY" '"totalProgression":0.1'
contains "回滚后最远进度仍为 0.8（只增不减）" "$BODY" '"furthestProgression":0.8'

# 跨副本且未显式回滚的低进度 → 必须被忽略（防止 A 设备把 B 设备的进度拉回去）
cat > /tmp/opstale.json <<JSON
{"deviceId":"77777777-7777-4777-8777-777777777777","ops":[{"opId":"88888888-8888-4888-8888-888888888888","entity":"progress","entityId":"BOOKID","kind":"upsert","hlc":"00192a3f4c1d0-00000000-77777777","payload":{"locator":{"href":"c0.xhtml","type":"application/xhtml+xml"},"totalProgression":0.05,"contentHash":"sha256:HASH2"}}]}
JSON
push_op /tmp/opstale.json
contains "未授权回退 reason=stale_no_rewind" "$BODY" '"reason":"stale_no_rewind"'

call GET "/v1/sync/pull?cursor=0&limit=50" "$TOKEN"
check "pull = 200" "$STATUS" "200"
contains "pull 返回进度变更" "$BODY" '"progress"'
contains "pull 反映最新一次写入（0.1）" "$BODY" '"totalProgression":0.1'
# 注意：pull 返回的是「客户端上传的 op 载荷」（用于增量重放），服务端合并出的 furthest 只在 snapshot/进度查询里；
# 客户端自己在 apply 时也会 bump furthest，因此两边最终一致。

call GET "/v1/sync/pull?cursor=0&limit=2" "$TOKEN"
check "pull 带 limit = 200（分页）" "$STATUS" "200"
contains "分页响应含 changes" "$BODY" '"changes"'
call GET /v1/sync/snapshot "$TOKEN"
check "snapshot = 200" "$STATUS" "200"
contains "snapshot 含该书" "$BODY" "$BOOK"
contains "snapshot 进度为回滚后的值 0.1" "$BODY" '"totalProgression":0.1'

echo "== 5. 标注 =="
call POST "/v1/books/$BOOK/annotations" "$TOKEN" '{"type":"highlight","text":"hello","locator":{"href":"c1.xhtml","type":"application/xhtml+xml"},"color":"yellow"}'
check "建标注 = 201" "$STATUS" "201"
ANN=$(printf "%s" "$BODY" | jget id)
call GET "/v1/books/$BOOK/annotations" "$TOKEN"
check "列标注 = 200" "$STATUS" "200"
contains "标注出现在列表" "$BODY" "$ANN"
call PATCH "/v1/annotations/$ANN" "$TOKEN" '{"note":"updated note"}'
check "改标注 = 200" "$STATUS" "200"
contains "改动已生效" "$BODY" "updated note"
call DELETE "/v1/annotations/$ANN" "$TOKEN"
check "删标注 = 204" "$STATUS" "204"
call DELETE "/v1/annotations/$ANN" "$TOKEN"
check "重复删标注 = 204（幂等）" "$STATUS" "204"

echo "== 6. AI（fake provider，SSE 流式） =="
SSTATUS=$(curl -s -N -o /tmp/sse -D /tmp/shdr -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary '{"text":"Hello world","targetLang":"zh"}' "$BASE/v1/ai/translate")
check "SSE 翻译 = 200" "$SSTATUS" "200"
contains "SSE 有 delta 事件" "$(cat /tmp/sse)" "event: delta"
contains "SSE 有 done 事件" "$(cat /tmp/sse)" "event: done"
contains "SSE Content-Type = text/event-stream" "$(cat /tmp/shdr)" "text/event-stream"

echo "== 7. 书源 =="
call GET "/v1/sources/search?q=austen&source=zlibrary" "$TOKEN"
check "未知书源 = 400" "$STATUS" "400"
contains "错误信息列出可用书源" "$BODY" "gutenberg"
call GET "/v1/sources/search" "$TOKEN"
check "缺 q 参数 = 400" "$STATUS" "400"

echo
echo "==== 冒烟结果: PASS=$PASS FAIL=$FAIL ===="
if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "ALL SMOKE CHECKS PASSED"