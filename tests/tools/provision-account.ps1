<#
.SYNOPSIS
    在服务端创建测试账号（走运维路径 `api createuser`）。

.DESCRIPTION
    ★ 为什么需要这个文件：
      本产品**不提供公开注册**。客户端只有登录入口，服务端连
      /v1/auth/register 路由都不注册（见 apps/server/internal/httpapi/no_register_test.go）。
      账号只能由运维在服务器上执行 `api createuser --email ...` 创建。

      黑盒测试原本靠「先 POST /v1/auth/register 建号再跑用例」自举，
      现在必须改成走同一条运维路径 —— 否则测的是一条已经不存在的能力，
      或者更糟：为了测试方便又把注册端点加回去。

    用法（在测试脚本里 dot-source）：

        . "$PSScriptRoot\..\tools\provision-account.ps1"
        New-TestAccount -Email $email -Password $password -ApiExe $ApiExe -DatabaseUrl $DatabaseUrl

    口令通过 stdin 传入（createuser --password-stdin），不会出现在进程参数里。

.NOTES
    环境变量（都可被显式参数覆盖）：
      HPF_TEST_API_EXE        api 可执行文件路径
      HPF_TEST_DATABASE_URL   数据库连接串
#>

function Resolve-ApiExe {
    <#
      找一个能执行 createuser 的 api 可执行文件。
      顺序：显式参数 → 环境变量 → 仓库内已构建产物 → PATH。
    #>
    param([string]$ApiExe)

    $candidates = @()
    if ($ApiExe) { $candidates += $ApiExe }
    if ($env:HPF_TEST_API_EXE) { $candidates += $env:HPF_TEST_API_EXE }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $candidates += (Join-Path $repoRoot 'apps\server\bin\api.exe')
    $candidates += (Join-Path $repoRoot 'apps\server\bin\api')

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
    }

    $onPath = Get-Command 'api' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    throw @'
找不到 api 可执行文件，无法创建测试账号。

先构建服务端：
  cd apps/server; go build -trimpath -o bin/api.exe ./cmd/api

或用 -ApiExe / HPF_TEST_API_EXE 显式指定。
'@
}

function New-TestAccount {
    <#
      .PARAMETER Email
      .PARAMETER Password      至少 8 位
      .PARAMETER DisplayName   可选
      .PARAMETER ApiExe        可选，覆盖自动探测
      .PARAMETER DatabaseUrl   可选，覆盖 $env:DATABASE_URL
      .PARAMETER AllowExisting 已存在时不报错（测试重跑同一邮箱时用）
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Email,
        [Parameter(Mandatory = $true)][string]$Password,
        [string]$DisplayName = '',
        [string]$ApiExe = '',
        [string]$DatabaseUrl = '',
        [switch]$AllowExisting
    )

    if ([string]::IsNullOrWhiteSpace($Email)) { throw 'New-TestAccount: -Email 不能为空' }
    if ($Password.Length -lt 8) { throw "New-TestAccount: 口令至少 8 位（$Email）" }

    $exe = Resolve-ApiExe -ApiExe $ApiExe

    $dbUrl = $DatabaseUrl
    if ([string]::IsNullOrWhiteSpace($dbUrl)) { $dbUrl = $env:DATABASE_URL }
    if ([string]::IsNullOrWhiteSpace($dbUrl)) {
        throw 'New-TestAccount: 需要数据库连接串（-DatabaseUrl 或 $env:DATABASE_URL）'
    }

    $argList = @('createuser', '--email', $Email, '--password-stdin')
    if ($DisplayName) { $argList += @('--name', $DisplayName) }

    $prevDb = $env:DATABASE_URL
    $env:DATABASE_URL = $dbUrl
    try {
        # 口令走 stdin：不进命令行、不进 shell 历史、不进 ps 输出。
        $output = $Password | & $exe @argList 2>&1
        $code = $LASTEXITCODE
    } finally {
        $env:DATABASE_URL = $prevDb
    }

    $text = ($output | Out-String).Trim()
    if ($code -ne 0) {
        if ($AllowExisting -and $text -match 'already exists|duplicate|conflict') {
            Write-Host "  [provision] 账号已存在，复用：$Email" -ForegroundColor DarkGray
            return
        }
        throw "createuser 失败（退出码 $code）：$text"
    }

    Write-Host "  [provision] 已创建账号：$Email" -ForegroundColor DarkGray
}
