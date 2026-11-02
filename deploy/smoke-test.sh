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
# calljson 与 call 相同，但 PUT/POST 走 JSON body。
# call 的 PUT 分支固定是 octet-stream + @文件（书籍上传用），
# 术语表这类 JSON 端点必须用这个，否则 curl 会把 JSON 当文件名。
calljson() {
  _m="$1"
  _p="$2"
  _tok="${3:-}"
  _data="${4:-}"
  set -- -s -o /tmp/body -w "%{http_code}" -X "$_m"
  if [ -n "$_tok" ]; then set -- "$@" -H "Authorization: Bearer $_tok"; fi
  if [ -n "$_data" ]; then set -- "$@" -H "Content-Type: application/json" --data-binary "$_data"; fi
  STATUS=$(curl "$@" "$BASE$_p")
  BODY=$(cat /tmp/body 2>/dev/null || true)
}

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

echo "== 6b. 成本与配额闸门（M5-1） =="
# 用量接口必须两个维度都返回：只按调用次数计费会严重失真
# （划词一次几厘钱，整书一次约 1~2 元，两者都算「1 次调用」）。
call GET /v1/ai/usage "$TOKEN"
check "用量接口 = 200" "$STATUS" "200"
contains "用量返回 calls 维度" "$BODY" '"calls"'
contains "用量返回 tokens 维度" "$BODY" '"tokens"'
contains "用量返回 resetAt" "$BODY" '"resetAt"'
contains "周期为 UTC 自然月首" "$BODY" '"periodStart":"20'

# 刚翻译过一次，必须已经记账（ai_usage 曾全仓从未 INSERT）
contains "调用后已记账（出现 translate 汇总）" "$BODY" '"translate"'

# 计数器与记账必须一致：tokens.used = 该 feature 的 input+output
UTOK=$(printf "%s" "$BODY" | jnum used)
ATOK=$(printf "%s" "$BODY" | jnum inputTokens)
OTOK=$(printf "%s" "$BODY" | jnum outputTokens)
if [ -n "$UTOK" ] && [ -n "$ATOK" ] && [ -n "$OTOK" ] && [ "$UTOK" -eq "$((ATOK + OTOK))" ]; then
  ok "计数器与记账一致（tokens.used=$UTOK = $ATOK + $OTOK）"
else
  bad "计数器与记账不一致：tokens.used=[$UTOK] 记账=[$ATOK]+[$OTOK]"
fi

# 配额耗尽 → 429。通过 HPF_AI_DAILY_QUOTA 把新用户配额设成 1 来验证：
# 第 2 次调用必须被拒，且错误码是 quota_exceeded（不是 rate_limited）。
# 这里刻意不用 psql —— smoke 跑在 alpine 容器里没有 psql，
# 只用 HTTP + 环境变量，保持脚本的「纯黑盒」性质。
if [ "${QUOTA_TEST:-0}" = "1" ]; then
  echo "  -- 配额耗尽（配额=1，第 2 次必须 429）--"
  QEMAIL="quota-$RANDOM-$$@example.com"
  call POST /v1/auth/register "" "{\"email\":\"$QEMAIL\",\"password\":\"smoke-test-password-9x\",\"deviceName\":\"quota\"}"
  check "配额账号注册 = 201" "$STATUS" "201"
  QTOKEN=$(printf "%s" "$BODY" | jget accessToken)
  call POST /v1/ai/translate "$QTOKEN" '{"text":"first","targetLang":"zh"}'
  check "第 1 次调用 = 200（额度内）" "$STATUS" "200"
  QSTATUS=$(curl -s -o /tmp/q.out -w "%{http_code}" -H "Authorization: Bearer $QTOKEN" -H "Content-Type: application/json" \
    --data-binary '{"text":"second","targetLang":"zh"}' "$BASE/v1/ai/translate")
  check "第 2 次调用 = 429（超配额）" "$QSTATUS" "429"
  contains "429 错误码 = quota_exceeded" "$(cat /tmp/q.out)" '"quota_exceeded"'
  contains "429 指明维度 dimension" "$(cat /tmp/q.out)" '"dimension"'
  contains "429 带 resetAt" "$(cat /tmp/q.out)" '"resetAt"'
else
  echo "  （跳过配额耗尽用例：设 QUOTA_TEST=1 且 API 侧 HPF_AI_DAILY_QUOTA=1 时启用）"
fi

echo "== 6c. 后台任务真执行（M5-2） =="
# 整书翻译是最贵的路径，必须验证它真的被 worker 消费并推进状态。
# 断点续跑 / 取消止血的实测需要 kill 进程，不适合放进冒烟，见 STATUS.md §8.10。
JEMAIL="job-$RANDOM-$$@example.com"
call POST /v1/auth/register "" "{\"email\":\"$JEMAIL\",\"password\":\"smoke-test-password-9x\",\"deviceName\":\"job\"}"
check "任务账号注册 = 201" "$STATUS" "201"
JTOKEN=$(printf "%s" "$BODY" | jget accessToken)

call POST /v1/books "$JTOKEN" '{"title":"Smoke Job Book","format":"epub"}'
check "建书 = 201" "$STATUS" "201"
JBOOK=$(printf "%s" "$BODY" | jget id)

# 提交整书翻译任务（不依赖真实 epub 内容：
# 即使解析失败，也必须「状态机推进 + 错误可解释」，
# 这正好验证 worker 真的在消费，而不是永远卡 queued）
JRESP=$(curl -s -X POST "$BASE/v1/ai/jobs" -H "Authorization: Bearer $JTOKEN" -H "Content-Type: application/json" \
  --data-binary "{\"kind\":\"book_translate\",\"bookId\":\"$JBOOK\",\"options\":{\"targetLang\":\"zh\"}}")
JOB=$(printf "%s" "$JRESP" | jget id)
if [ -n "$JOB" ]; then
  ok "后台任务被受理（jobId 非空）"
else
  bad "后台任务未被受理：$JRESP"
fi

# 轮询到终态（最多 20 秒）：必须离开 queued/running
i=0; JSTATUS="queued"
while [ $i -lt 10 ]; do
  sleep 2
  JSTATUS=$(curl -s "$BASE/v1/ai/jobs/$JOB" -H "Authorization: Bearer $JTOKEN" | jget status)
  case "$JSTATUS" in queued|running) i=$((i+1)) ;; *) break ;; esac
done
case "$JSTATUS" in
  succeeded|failed|paused|canceled)
    ok "任务到达终态（$JSTATUS），不是永远卡在 queued/running" ;;
  *) bad "任务卡在 $JSTATUS（worker 未消费）" ;;
esac

# 无论成败都必须带可解释的 result 或 error
JFINAL=$(curl -s "$BASE/v1/ai/jobs/$JOB" -H "Authorization: Bearer $JTOKEN")
case "$JFINAL" in
  *\"result\"*|*\"error\"*) ok "任务带 result 或 error（失败可解释）" ;;
  *) bad "任务既无 result 也无 error（静默失败）：$JFINAL" ;;
esac

echo "== 6d. 术语表服务端化（M5-3） =="
# 术语表是内容侧数据（能暴露用户在读什么书、书里有哪些人名），
# 所以除了功能，还必须验证鉴权与越权。
call GET "/v1/books/$JBOOK/glossary?targetLang=zh" "$JTOKEN"
check "读术语表（空表）= 200" "$STATUS" "200"
contains "空术语表 version 为 0" "$BODY" '"version":0'

# 写入一条术语：key 由服务端从 display 计算，客户端不实现归一化。
calljson PUT "/v1/books/$JBOOK/glossary" "$JTOKEN" '{"targetLang":"zh","terms":[{"display":"Mr. Darcy","target":"达西先生"}]}'
check "写术语 = 200" "$STATUS" "200"
contains "写入后能读回译名" "$BODY" '"target":"达西先生"'
# 服务端应把 "Mr. Darcy" 归一成 key=darcy（剥掉尊称、小写）。
contains "key 由服务端归一得出（darcy）" "$BODY" '"key":"darcy"'
contains "来源默认 user_confirmed" "$BODY" '"source":"user_confirmed"'

# version 必须递增：它参与译文 input_hash，术语变了旧译文就失效。
V1=$(printf "%s" "$BODY" | jget version)
calljson PUT "/v1/books/$JBOOK/glossary" "$JTOKEN" '{"targetLang":"zh","terms":[{"key":"darcy","display":"Mr. Darcy","target":"达西","source":"llm_extracted"}]}'
V2=$(printf "%s" "$BODY" | jget version)
if [ "$V2" -gt "$V1" ]; then ok "再次写入后 version 递增（$V1 -> $V2）"; else bad "version 未递增（$V1 -> $V2）"; fi
# **用户确认的译名不得被自动流水线覆盖** —— 这是本轮最重要的行为断言。
contains "用户确认值未被 llm_extracted 覆盖" "$BODY" '"target":"达西先生"'
contains "来源仍为 user_confirmed" "$BODY" '"source":"user_confirmed"'

# 鉴权：未登录不得读术语表。
call GET "/v1/books/$JBOOK/glossary?targetLang=zh" ""
check "未登录读术语表 = 401" "$STATUS" "401"
# 入参校验：非 UUID bookId 不能走到 SQL 层（否则 22P02 会变成 500，客户端无限重试）。
call GET "/v1/books/not-a-uuid/glossary?targetLang=zh" "$JTOKEN"
check "非 UUID bookId = 400（不是 500）" "$STATUS" "400"
# targetLang 必填：不默认成 zh，避免「以为在改中文、实际改了日文」。
call GET "/v1/books/$JBOOK/glossary" "$JTOKEN"
check "缺 targetLang = 400" "$STATUS" "400"
# 越权：另一个用户不能读这本书的术语表。
call GET "/v1/books/$JBOOK/glossary?targetLang=zh" "$TOKEN"
if [ "$STATUS" = "404" ] || [ "$STATUS" = "403" ]; then
  ok "他人读我的术语表被拒（$STATUS）"
else
  bad "他人能读我的术语表（$STATUS）：$BODY"
fi

# 删除术语也必须可用（F-06 那类缺陷就在删除路径上）。
calljson PUT "/v1/books/$JBOOK/glossary" "$JTOKEN" '{"targetLang":"zh","removeKeys":["darcy"]}'
check "删除术语 = 200" "$STATUS" "200"
contains "删除后术语表为空" "$BODY" '"terms":[]'

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