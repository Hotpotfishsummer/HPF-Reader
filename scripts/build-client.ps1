# HPF-Reader Client Build Script
# 自动构建客户端前端产物并编译最新版 Windows exe (client.exe / bin/hpfreader.exe)
#
# 规则：任何前端或客户端 Go 代码更新后，交付前必须运行本脚本。
#       它强制「先重建 dist，再重编 exe」，并从二进制里验证最新前端产物确实被嵌入，
#       从脚本层面杜绝"只更新了 dist、exe 里还是旧前端"的假成功。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File ./scripts/build-client.ps1

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $scriptDir

# 1. 加载开发环境 (Go, Wails, etc.)
$envScript = Join-Path $scriptDir "dev-env.ps1"
if (Test-Path $envScript) {
    . $envScript
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "    HPF-Reader Client Auto-Build (EXE)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# ★ 原生命令（pnpm / go / wails3）失败**不会**被 $ErrorActionPreference='Stop' 捕获：
#   必须显式检查 $LASTEXITCODE。曾经的坑：前端 vue-tsc 报错 → npm run build 失败 →
#   脚本照样打印 [OK] 并继续 go build，于是把一个**旧 dist** 打进了新 exe，
#   二进制看起来是新的（时间戳更新），实际前端代码是旧的。这类"假成功"必须从脚本层面堵死。
function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash
}

# 从二进制里验证给定的前端产物路径（如 /assets/index-XXXX.js）确实被嵌入。
function Assert-EmbeddedAsset {
    param(
        [Parameter(Mandatory = $true)][string]$ExePath,
        [Parameter(Mandatory = $true)][string]$AssetPath
    )
    $bytes = [System.IO.File]::ReadAllBytes($ExePath)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if (-not $text.Contains($AssetPath)) {
        throw "$ExePath does not embed the freshly built asset '$AssetPath' (stale frontend embedded?)"
    }
    Write-Host "  [OK] $ExePath embeds fresh asset '$AssetPath'" -ForegroundColor Green
}

# 2. 构建前端
Write-Host ""
Write-Host "[1/2] Building Frontend (Vue 3 + Vite)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client/frontend")
try {
    # 先删掉 dist：即便命令"看起来没跑"，也不会留下旧产物冒充新构建。
    if (Test-Path dist) { Remove-Item -Recurse -Force dist }
    # 统一用 corepack pnpm（仓库为 pnpm 布局，直接用 npm 会破坏 node_modules 链接树）。
    Invoke-Checked -Label "pnpm run build" -Command { corepack pnpm run build }
    $indexHtml = Join-Path (Get-Location) "dist/index.html"
    if (-not (Test-Path $indexHtml)) {
        throw "frontend build produced no dist/index.html"
    }
    # 取出 index.html 里主入口 JS 的产物路径，稍后验证它被嵌进了 exe。
    $indexText = Get-Content -Raw -LiteralPath $indexHtml
    $assetMatch = [regex]::Match($indexText, 'assets/index-[A-Za-z0-9_.-]+')
    if (-not $assetMatch.Success) {
        throw "could not find main asset path in dist/index.html"
    }
    $mainAsset = $assetMatch.Value
    Write-Host "  [OK] Frontend build succeeded (main asset: $mainAsset)!" -ForegroundColor Green
} finally {
    Pop-Location
}

# 3. 编译 Go 客户端并嵌入最新前端
Write-Host ""
Write-Host "[2/2] Compiling Client Windows Executable..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client")
try {
    if (-not (Test-Path "bin")) {
        New-Item -ItemType Directory -Path "bin" | Out-Null
    }
    # 生成 Windows 资源文件 (.syso)，将应用程序图标、版本信息及 Manifest (DPI感知) 打包嵌入 exe
    Write-Host "  -> Generating Windows PE resources (.syso) with custom icon & manifest..." -ForegroundColor Cyan
    Invoke-Checked -Label "wails3 generate syso" -Command {
        wails3 generate syso -arch amd64 -icon build/windows/icon.ico -manifest build/windows/wails.exe.manifest -info build/windows/info.json -out wails_windows_amd64.syso
    }

    Invoke-Checked -Label "go build" -Command {
        go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
    }
    Copy-Item bin/hpfreader.exe client.exe -Force

    # 产物一致性自检：两个 exe 必须字节一致。
    $clientHash = Get-Sha256 (Join-Path (Get-Location) "client.exe")
    $binHash = Get-Sha256 (Join-Path (Get-Location) "bin/hpfreader.exe")
    if ($clientHash -ne $binHash) {
        throw "client.exe and bin/hpfreader.exe differ ($clientHash vs $binHash)"
    }

    # ★ 新鲜度自检：确认刚构建的 dist 主产物确实被嵌入了 exe（防止"只编译了 dist"）。
    Assert-EmbeddedAsset -ExePath (Join-Path (Get-Location) "bin/hpfreader.exe") -AssetPath $mainAsset
    Assert-EmbeddedAsset -ExePath (Join-Path (Get-Location) "client.exe") -AssetPath $mainAsset

    $built = Get-Item client.exe
    Write-Host "  [OK] client.exe == bin/hpfreader.exe ($($built.Length) bytes, $($built.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')), sha256 $($clientHash.Substring(0,16))...)" -ForegroundColor Green
} finally {
    Remove-Item wails_windows_amd64.syso -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " [SUCCESS] Client exe build complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
