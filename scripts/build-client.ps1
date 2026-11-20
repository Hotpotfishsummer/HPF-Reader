# HPF-Reader Client Build Script
# 自动构建客户端前端产物并编译最新版 Windows exe (client.exe / bin/hpfreader.exe)

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

# ★ 原生命令（npm / go / wails3）失败**不会**被 $ErrorActionPreference='Stop' 捕获：
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

# 2. 构建前端
Write-Host "`n[1/2] Building Frontend (Vue 3 + Vite)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client/frontend")
try {
    # 先删掉 dist：即便命令"看起来没跑"，也不会留下旧产物冒充新构建。
    if (Test-Path dist) { Remove-Item -Recurse -Force dist }
    Invoke-Checked -Label "npm run build" -Command { npm run build }
    if (-not (Test-Path (Join-Path (Get-Location) "dist/index.html"))) {
        throw "frontend build produced no dist/index.html"
    }
    Write-Host "  [OK] Frontend build succeeded!" -ForegroundColor Green
} finally {
    Pop-Location
}

# 3. 编译 Go 客户端并嵌入最新前端
Write-Host "`n[2/2] Compiling Client Windows Executable..." -ForegroundColor Yellow
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

    # 产物一致性自检：两个 exe 必须字节一致，且必须是刚刚构建出来的。
    $clientHash = (Get-FileHash client.exe -Algorithm SHA256).Hash
    $binHash = (Get-FileHash bin/hpfreader.exe -Algorithm SHA256).Hash
    if ($clientHash -ne $binHash) {
        throw "client.exe and bin/hpfreader.exe differ ($clientHash vs $binHash)"
    }
    $built = Get-Item client.exe
    Write-Host "  [OK] client.exe == bin/hpfreader.exe ($($built.Length) bytes, $($built.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')), sha256 $($clientHash.Substring(0,16))...)" -ForegroundColor Green
} finally {
    Remove-Item wails_windows_amd64.syso -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host " [SUCCESS] Client exe build complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
