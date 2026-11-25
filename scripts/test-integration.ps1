# HPF-Reader Server <-> Client 全面集成测试脚本
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\scripts\test-integration.ps1
#   pwsh -File .\scripts\test-integration.ps1 -ApiBase http://127.0.0.1:8080

param(
  [string]$ApiBase = 'http://127.0.0.1:8080',
  [string]$CaddyBase = 'https://localhost',
  [switch]$RunSmokeDocker
)

$ErrorActionPreference = 'Stop'
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " HPF-Reader Server-Client Integration Test" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. 验证 Docker 后端运行状态
Write-Host "`n[1/3] 检查 Docker 后端容器状态..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "deploy")
try {
  $running = docker compose ps --format '{{.Service}}: {{.Status}}'
  if (-not $running) {
    Write-Warning "未检测到运行中的 Docker Compose 服务，尝试启动..."
    docker compose up -d
    Start-Sleep -Seconds 3
  } else {
    Write-Host "容器运行正常:" -ForegroundColor Green
    $running | ForEach-Object { Write-Host "  -> $_" }
  }
} finally {
  Pop-Location
}

# 2. (可选) 运行 Docker 容器内部 95 项端到端冒烟测试
if ($RunSmokeDocker) {
  Write-Host "`n[2/3] 运行 Docker 内部 95 项端到端冒烟测试..." -ForegroundColor Yellow

  # ★ 本产品不提供公开注册（服务端连 /v1/auth/register 都不注册），
  #   冒烟脚本跑在 alpine 里既没有 psql 也没有 docker CLI，无法自己建号。
  #   因此由这里在 api 容器内用 createuser 预置账号，再把口令传进容器。
  $smokePassword = 'smoke-test-password-9x'
  $runTag = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $smokeEmail = "smoke-$runTag@example.com"
  $quotaEmail = "quota-$runTag@example.com"
  $jobEmail = "job-$runTag@example.com"
  $composeFile = Join-Path $rootDir "deploy/docker-compose.yml"

  foreach ($addr in @($smokeEmail, $quotaEmail, $jobEmail)) {
    # 口令走 stdin（--password-stdin），不进命令行、不进日志。
    # 用 compose run 而不是 docker exec：api 服务本身没有 shell（distroless），
    # 但 createuser 是二进制自带的子命令，可以直接覆盖 entrypoint 参数执行。
    $null = $smokePassword | docker compose -f $composeFile run --rm -T api `
      createuser --email $addr --password-stdin 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "createuser $addr 失败（可能已存在，继续执行）"
    }
  }

  $smokePath = (Join-Path $rootDir "tests/smoke/smoke-test.sh").Replace('\', '/')
  docker run --rm --network hpf-reader_edge `
    -e "SMOKE_EMAIL=$smokeEmail" `
    -e "SMOKE_PASSWORD=$smokePassword" `
    -e "SMOKE_QUOTA_EMAIL=$quotaEmail" `
    -e "SMOKE_JOB_EMAIL=$jobEmail" `
    -v "${smokePath}:/smoke.sh:ro" alpine:3.20 `
    sh -c "apk add --no-cache curl >/dev/null && sh /smoke.sh"
} else {
  Write-Host "`n[2/3] 跳过 Docker 内部冒烟测试（指定 -RunSmokeDocker 参数可启用）" -ForegroundColor DarkGray
}

# 3. 运行客户端与服务端跨端集成测试套件 (72 项断言)
Write-Host "`n[3/3] 启动 Client-Server 全链路集成测试套件..." -ForegroundColor Yellow
$runnerScript = Join-Path $rootDir "tests\integration\run-all.mjs"

$env:HPF_API_BASE = $ApiBase
$env:HPF_CADDY_BASE = $CaddyBase
$env:HPF_ROOT = $rootDir

& node $runnerScript
if ($LASTEXITCODE -ne 0) {
  Write-Error "集成测试套件执行失败，退出代码: $LASTEXITCODE"
  exit $LASTEXITCODE
}

Write-Host "`n==========================================" -ForegroundColor Green
Write-Host " [SUCCESS] All Integration Tests Passed!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
