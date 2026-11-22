# HPF-Reader 全栈构建管线（开发更新后的强制构建入口）
#
# 规则：任何开发更新（前端 / 客户端 Go / 服务端 Go）完成后，必须运行本脚本，
#       一次性重建「前端 dist + 服务端 exe + 客户端 exe」，全部成功才能交付。
#       绝不允许只重建 dist 而不重编 exe（exe 里嵌的是编译时的旧 dist）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File ./scripts/build-all.ps1
#   powershell -ExecutionPolicy Bypass -File ./scripts/build-all.ps1 -SkipTests
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $scriptDir

# 1. 加载开发环境（Go / wails3 / JDK / Android SDK）
$envScript = Join-Path $scriptDir "dev-env.ps1"
if (Test-Path $envScript) {
    . $envScript
}

# ★ 原生命令（pnpm / go / wails3）失败**不会**被 $ErrorActionPreference='Stop' 捕获：
#   必须显式检查 $LASTEXITCODE。否则前端构建失败时脚本照样继续，把**旧 dist** 打进新 exe
#   （二进制时间戳是新的、代码是旧的）。这类"假成功"必须从脚本层面堵死。
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

function Assert-Artifact {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path $Path)) {
        throw "$Label not found at $Path"
    }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -le 0) {
        throw "$Label is empty at $Path"
    }
    Write-Host "  [OK] $Label -> $Path ($($item.Length) bytes, $($item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')), sha256 $((Get-Sha256 $Path).Substring(0,16))...)" -ForegroundColor Green
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

$startedAt = Get-Date
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "    HPF-Reader Full Build & Verification" -ForegroundColor Cyan
Write-Host "    $($startedAt.ToString('yyyy-MM-dd HH:mm:ss'))  (tests: $(if ($SkipTests) {'skipped'} else {'on'}))" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# ---------------------------------------------------------------
# [1/3] 前端：从源码全新重建 dist
# ---------------------------------------------------------------
Write-Host ""
Write-Host "[1/3] Frontend (Vue 3 + Vite): rebuild dist" -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client/frontend")
try {
    # 先删掉 dist：即便构建"看起来没跑"，也绝不留下旧产物冒充新构建。
    if (Test-Path dist) { Remove-Item -Recurse -Force dist }
    if (-not $SkipTests) {
        Write-Host "  -> frontend unit tests (vitest)..."
        Invoke-Checked -Label "frontend test" -Command { corepack pnpm run test }
    }
    Write-Host "  -> typecheck + production build (vue-tsc + vite)..."
    Invoke-Checked -Label "frontend build" -Command { corepack pnpm run build }
    Assert-Artifact -Path (Join-Path (Get-Location) "dist/index.html") -Label "frontend dist/index.html"
    # 记录主入口产物路径，稍后验证它被嵌进了 exe。
    $indexText = Get-Content -Raw -LiteralPath (Join-Path (Get-Location) "dist/index.html")
    $assetMatch = [regex]::Match($indexText, 'assets/index-[A-Za-z0-9_.-]+')
    if (-not $assetMatch.Success) {
        throw "could not find main asset path in dist/index.html"
    }
    $mainAsset = $assetMatch.Value
} finally {
    Pop-Location
}

# ---------------------------------------------------------------
# [2/3] 服务端：编译 Go 二进制（api.exe / migrate.exe）
# ---------------------------------------------------------------
Write-Host ""
Write-Host "[2/3] Server (Go): compile binaries" -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/server")
try {
    if (-not $SkipTests) {
        Write-Host "  -> server unit tests (go test)..."
        Invoke-Checked -Label "server test" -Command { go test ./... -count=1 }
    }
    if (-not (Test-Path bin)) { New-Item -ItemType Directory -Path bin | Out-Null }
    Write-Host "  -> compile api.exe / migrate.exe..."
    Invoke-Checked -Label "go build api.exe" -Command { go build -trimpath -o bin/api.exe ./cmd/api }
    Invoke-Checked -Label "go build migrate.exe" -Command { go build -trimpath -o bin/migrate.exe ./cmd/migrate }
    Assert-Artifact -Path (Join-Path (Get-Location) "bin/api.exe") -Label "server bin/api.exe"
    Assert-Artifact -Path (Join-Path (Get-Location) "bin/migrate.exe") -Label "server bin/migrate.exe"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------
# [3/3] 客户端：编译桌面 exe，嵌入最新 dist，并同步 client.exe
# ---------------------------------------------------------------
Write-Host ""
Write-Host "[3/3] Client (Wails v3): compile desktop exe" -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client")
try {
    Write-Host "  -> go vet..."
    Invoke-Checked -Label "go vet" -Command { go vet ./... }
    if (-not (Test-Path bin)) { New-Item -ItemType Directory -Path bin | Out-Null }
    # 生成 Windows PE 资源（图标 / 版本信息 / DPI 感知 Manifest）并嵌入 exe
    Write-Host "  -> generate Windows PE resources (.syso)..."
    Invoke-Checked -Label "wails3 generate syso" -Command {
        wails3 generate syso -arch amd64 -icon build/windows/icon.ico -manifest build/windows/wails.exe.manifest -info build/windows/info.json -out wails_windows_amd64.syso
    }
    Write-Host "  -> compile hpfreader.exe (production, embedded latest dist)..."
    Invoke-Checked -Label "go build client" -Command {
        go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
    }
    Copy-Item bin/hpfreader.exe client.exe -Force
    Assert-Artifact -Path (Join-Path (Get-Location) "bin/hpfreader.exe") -Label "client bin/hpfreader.exe"
    Assert-Artifact -Path (Join-Path (Get-Location) "client.exe") -Label "client client.exe"
    # 产物一致性自检：两份 exe 必须字节一致。
    $binHash = Get-Sha256 (Join-Path (Get-Location) "bin/hpfreader.exe")
    $exeHash = Get-Sha256 (Join-Path (Get-Location) "client.exe")
    if ($binHash -ne $exeHash) {
        throw "client.exe and bin/hpfreader.exe differ ($exeHash vs $binHash)"
    }
    # ★ 新鲜度自检：确认刚构建的 dist 主产物确实被嵌入了 exe（防止"只编译了 dist"）。
    Assert-EmbeddedAsset -ExePath (Join-Path (Get-Location) "bin/hpfreader.exe") -AssetPath $mainAsset
    Assert-EmbeddedAsset -ExePath (Join-Path (Get-Location) "client.exe") -AssetPath $mainAsset
    Write-Host "  [OK] client.exe == bin/hpfreader.exe" -ForegroundColor Green
} finally {
    Remove-Item wails_windows_amd64.syso -ErrorAction SilentlyContinue
    Pop-Location
}

$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " [SUCCESS] Full build pipeline complete in $elapsed s" -ForegroundColor Green
Write-Host " [RULE] 开发更新后请运行: powershell -ExecutionPolicy Bypass -File ./scripts/build-all.ps1" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
