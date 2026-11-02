
# RESULTS · G2 隔离 PoC：中间件拦截（C-01）与窗口头伪造（C-09）

> **任务**：task-10 ｜ **交付**：`spikes/isolation/RESULTS.md` ＋ 可复现工程 `spikes/isolation/IsolationSpike/`
> **采集时间**：2026-11-02 23:30–23:47（Asia/Shanghai）
> **环境**：Windows 11 ｜ Wails **v3.1.0**（Go 1.26.0 工具链）｜ WebView2 ｜ node v24.20.0 ｜ pnpm 12.16.1（corepack）
> **性质**：**纯验证工程**，`SecretService` 是故意设置的特权服务，用于量化"不可信内容能造成多大破坏"。

---

## 0. 判定摘要（先看这个）

| 门 | 问题 | **判定** | 关键原始证据 |
|---|---|---|---|
| **C-01** | 自建中间件能否拦到 `/wails/runtime`？在 runtime handler 之前还是之后？能否据此拒绝？ | ✅ **成立** | 桌面模式 9 次 runtime 调用全部被中间件记到（`requests.jsonl`）；block 模式下主窗口自身调用也被 **403**；阻断后**真实落盘副作用消失** |
| **C-09** | iframe 伪造 `x-wails-window-id`，Go 侧看到真值还是伪造值？ | ✅ **成立（原生值不可伪造）** | 伪造 `424242 / 777777 / FORGED-WINDOW-NAME`，中间件**每次都记录到真值** `wid=1 name=main-window`。但 `x-wails-client-id` **原样透传**（`FORGED-CLIENT-ID`） |
| **Arch-B（L4）** | 能否"只拒绝阅读器窗口"的 runtime 调用，主窗口不受影响？ | ✅ **成立（本 PoC 已验证）** | 双窗口实测：主窗口 **9/9 放行**，阅读器窗口 **9/9 被拦** |
| 桌面模式网络面 | 桌面模式是否暴露 HTTP 端口（curl 能否直连）？ | ✅ **无端口** | `Get-NetTCPConnection -OwningProcess <pid>` → **NONE** |
| server 模式 | 无 Origin 的非浏览器客户端能否直调？ | ⚠️ **能（200 + 泄密）** | `curl` 不带 Origin → **HTTP 200 + `TOP-SECRET-TOKEN-12345`**；带 `Origin: http://evil.example` → 403 |

**综合判定：C-01 与 C-09 均成立 → Arch-B（L4）方案在技术上可实施。** 但 L4 只解决"**谁能调桥**"，不解决"**书内容能否读父窗口**"——见 `5 残余风险。

---

## 1. 复现步骤（原始命令）

```powershell
# 每条命令前先设置（本机 go 可移植版 + 国内代理）
$env:PATH = 'C:\Users\HOTPOTFISH\go-portable\go\bin;' + $env:PATH
$env:GOTOOLCHAIN = 'auto'
$env:GOPROXY = 'https://goproxy.cn,direct'
$WAILS = 'C:\Users\HOTPOTFISH\go\bin\wails3.exe'

# 1) 建工程（工作目录 = HPF-Reader 根）
& $WAILS init -t vanilla -n IsolationSpike -d spikes/isolation -mod github.com/hotpotfish/hpfreader/spike-isolation

# 2) 生成 bindings（2 Services / 4 Methods：Greet + GetSecret + WriteFile + ReadFile）
cd spikes\isolation\IsolationSpike
& $WAILS generate bindings -ts -i -clean=true

# 3) 前端
cd frontend; corepack pnpm install; corepack pnpm run build; cd ..

# 4) 两种构建
go build -o bin\isolationspike.exe .                    # 桌面（WebView2）
go build -tags server -o bin\isolationspike-server.exe . # server（纯 HTTP）

# 5) 观察模式（只记录，不拦）
$env:SPIKE_EVIDENCE_DIR = (Resolve-Path 'evidence\run-obs3').Path
$env:SPIKE_BLOCK = '0'
Start-Process bin\isolationspike.exe -PassThru    # 运行 45s 后 Stop-Process

# 6) 阻断模式（中间件 403 掉所有无 nonce 的 runtime 调用）
$env:SPIKE_BLOCK = '1'                            # evidence\run-block4

# 7) Arch-B 策略模式（只拒绝阅读器窗口）
$env:SPIKE_DENY_WINDOW_NAME = 'reader-window'     # evidence\run-archb-on
```

证据文件（每次运行独立目录）：`probe-results.jsonl`（前端探针结论，经 `/spike/report` 上报）、`requests.jsonl`（中间件逐请求日志，含全部头 + runtime 调用原始 body）、`stderr.log`、`pwned-from-iframe.txt`。

---

## 2. C-01：中间件能否拦到 `/wails/runtime`

### 2.1 源码定位（先看 hook 在哪）

| 事实 | 位置（wails v3.1.0，模块缓存） |
|---|---|
| 中间件类型 | `pkg/application/application_options.go:227` → `type Middleware func(next http.Handler) http.Handler` |
| 挂载点 | `pkg/application/application_options.go:203-218` → `AssetOptions.Middleware` |
| **包裹整个 asset server** | `internal/assetserver/assetserver.go:56-64`：`handler := ...serveHTTP(userHandler)`；`if middleware := options.Middleware; middleware != nil { handler = middleware(handler) }` |
| 官方注释 | `internal/assetserver/options.go:212`：「This middleware injects itself **before any of Wails internal middlewares**.」 |
| 短路有测试背书 | `pkg/application/application_options_test.go:276` `TestMiddleware_ShortCircuit` |

`/wails/runtime` 的分发发生在 `serveHTTP` **内部**，因此中间件在其外层 → **必然先执行**。下面是实测。

### 2.2 实测 (i)：中间件**确实被执行**（观察模式）

原始命令：见 `1 第 5 步。`evidence/run-obs3/requests.jsonl` 中 runtime 调用条数 = **9**，抽样原始行（已截断 `headers_all`）：

```json
{"ts":"2026-11-02T23:35:36...","handler":"middleware","kind":"request","method":"POST","path":"/wails/runtime","is_runtime_call":true,"decision":"pass","block_mode":false,"hdr_window_id":"1","hdr_window_name":"main-window","hdr_client_id":"XNbeunqy3HHwXqgzEgy0y","hdr_origin":"http://wails.localhost","hdr_sec_fetch":"","body":"{\"object\":0,\"method\":0,\"args\":{\"call-id\":\"r1ESub5Nr2RdMfFfgxdjr\",\"methodName\":\"main.SecretService.GetSecret\",\"args\":[]}}"}
```

同时中间件**自己处理了** `/spike/report`（探针结果文件正是由它写出的）——这本身即"短路可拦截"的直接证据：

```text
GET /            (decision=pass)   <- 静态资源照常
GET /assets/index-Dv-vHHyz.js
GET /wails/runtime.js
HEAD /wails/custom.js
POST /spike/report  -> decision="handled-by-middleware"（HTTP 200 {"ok":true,"handledBy":"middleware"}）
```

**结论 (i)：中间件被执行，且能对任意路径短路接管。**

### 2.3 实测 (ii)+(iii)：执行顺序与拒绝能力（阻断模式）

原始命令：`$env:SPIKE_BLOCK='1'`（中间件对无 `x-hpf-ipc` nonce 的 `/wails/runtime` 一律 403）。`evidence/run-block4`：

```text
runtime calls: 9 | decisions {"block":9}
  POST block wid=1 wname=main-window cid=Dzhy0f4zBHkQuET1NbCyh origin="http://wails.localhost"
  OPTIONS block wid=1 wname=main-window origin="null"      <- 不透明帧的预检
  POST block wid=1 wname=main-window cid=FORGED-RAW-CLIENT
（其余 6 条同为空 block）

前端探针结论（同一 run）：
FAIL | D1-mainframe-call                :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
FAIL | B2-blob-sandbox-sameorigin-scripts-call :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
FAIL | B4-blob-sameorigin-writefile     :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
OK   | B10-blob-sameorigin-raw-fetch    :: hand-built raw POST -> HTTP 403
OK   | B11-...raw-fetch-forged          :: HTTP 403
```

两个关键点：

1. **`D1`（主窗口自己的合法调用）也被 403** → 说明中间件确实位于 runtime handler **之前**（否则 runtime handler 已先返回 200）。这正是 (ii) 的答案。
2. 阻断后 **`pwned-from-iframe.txt` 未被创建**（`Test-Path → False`），而观察模式下该文件存在（107 bytes）→ 拒绝是**有效**的，不只是返回码好看。

**结论 (ii)(iii)：顺序为「用户中间件 → Wails 内部 → runtime handler」，且可据此完全拒绝。C-01 成立。**

---

## 3. C-09：伪造 `x-wails-window-id` 会怎样

### 3.1 源码定位

| 事实 | 位置 |
|---|---|
| 原生层**覆盖式**注入 | `pkg/application/application.go:390-402`：`hh := h.Clone()` → `hh.Set(webViewRequestHeaderWindowId, strconv.FormatUint(uint64(r.windowId),10))`；`if r.windowName != "" { hh.Set(webViewRequestHeaderWindowName, r.windowName) }`。**`Set` = 覆盖**，不是 `Add` |
| runtime handler 读取 | `pkg/application/transport_http.go:325-336`：`r.Header.Get("x-wails-window-id")` / `...WindowName` / `r.Header.Get("x-wails-client-id")` |
| 桌面/移动模式**零校验** | `pkg/application/transport_http_notserver.go` 全文（`//go:build !server`）：`func checkRuntimeRequest(...) bool { return true }` |
| **帧身份不存在**（官方自述） | `pkg/application/stream.go:831` 注释：「Keyed on the window, not the client, so several runtimes under one window id (**an iframe loading /wails/runtime.js gets the same id** and its own session) would collide.」 |

### 3.2 实测：从 iframe 伪造头

探针 `B7`/`B11` 在 **blob: 帧**内（`sandbox="allow-same-origin allow-scripts"`）手写 fetch，故意设置：

```text
x-wails-window-id:   424242   / 777777
x-wails-window-name: FORGED-WINDOW-NAME  / FORGED-RAW
x-wails-client-id:   FORGED-CLIENT-ID   / FORGED-RAW-CLIENT
```

中间件实际记录（`evidence/run-obs3/requests.jsonl`，原始行）：

```text
pass wid=1 wname=main-window cid=XNbeunqy3HHwXqgzEgy0y body={...GetSecret...}          <- 正常调用
pass wid=1 wname=main-window cid=FORGED-MAIN-CLIENT   body={...spike-nocapture...}     <- 主帧伪造 id/name/client
pass wid=1 wname=main-window cid=FORGED-CLIENT-ID     body={...spike-nocapture...}     <- blob 帧伪造 id/name/client
pass wid=1 wname=main-window cid=(空) origin="null"   body=(空 -> OPTIONS 预检)         <- 不透明帧
pass wid=1 wname=main-window cid=FORGED-RAW-CLIENT    body={...GetSecret...}           <- blob 帧伪造 + 手写 body
```

**9 条 runtime 调用中，`x-wails-window-id` 100% 为 `1`、`x-wails-window-name` 100% 为 `main-window`，与伪造值无关。**

**结论：`x-wails-window-id` / `x-wails-window-name` 不可伪造（原生 `Set` 覆盖）→ C-09 成立。**
**但 `x-wails-client-id` 完全由 JS 自填、原样透传（`FORGED-CLIENT-ID`）→ 不可作为任何授权依据。**

补充（server 模式差异）：`-tags server` 下**没有原生注入层**（curl 不是 webview），伪造的 `x-wails-window-id: 999` 被中间件**原样记录为 `999`**（`evidence/run-server2/requests.jsonl`）且请求被接受 → **server 模式下窗口头完全不可信**。

---

## 4. 漏洞基线：不可信帧到底能做到什么（量化爆炸半径）

探针用 **`iframe.src = URL.createObjectURL(new Blob([html]))`** —— 与 foliate-js 加载书内容的方式（`epub.js createURL()` → `URL.createObjectURL`）一致。

| 探针 | 帧类型 | 观察模式结果（`run-obs3`） |
|---|---|---|
| `B1` | blob，**无 sandbox** | ✅ `Call.ByName GetSecret -> "TOP-SECRET-TOKEN-12345"` |
| `B2` | blob，`sandbox="allow-same-origin allow-scripts"`（**foliate-js 的组合**） | ✅ **读到密钥** |
| `B3` | blob，`sandbox="allow-scripts"`（不透明源） | ❌ `Failed to fetch dynamically imported module` → **桥不可达** |
| `B4` | blob，foliate-js 组合 → `WriteFile` | ✅ **落盘成功**，文件内容见下 |
| `B5` | blob，foliate-js 组合 → 读父窗口 | `typeof top.wails=object`、`top.document=READABLE`、`top.href` 可读 → **同源全通** |
| `B6` | blob，`allow-scripts` → 读父窗口 | `typeof top.wails=THREW:SecurityError`、`top.document=BLOCKED:SecurityError` |
| `B7` | blob，foliate-js 组合，伪造头 + 手写 body | HTTP **422**（`unknown bound method id 0`，我第一版 body 缺 `methodName`） |
| `B10` | blob，foliate-js 组合，**手写正确 body** | ✅ **HTTP 200 + `TOP-SECRET-TOKEN-12345`**（纯 fetch 即可调用绑定） |
| `B11` | 同 `B10` ＋ 伪造窗口头 | ✅ **HTTP 200 + 密钥**（伪造无用，但也**不需要**伪造） |
| `B8` | blob，`allow-scripts`，伪造头 | ❌ `TypeError: Failed to fetch`（CORS 拦住响应） |
| `B9` | **srcdoc** ＋ foliate-js 组合 | ❌ `TypeError: Failed to construct 'URL': Invalid URL`（srcdoc 的文档 URL 是 `about:srcdoc`，**不等价于 blob**） |

被不可信帧写出的文件（原文）：

```text
content written by an untrusted blob iframe2026-11-02T23:34:09.4953222+08:00 | written via bound Go method
```

runtime 调用的真实线上格式（从中间件抓到的 body，解释了 `methodName` 的作用）：

```json
{"object":0,"method":0,"args":{"call-id":"r1ESub5Nr2RdMfFfgxdjr","methodName":"main.SecretService.GetSecret","args":[]}}
```

**结论**：在当前布局下，**任何同源 blob 帧（含 foliate-js 的 `allow-same-origin allow-scripts` 组合）都能完整调用 Go 绑定并产生真实副作用**；而不透明源（仅 `allow-scripts`）会被浏览器 CORS 拦住导入与 fetch，但它**同时也让 foliate-js 无法工作**（`contentDocument` 为 null）。这与 task-7 的 A 部分结论一致。

---

## 5. Arch-B（L4）原型：只拒绝阅读器窗口

### 5.1 做法

中间件新增一条策略（与 nonce 策略并列）：

```go
// Arch-B policy: deny the reader window by its NATIVE window name.
// Safe to key on because application.go:397-400 uses Header().Set, so
// page JS cannot forge x-wails-window-name.
if rt && denyWindowName != "" && r.Header.Get("x-wails-window-name") == denyWindowName {
    decision = "block"
    denyReason = "window-name policy"
}
```

`main.go` 里开第二个窗口 `Name: "reader-window"`，URL `/?spike=reader`。**两次运行使用同一份前端产物**（两个窗口代码逐字节相同），唯一变量是 `SPIKE_DENY_WINDOW_NAME` —— 因此差异只能来自中间件策略。

### 5.2 原始结果

`evidence/run-archb-off`（**无策略**，对照组）：

```text
runtime calls by window identity: {"wid=1 name=main-window":{"pass":9,"block":0},
                                  "wid=2 name=reader-window":{"pass":9,"block":0}}
blocked calls: 0
```

`evidence/run-archb-on`（**策略 = 拒绝 reader-window**）：

```text
runtime calls by window identity: {"wid=1 name=main-window":{"pass":9,"block":0},
                                  "wid=2 name=reader-window":{"pass":0,"block":9}}
blocked calls: 9 | identities: ["reader-window"]
```

阅读器窗口内探针的原始结论（`run-archb-on`，被拒的那个窗口）：

```text
FAIL | D1-mainframe-call                    :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
FAIL | B1-blob-nosandbox-call               :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
FAIL | B2-blob-sandbox-sameorigin-scripts-call :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
FAIL | B4-blob-sameorigin-writefile         :: ERR=Error: 403 denied by spike middleware (no x-hpf-ipc nonce)
OK   | B7-...forge-headers                  :: HTTP 403
OK   | B10-blob-sameorigin-raw-fetch        :: HTTP 403
OK   | B11-...raw-fetch-forged              :: HTTP 403
```

主窗口（同一 run）**全部照常**：`D1 OK (Call.ByName -> "TOP-SECRET-TOKEN-12345")`、`B2 OK`、`B4 OK`、`B10 HTTP 200 + 密钥`。

**结论：Arch-B 可实施——按原生窗口名（不可伪造）即可把阅读器窗口的桥调用 100% 拒绝，同时主窗口不受影响。**

### 5.3 一个必须诚实说明的细节

`run-archb-on` 目录里 `pwned-from-iframe.txt` **仍然存在**。原因：**该文件由主窗口（`wid=1`，策略放行）内的探针帧写出**，不是被拒的阅读器窗口（`wid=2`，其 `B4` 返回 403）。对照 `run-block4`（全部拒绝）时该文件**不存在**，可反证策略确实生效。

### 5.4 已知不足（本 run 的）

源码里已加入 `?spike=reader` 快速分支，但 `run-archb-*` 两次运行使用的 `frontend/dist` **早于该改动**，所以阅读器窗口跑的是与主窗口完全相同的完整探针集（这也让对照更干净）。若要展示"阅读器窗口只跑 R1/R2 两条快速探针"，重新 `corepack pnpm run build` 后再跑一次即可（约 2 分钟），**不影响上述结论**。

---

## 6. server 模式与 curl（任务第 6 条）

### 6.1 桌面模式没有网络面

```powershell
$p = Start-Process bin\isolationspike.exe -PassThru
Start-Sleep 10
Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue
```
原始输出：

```text
=== TCP listeners owned by the app PID (desktop mode) ===
NONE - no TCP listener at all
```

→ **桌面模式无法用 curl 测试**（`wails.localhost` 由 WebView2 虚拟主机拦截，无 TCP 监听）。攻击面只有 webview 内部。

### 6.2 server 模式（`-tags server`）实测

原始命令与输出（`evidence/run-server2`）：

```text
=== T1: no Origin ===
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 22

TOP-SECRET-TOKEN-12345

=== T2: Origin http://evil.example ===
HTTP/1.1 403 Forbidden
X-Content-Type-Options: nosniff
Content-Length: 10

Forbidden

=== T3: forged x-wails-window-id 999 ===
HTTP/1.1 200 OK
Content-Length: 22

TOP-SECRET-TOKEN-12345
```

中间件的记录（同 run，原始行）：

```text
POST /wails/runtime rt=true decision=pass wid=""    wname="" origin=""                    <- T1：无 Origin
POST /wails/runtime rt=true decision=pass wid=""    wname="" origin="http://evil.example" <- T2：被中间件放行，随后被 Wails 拦
POST /wails/runtime rt=true decision=pass wid="999" wname="" origin=""                    <- T3：伪造头原样进入
```

**三项重要结论**：
1. **无 Origin 的非浏览器客户端被接受并返回密钥（200）** —— task-4 关于此点的判断得到实测确认。
2. Wails 的 server 侧 Origin 校验（`transport_http_server.go`）对 `Origin: http://evil.example` 生效（403 由 **Wails** 返回，body 是 `Forbidden` + `nosniff`，措辞与我的中间件不同）。
3. **顺序再次确认**：`T7`（带我的 nonce 但 `Origin` 非法）→ 先被中间件记为 `pass`，再被 Wails 403 → 用户中间件在外层。

`evidence/run-server-block` 的 nonce 对照：

```text
T5 (无 nonce)                    -> HTTP 403  403 denied by spike middleware (no x-hpf-ipc nonce)
T6 (带 x-hpf-ipc: SPIKE-NONCE-0001) -> HTTP 200  TOP-SECRET-TOKEN-12345
T7 (带 nonce + 非法 Origin)       -> HTTP 403  Forbidden   <- 被 Wails 拦
```

→ 中间件可以做到"**选择性放行 + 下游仍可二次校验**"。

---

## 7. 对 L4 / L5 的判定

| 论点 | 判定 | 依据 |
|---|---|---|
| 中间件可拦 `/wails/runtime` 并可拒绝 | ✅ **成立** | `2.2`、`2.3` |
| 顺序在 runtime handler 之前 | ✅ **成立** | `D1` 被 403；`T7` 中间件先记 pass |
| 窗口标识不可伪造 | ✅ **成立**（桌面）/ ❌ **不成立**（server） | `3.2`、`6.2 T3 |
| 可只拒绝某个窗口、主窗口不受影响 | ✅ **成立** | `5.2`（9/9 vs 9/9） |
| 帧粒度可区分 | ❌ **不成立** | `stream.go:831` 官方自述 iframe 共享同 id；实测所有帧 `wid=1` |
| **L4 可实施** | ✅ **成立** | 上述合并 |

**因此：客户端渲染架构走 L4（阅读器窗口独立 + 中间件按窗口限权 + 窄接口）在技术上是可行的，不必仅因 C-01/C-09 退回 L5。**

### 但 L4 **不等于**隔离完成（残余风险）

1. **书内容与宿主同源**：`B5` 实测 `top.document=READABLE`、`typeof top.wails=object` → 同一窗口内的帧可直接摸到父窗口对象与 DOM。L4 只限制"**桥**"，不限制"**DOM/JS**"。
2. **因此 L4 必须与 CSP/净化叠加**（task-7 的 L2/L3）：一旦书文档里出现可执行脚本（`allow-scripts` 在 foliate-js 下似乎必需），它虽拿不到桥，但仍可窃取同窗口内 DOM 中的渲染数据、发起同源请求。
3. **同一阅读器窗口内的"合法"组件与书内容共享同一个窗口身份** → L4 的授权粒度是**窗口**，窗口内谁在调桥无法区分。所以阅读器窗口暴露的窄接口必须**本身安全**（不接受任意路径、不返回敏感数据）。
4. **server 模式完全另外一套**：无原生注入 → 窗口头被伪造（`6.2 T3`），且无 Origin 的客户端直接 200（`6.2 T1`）。**不要把 L4 的窗口授权机制当作 server 模式的安全依据。**

---

## 8. 如果 C-01/C-09 都失败，L5 结构化渲染要多少工作量（粗估）

> **注意**：本次两门**都通过**，所以 L5 **不需要**启动。以下仅按要求给出"若转 L5"的量级判断，属**工程粗估（未验证）**，无官方来源。

| 模块 | 内容 | 粗估 |
|---|---|---|
| 解析 → 安全内部模型 | 仍可复用 foliate-js 的 loader/`epub.js` 解析，但把输出从"HTML 文档"改为受控块/行内模型 + 样式白名单 | 2–3 人周 |
| 排版引擎 | 自建分页/双栏/纵向（放弃 `View` 与 `contentDocument`，改在 Vue 里渲染 + 测量） | 2–3 人周 |
| 定位与进度 | foliate-js 的 CFI 依赖 `Document`；改用 EPUB CFI 子集 / Locator 或自建模型定位 | 1–2 人周 |
| 划词/高亮/批注 | 自建 selection 与标注渲染 | 1.5–2 人周 |
| 目录/脚注/内链/搜索定位 | 基于新模型重做 | 0.5–1 人周 |
| 书籍 CSS 保真度损失 + 兼容测试 | 结构化渲染必然损失原书排版，需大量语料回归 | 1–2 人周 |
| 迁移与联调 | 与现有阅读器功能对齐（含 TXT/PDF/MOBI 分支） | 2–3 人周 |
| **合计** | | **≈10–16 人周**（单人 2.5–4 个月）；若接受"排版保真度明显下降"可压到 **≈7–9 人周** |

补充：**PDF 不受此影响**（pdf.js 走 canvas，本就不是 foliate-js 的 iframe 管线）；**TXT 走结构化渲染几乎零成本**；**MOBI 需先转 EPUB**，因此 L5 的成本主要压在 **EPUB 的排版保真度**上。

---

## 9. 不确定 / 未验清单（如实）

| # | 项 | 状态 |
|---|---|---|
| 1 | WebView2 之外的平台（WKWebView / WebKitGTK / Android WebView）上中间件与头注入行为是否一致 | **未验**（本次仅 Windows + WebView2） |
| 2 | `allow-scripts` 能否从 foliate-js 的 sandbox 中去掉（WebKit Bug 218086 现状） | **未验**（task-7 的 L3 门槛，需跨平台实测） |
| 3 | 恶意 EPUB 的完整杀伤链（含 `transformTarget` 净化 + meta CSP 的实际拦截率） | **未验**（本次只验证"能否调桥"，未做 CSP 注入实测） |
| 4 | server 模式 `checkRuntimeRequest` 的确切 Origin 判定规则（为何漏过"无 Origin"） | **未验**：行为已实测，源码规则未逐行确认 |
| 5 | `?spike=reader` 快速分支未重新构建进 `dist`（见 `5.4） | **已知不足**，不影响结论 |
| 6 | 中间件对**请求体**的改写（如剥离 args）是否对分块上传路径也有效 | **未验**（本次只验证读取与拒绝） |

---

## 10. 结论一句话

> **C-01 成立**：`AssetOptions.Middleware` 包裹整个 asset server，实测位于 runtime handler 之前，可完全拒绝 `/wails/runtime`，且拒绝后真实副作用（落盘）消失。
> **C-09 成立**：`x-wails-window-id/name` 由原生 `Header().Set` 覆盖注入，帧内伪造无效（实测恒为 `wid=1 main-window`）；但 `x-wails-client-id` 是 JS 自填、**原样透传，不可信**；server 模式下更无注入，窗口头完全可伪造。
> **L4 可实施**：双窗口实测"主窗口 9/9 放行、阅读器窗口 9/9 拦截"，且桌面模式无 TCP 监听。
> **但 L4 只是"限制桥"**：书帧与宿主同源（`top.document` 可读），因此 **L4 必须与 CSP/净化（task-7 的 L2/L3）叠加**，且阅读器窗口的窄接口自身必须安全。

**文档结束** · 相关：`spikes/isolation/README.md`（复现说明）、`docs/research/70-isolation-feasibility.md`（task-7）、`docs/ADR-003-内容隔离架构.md`（`9 为本结论）。
