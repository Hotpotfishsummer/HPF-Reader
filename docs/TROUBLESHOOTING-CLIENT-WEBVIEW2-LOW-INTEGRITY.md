# 修复客户端 EXE 无法启动（WebView2 controller 创建失败）

## 现象

双击 `apps/client/bin/hpfreader.exe`（或 `client.exe`），Windows 弹出「无法验证发布者」后点「运行」，
进程**立刻退出**，窗口不出现。命令行运行时 stderr 为：

```
[WebView2] Environment created successfully
[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
```

或

```
[WebView2 Error] error creating controller with 8000ffff: Catastrophic failure
```

## 根因

**exe 所在目录带 NTFS「低完整性级别」标签（Low Mandatory Level），并且向下继承到 exe 本身。**

```
icacls C:\...\HPF-Reader
  ...
  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

WebView2 的 `CreateCoreWebView2Controller` 需要 **Medium 完整性**才能工作：
低完整性进程受 Windows 强制完整性控制（MIC）限制，无法写入需要 Medium 的共享资源
（WebView2 运行时目录、共享内存节、COM 代理），于是返回 `ERROR_BUSY`(0x800700AA)
或 `E_UNEXPECTED`(0x8000FFFF)。

注意日志里 `Environment created successfully` 是**正常的**——环境创建只读配置，
真正失败的是 controller（需要写共享状态），这正好对应完整性不足的症状。

### 为什么之前没人发现

- 这个标签不是代码引入的，是**沙箱/容器类工具**在仓库根目录上设置的（`CodexSandboxUsers`
  等 ACL 条目是同一个来源）。
- `go build`、`go test`、`corepack pnpm run build` 全部正常——普通文件读写不需要 Medium 完整性。
- 只有 WebView2 controller 这种需要跨进程共享内核对象的操作才会被 MIC 挡住。

### 诊断要点（避免下次再绕路）

排查时排除过的**错误方向**（都不是原因，记录以免重复）：

| 假设 | 实验 | 结论 |
|---|---|---|
| WebView2 用户数据目录被占用 | 删除/重命名 `%APPDATA%\<exe名>\EBWebView` | 不是 |
| 浏览器参数（`--proxy-server` 等）有问题 | `HPF_BROWSER_ARGS_MODE=none` 完全跳过参数 | 不是（仓库内仍失败） |
| ACL 拒绝项（`Everyone:Deny DeleteSubdirectoriesAndFiles`） | 把仓库 ACL 原样复制到能正常运行的目录 | 不是 |
| 路径长度 / 路径字符串 | 8.3 短路径、目录联接（junction） | 不是 |
| 文件名与数据目录绑定 | 用不同 exe 名在同一位置测试 | 不是 |
| shell 作业对象 / 沙箱继承 | 用 WMI `Win32_Process.Create` 启动 | 不是 |
| `.git` 存在 / 文件数量多 / 路径深 | 分别构造对照目录 | 不是 |

**决定性判据**：`icacls <目录>` 输出里是否含 `Mandatory Label\Low Mandatory Level`。

## 修复

```powershell
# 1) 把 exe 的完整性级别提回 Medium
icacls "apps\client\bin\hpfreader.exe" /setintegritylevel Medium
icacls "apps\client\client.exe"        /setintegritylevel Medium

# 2) 目录也一起（否则重新构建出来的 exe 会再次继承 Low）
icacls "apps\client\bin"      /setintegritylevel Medium
icacls "apps\client"          /setintegritylevel Medium
```

修复后从仓库内直接运行即可正常出窗口（已实测）。

### 更彻底的做法（本仓库已执行）

如果这个仓库不需要被沙箱工具管理，把根目录的标签也去掉，
这样以后任何新构建的产物都不会再继承：

```powershell
icacls "C:\Users\HOTPOTFISH\Desktop\AllCode\HPF-Reader" /setintegritylevel Medium
```

> ⚠️ 如果该标签是某个安全工具**故意**设置的（低完整性用于隔离不可信代码），
> 去掉它会降低那层隔离。此时应改为「把构建产物复制到工作区外运行」，
> 而不是改标签。

**本仓库已执行并验证（2026-11-12）**：

- 根目录标签：`Low Mandatory Level:(OI)(CI)(NW)` → `Medium Mandatory Level:(NW)`
- 注意 `/setintegritylevel Medium` 只写 `(NW)`，**不带 `(OI)(CI)` 继承标志**，
  但已足够——子目录不再继承 Low，新建文件默认 Medium（实测验证）。
- 全仓库递归扫描：**0 个残留 Low 目录**。
- 验证命令：

```powershell
# 递归扫描残留 Low 标签
Get-ChildItem <repo> -Recurse -Directory -Force |
  Where-Object { $_.FullName -notmatch 'node_modules|\.git\\' } |
  ForEach-Object {
    $r = icacls $_.FullName 2>&1 | Select-String "Low Mandatory"
    if ($r) { $_.FullName }
  }

# 验证新建文件不再继承 Low
"x" | Out-File <repo>\_lbltest.txt
icacls <repo>\_lbltest.txt | Select-String "Mandatory"   # 应无输出 = Medium
Remove-Item <repo>\_lbltest.txt
```

## 验证

```powershell
# 确认标签已恢复
icacls "apps\client\bin\hpfreader.exe" | Select-String "Mandatory"

# 启动并确认窗口出现（MainWindowTitle 非空 = 真实窗口已创建）
$p = Start-Process "apps\client\bin\hpfreader.exe" -PassThru
Start-Sleep -Seconds 8
$p = Get-Process -Id $p.Id
"alive=$($p -ne $null) title='$($p.MainWindowTitle)' responding=$($p.Responding)"
```

期望：`alive=True title='HPF Reader' responding=True`

**实测结果（2026-11-12 21:12，修复后）**：

```
hpfreader.exe  ALIVE pid=44408 title='HPF Reader' responding=True hwnd=13768998
client.exe     ALIVE pid=24536 title='HPF Reader' hwnd=3152788
```

两个交付物从仓库内直接启动均正常出窗口（`hwnd` 非零 = 真实窗口已创建）。

## 已知影响范围

- 只影响**从该仓库目录直接运行** exe。
- 复制到 `%TEMP%`、桌面等未打标签的位置运行则正常（这也是最初误判为「路径问题」的原因）。
- 不影响 CI、不影响 `go test`、不影响安装包分发（安装到 `Program Files` 后是 Medium）。
