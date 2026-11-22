<#
.SYNOPSIS
  可重复执行的同步端到端联调入口（task-13）。

.DESCRIPTION
  1) 校验真实公版书 sha256；2) 重置联调库与文件存储（保证 201/去重证据可重复）；
  3) 用 vite 打包并运行 spikes/sync/e2e.ts（真实 HTTP + 真实 Postgres）；
  4) 导出数据库侧原始查询结果。
  所有原始输出都会落在 spikes/sync/evidence/ 下。

.EXAMPLE
  pwsh -File spikes/sync/run-e2e.ps1
  pwsh -File spikes/sync/run-e2e.ps1 -SkipReset   # 保留上一轮数据
#>
param(
  [string]$Base = 'http://127.0.0.1:18080',
  [string]$PgContainer = 'hpf-sync-pg',
  [string]$PgUser = 'hpf',
  [string]$PgDatabase = 'hpf_reader',
  [switch]$SkipReset
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$evidence = Join-Path $PSScriptRoot 'evidence'
$book = Join-Path $root 'tests\fixtures\books\frankenstein.epub'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $evidence 'bookfiles') | Out-Null
$runLog = Join-Path $evidence 'run-log.txt'

"### 运行开始 $(Get-Date -Format o)" | Tee-Object -FilePath $runLog
"### 真实书：$book" | Tee-Object -FilePath $runLog -Append
(Get-FileHash -Algorithm SHA256 -Path $book) | Format-List | Out-String | Tee-Object -FilePath $runLog -Append
(Get-FileHash -Algorithm SHA256 -Path $book) | Format-List | Out-String | Set-Content -Path (Join-Path $evidence 'book-sha256.txt')

Write-Host '--- 0) 服务端健康检查 ---'
$health = Invoke-WebRequest -UseBasicParsing -Uri "$Base/healthz" -TimeoutSec 10
"healthz: $($health.StatusCode) $($health.Content)" | Tee-Object -FilePath $runLog -Append

if (-not $SkipReset) {
  Write-Host '--- 1) 重置联调库 + 文件存储 ---'
  $sqlPath = Join-Path $PSScriptRoot 'reset.sql'
  docker cp $sqlPath "${PgContainer}:/tmp/reset.sql" | Out-Null
  $resetOut = docker exec $PgContainer psql -U $PgUser -d $PgDatabase -v ON_ERROR_STOP=1 -f /tmp/reset.sql 2>&1
  ($resetOut | Out-String) | Tee-Object -FilePath $runLog -Append
  Get-ChildItem (Join-Path $evidence 'bookfiles') -Recurse -File -ErrorAction SilentlyContinue | Remove-Item -Force
  "stored blobs after reset: $((Get-ChildItem (Join-Path $evidence 'bookfiles') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count)" | Tee-Object -FilePath $runLog -Append
}

Write-Host '--- 2) 运行 e2e（vite 打包 + node 执行） ---'
$env:HPF_SPIKE_BASE = $Base
$env:HPF_SPIKE_ROOT = $root
$env:HPF_SPIKE_OUT = $evidence
$env:HPF_SPIKE_BOOK = $book
node (Join-Path $PSScriptRoot 'run-e2e.mjs') 2>&1 | Tee-Object -FilePath (Join-Path $evidence 'e2e-run.log')
$e2eExit = $LASTEXITCODE

Write-Host '--- 3) 数据库侧原始证据 ---'
$q = Join-Path $PSScriptRoot 'evidence-queries.sql'
docker cp $q "${PgContainer}:/tmp/evidence-queries.sql" | Out-Null
$dbOut = docker exec $PgContainer psql -U $PgUser -d $PgDatabase -f /tmp/evidence-queries.sql 2>&1
($dbOut | Out-String) | Tee-Object -FilePath (Join-Path $evidence 'db-evidence.txt')
($dbOut | Out-String) | Tee-Object -FilePath $runLog -Append

"### e2e 退出码: $e2eExit" | Tee-Object -FilePath $runLog -Append
exit $e2eExit
