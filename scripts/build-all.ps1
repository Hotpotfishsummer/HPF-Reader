# HPF-Reader build script
param (
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "    HPF-Reader Full Build & Verification" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Dev environment
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envScript = Join-Path $scriptDir "dev-env.ps1"
if (Test-Path $envScript) {
    . $envScript
}

$rootDir = Split-Path -Parent $scriptDir

# 2. Frontend
Write-Host "`n[1/3] Building and testing Frontend (Vue 3 + Vite)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client/frontend")
try {
    if (-not $SkipTests) {
        Write-Host "  -> Running frontend unit tests..."
        corepack pnpm run test
    }
    Write-Host "  -> Running typecheck and production build..."
    corepack pnpm run build
    Write-Host "  [OK] Frontend build succeeded!" -ForegroundColor Green
} finally {
    Pop-Location
}

# 3. Server
Write-Host "`n[2/3] Building and testing Server (Go)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/server")
try {
    if (-not $SkipTests) {
        Write-Host "  -> Running server unit tests..."
        go test ./... -count=1
    }
    Write-Host "  -> Compiling server binaries..."
    if (-not (Test-Path "bin")) { New-Item -ItemType Directory -Path "bin" | Out-Null }
    go build -trimpath -o bin/api.exe ./cmd/api
    go build -trimpath -o bin/migrate.exe ./cmd/migrate
    Write-Host "  [OK] Server build succeeded!" -ForegroundColor Green
} finally {
    Pop-Location
}

# 4. Client
Write-Host "`n[3/3] Building Client executable (Wails v3)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "apps/client")
try {
    Write-Host "  -> Running client vet..."
    go vet ./...
    Write-Host "  -> Compiling client executable (GUI mode, no terminal)..."
    if (-not (Test-Path "bin")) { New-Item -ItemType Directory -Path "bin" | Out-Null }
    go build -trimpath -tags production -ldflags="-w -s -H windowsgui" -o bin/hpfreader.exe .
    Copy-Item bin/hpfreader.exe client.exe -Force
    Write-Host "  [OK] Client build succeeded (client.exe & bin/hpfreader.exe)!" -ForegroundColor Green
} finally {
    Pop-Location
}

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host " [SUCCESS] Full build completed successfully!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
