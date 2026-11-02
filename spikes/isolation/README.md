
# spikes/isolation — Wails v3 隔离 PoC（task-10）

验证两个决定性问题的**最小可复现工程**：

* **C-01** — 通过 `application.AssetOptions.Middleware` 挂载的自建中间件，能否拦到 `/wails/runtime`、是否在 runtime handler **之前**、能否据此**拒绝**请求。
* **C-09** — 从 iframe 内**伪造** `x-wails-window-id` / `x-wails-window-name` / `x-wails-client-id`，Go 侧看到的是**伪造值**还是**原生注入的真值**。

**结论与全部原始命令/输出见 [RESULTS.md](./RESULTS.md)。** 本文件只讲"怎么跑起来"。

> ⚠️ **这是 PoC，不是产品代码。** `SecretService` 是**故意设置的特权服务**（返回密钥、读写任意路径），用来量化"不可信渲染层能造成多大破坏"。请勿照搬进产品。
> 相对路径的 `WriteFile` 会被限制在 `evidence/<run>/` 目录内，避免误伤其他文件。

---

## 目录结构

```text
spikes/isolation/
├── RESULTS.md                     # ★ 交付：每条的原始命令 + 原始输出 + 判定
├── README.md                      # 本文件
└── IsolationSpike/
    ├── main.go                    # 两个窗口：main-window / reader-window（Arch-B 原型）
    ├── secret_service.go          # 特权服务：GetSecret / WriteFile / ReadFile
    ├── ipc_middleware.go          # ★ 被测中间件：逐请求证据 + 可选拒绝策略
    ├── greetservice.go            # 模板自带
    ├── frontend/
    │   ├── src/main.ts            # ★ 探针（帧内 blob: 加载，自动上报，无需人工操作）
    │   └── public/, index.html, ...
    ├── bin/                       # 构建产物（isolationspike.exe / -server.exe）
    └── evidence/                  # ★ 每次运行的原始证据（jsonl 日志 + 落盘文件）
```

---

## 前置

| 依赖 | 版本（本次实测） |
|---|---|
| Go | 1.22.10 → 自动切 1.26.0 工具链 |
| Wails CLI | v3.1.0（`C:\Users\HOTPOTFISH\go\bin\wails3.exe`） |
| Node / pnpm | v24.20.0 ／ 12.16.1（**必须用 `corepack pnpm`**） |
| OS | Windows 11 + WebView2（桌面模式）；server 模式跨平台 |

---

## 构建

```powershell
$env:PATH = 'C:\Users\HOTPOTFISH\go-portable\go\bin;' + $env:PATH
$env:GOTOOLCHAIN = 'auto'
$env:GOPROXY = 'https://goproxy.cn,direct'
$WAILS = 'C:\Users\HOTPOTFISH\go\bin\wails3.exe'

cd spikes\isolation\IsolationSpike

# bindings（2 Services / 4 Methods）
& $WAILS generate bindings -ts -i -clean=true

# 前端
cd frontend
corepack pnpm install
corepack pnpm run build
cd ..

# 桌面 + server 两种二进制
go build -o bin\isolationspike.exe .
go build -tags server -o bin\isolationspike-server.exe .
```

> 桌面二进制用 `//go:embed all:frontend/dist` 内嵌前端 → **改完前端必须重新 `corepack pnpm run build` 再 `go build`**，否则跑的是旧产物（RESULTS.md `5.4 记录了本次踩到这个坑的地方）。

---

## 环境变量（控制策略）

| 变量 | 作用 |
|---|---|
| `SPIKE_EVIDENCE_DIR` | 证据输出目录（**建议每次运行用独立目录**，绝对路径） |
| `SPIKE_BLOCK=1` | 中间件对**所有**缺少 `x-hpf-ipc` nonce 的 `/wails/runtime` 返回 **403** |
| `SPIKE_IPC_NONCE` | 允许通过的口令（默认 `SPIKE-NONCE-0001`；请求头 `x-hpf-ipc` 需与其相等） |
| `SPIKE_DENY_WINDOW_NAME` | **Arch-B 策略**：按**原生窗口名**拒绝该窗口的全部 runtime 调用（例：`reader-window`） |

> 实现细节：nonce 默认值非空是**必要**的。若为 `""`，则 `Header.Get("x-hpf-ipc")` 也返回 `""`，`!=` 比较会**静默放行所有请求**——本次开发中真实踩过这个 bug（见 RESULTS.md `2.3 前后的观察/阻断对照）。

---

## 跑实验

### 1) 观察模式（只记录，不拦）

```powershell
$env:SPIKE_EVIDENCE_DIR = (Resolve-Path 'evidence\run-obs').Path
$env:SPIKE_BLOCK = '0'
Remove-Item Env:\SPIKE_IPC_NONCE -ErrorAction SilentlyContinue
Remove-Item Env:\SPIKE_DENY_WINDOW_NAME -ErrorAction SilentlyContinue

$p = Start-Process bin\isolationspike.exe -PassThru -RedirectStandardOutput 'evidence\run-obs\stdout.log' -RedirectStandardError 'evidence\run-obs\stderr.log'
Start-Sleep -Seconds 45          # 前端自动跑完全部探针并上报
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
```

**无需任何人工操作**：`frontend/src/main.ts` 载入后自动创建 `blob:` 帧、跑 13 条探针，并把结论 POST 到 `/spike/report`（该路由由中间件自己处理，因此即使 `/wails/runtime` 被完全封锁，**结果仍能落盘**）。

### 2) 阻断模式（验证能否拒绝）

同上，但 `$env:SPIKE_BLOCK = '1'`。预期：全部 runtime 调用 **403**，且 `pwned-from-iframe.txt` **不生成**。

### 3) Arch-B 策略模式（只拒阅读器窗口）

```powershell
$env:SPIKE_BLOCK = '0'
$env:SPIKE_DENY_WINDOW_NAME = 'reader-window'
```
预期：`main-window`（wid=1）**全部放行**；`reader-window`（wid=2）**全部 403**。用 `SPIKE_DENY_WINDOW_NAME=''` 跑一次作对照。

### 4) server 模式 + curl

```powershell
$env:SPIKE_EVIDENCE_DIR = (Resolve-Path 'evidence\run-server').Path
$p = Start-Process bin\isolationspike-server.exe -PassThru -RedirectStandardError 'evidence\run-server\stderr.log'
Start-Sleep -Seconds 12           # 默认监听 localhost:8080

$BODY = '{"object":0,"method":0,"args":{"call-id":"curl-probe","methodName":"main.SecretService.GetSecret","args":[]}}'

# 无 Origin（非浏览器客户端）
curl.exe -s -i -X POST 'http://localhost:8080/wails/runtime' -H 'Content-Type: application/json' -d $BODY
# 伪造 Origin
curl.exe -s -i -X POST 'http://localhost:8080/wails/runtime' -H 'Content-Type: application/json' -H 'Origin: http://evil.example' -d $BODY
# 伪造窗口头
curl.exe -s -i -X POST 'http://localhost:8080/wails/runtime' -H 'Content-Type: application/json' -H 'x-wails-window-id: 999' -d $BODY
# 带 nonce（需 SPIKE_BLOCK=1 才有区分度）
curl.exe -s -i -X POST 'http://localhost:8080/wails/runtime' -H 'Content-Type: application/json' -H 'x-hpf-ipc: SPIKE-NONCE-0001' -d $BODY
Stop-Process -Id $p.Id -Force
```

> **桌面模式不能用 curl**：实测 `Get-NetTCPConnection -OwningProcess <pid>` → **无任何 TCP 监听**（`wails.localhost` 由 WebView2 虚拟主机拦截）。

---

## 证据文件怎么读

| 文件 | 内容 |
|---|---|
| `requests.jsonl` | 中间件**逐请求**记录：method / path / `is_runtime_call` / `decision`（pass·block·handled-by-middleware）/ 四个关键头（`hdr_window_id`、`hdr_window_name`、`hdr_client_id`、`hdr_origin`）/ `headers_all` / **runtime 调用的原始 body** |
| `probe-results.jsonl` | 前端探针结论，经 `/spike/report` 上报；每条为 `{"report":{...}}`，含 `phase=start/final` 与 `outcomes[]` |
| `pwned-from-iframe.txt` | 由**不可信帧**经 Go 绑定写出的**真实副作用**证明 |
| `stderr.log` | Go 侧启动日志（`evidence dir`、`block mode`、Wails `Build Info`、server 监听地址） |

一条典型记录：

```json
{"ts":"...","handler":"middleware","kind":"request","method":"POST","path":"/wails/runtime","is_runtime_call":true,"decision":"pass","block_mode":false,"hdr_window_id":"1","hdr_window_name":"main-window","hdr_client_id":"FORGED-CLIENT-ID","hdr_origin":"http://wails.localhost","body":"{\"object\":0,\"method\":0,\"args\":{\"call-id\":\"...\",\"methodName\":\"main.SecretService.GetSecret\",\"args\":[]}}"}
```

→ `hdr_window_id` 恒为 `1`（伪造无效），`hdr_client_id` 为 `FORGED-CLIENT-ID`（伪造有效）。

---

## 探针清单（`frontend/src/main.ts`）

| ID | 帧加载方式 / sandbox | 测什么 |
|---|---|---|
| `D1` / `D2` | 主帧 | 基线合法调用 ／ 主帧伪造头 |
| `B1` | `blob:`，无 sandbox | `Call.ByName` 读密钥 |
| `B2` | `blob:`，`allow-same-origin allow-scripts`（**foliate-js 组合**） | 同上（**关键**） |
| `B3` | `blob:`，`allow-scripts`（不透明源） | 能否导入 runtime 模块 |
| `B4` | `blob:`，foliate-js 组合 | `WriteFile` 真实落盘 |
| `B5` / `B6` | 同上 / 不透明源 | `window.top.wails`、`top.document` 可达性 |
| `B7` / `B11` | `blob:`，foliate-js 组合 | **伪造**窗口头 + 手写 body |
| `B8` | `blob:`，`allow-scripts` | 不透明帧伪造头（预期 CORS 拦截） |
| `B9` | **`srcdoc`**，foliate-js 组合 | 证明 `srcdoc` **不等价**于 `blob:` |
| `B10` | `blob:`，foliate-js 组合 | 手写正确 body 的**纯 fetch** 调绑定 |

> `blob:` 是刻意的选择：foliate-js 的 `epub.js createURL()` 正是用 `URL.createObjectURL` 把书内容喂给 `iframe.src`。

---

## 已知不足

1. 仅测 **Windows + WebView2**；WKWebView / WebKitGTK / Android WebView 未验（见 RESULTS.md `9）。
2. `?spike=reader` 快速分支已写入 `main.ts`，但 `run-archb-*` 两次运行使用的是**改动前**的 `dist`（两窗口跑同一套完整探针）。这不影响 Arch-B 结论（反而让对照更干净），重新 `pnpm run build` 即可启用。
3. `SecretService.WriteFile` 接受绝对路径以展示能力无边界，但 PoC 只传相对名。
4. 未做 CSP / `transformTarget` 净化实测（那是 task-7 的 L2/L3 范畴）。
`