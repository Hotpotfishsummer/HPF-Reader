<#
.SYNOPSIS
  启动同步联调用的本地服务端（一次性 Postgres 容器 + 迁移 + API）。

.DESCRIPTION
  刻意**不复用** deploy/docker-compose.yml 的 hpf-reader_pgdata 卷：那是团队共享/其它任务在用的数据，
  本脚本用独立容器 + 独立端口 + 独立存储目录，避免互相污染。
  minio 镜像本机不可用，因此把对象存储切到 local 驱动（HPF_STORAGE_DRIVER=local）。

.EXAMPLE
  pwsh -File spikes/sync/start-server.ps1
  pwsh -File spikes/sync/start-server.ps1 -Port 18080 -PgPort 55432
#>
param(
  [string]$Container = 'hpf-sync-pg',
  [int]$PgPort = 55432,
  [int]$Port = 18080,
  [string]$PgUser = 'hpf',
  [string]$PgPassword = 'SyncTest2026_pw',
  [string]$PgDatabase = 'hpf_reader',
  [string]$GoBin = 'C:\Users\HOTPOTFISH\go-portable\bin'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$server = Join-Path $root 'apps\server'
$storage = Join-Path $PSScriptRoot 'evidence\bookfiles'
New-Item -ItemType Directory -Force -Path $storage | Out-Null

$env:GOTOOLCHAIN = 'auto'                                  # go.mod 要求 go 1.26.0，本地是 1.22.10
$env:GOPROXY = 'https://goproxy.cn,direct'
if (Test-Path $GoBin) { $env:PATH = "$GoBin;$env:PATH" }

Write-Host '--- Postgres（独立容器，独立端口） ---'
$existing = docker ps -a --filter "name=$Container" --format '{{.Names}}'
if (-not $existing) {
  docker run -d --name $Container -p "${PgPort}:5432" `
    -e POSTGRES_USER=$PgUser -e POSTGRES_PASSWORD=$PgPassword -e POSTGRES_DB=$PgDatabase `
    pgvector/pgvector:pg16 | Out-Null
}
# 等就绪
for ($i = 0; $i -lt 30; $i++) {
  docker exec $Container pg_isready -U $PgUser -d $PgDatabase *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
docker exec $Container pg_isready -U $PgUser -d $PgDatabase

$env:DATABASE_URL = "postgres://${PgUser}:${PgPassword}@127.0.0.1:${PgPort}/${PgDatabase}?sslmode=disable"

Write-Host '--- 迁移 ---'
Push-Location $server
try {
  go run ./cmd/migrate
  go run ./cmd/migrate -status
} finally {
  Pop-Location
}

Write-Host '--- API（前台运行；联调脚本在另一个终端跑） ---'
$env:HPF_ADDR = ":${Port}"
$env:HPF_ENV = 'dev'
$env:HPF_JWT_SECRET = 'local-spike-secret-please-change-0123456789'
$env:HPF_STORAGE_DRIVER = 'local'
$env:HPF_STORAGE_DIR = $storage
$env:HPF_AI_PROVIDER = 'fake'
$env:HPF_LOG_FORMAT = 'json'
$env:HPF_AUTO_MIGRATE = 'true'
Push-Location $server
try {
  go run ./cmd/api
} finally {
  Pop-Location
}
