# HPF-Reader 证据采集器：把「构建 / 兼容审计 / 单测 / E2E」的原始命令与原始输出
# 逐条落盘到 tests/evidence/client/，作为交付证据（不是构建产物）。
#
# 位置：tests/tools/capture-evidence.ps1（测试工具，与 apps/ 内的生产代码分开放）
# 用法（任意 cwd 均可，脚本自己定位仓库根）：
#   pwsh -NoProfile -File tests/tools/capture-evidence.ps1
#   pwsh -NoProfile -File tests/tools/capture-evidence.ps1 -SkipE2E
param(
  [switch]$SkipE2E
)

$ErrorActionPreference = 'Continue'

# tests/tools -> tests -> <repo root>
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontend = Join-Path $repoRoot 'apps/client/frontend'
$evidenceDir = Join-Path $repoRoot 'tests/evidence/client'
$log = Join-Path $evidenceDir 'task-14-compat-raw-output.txt'

if (-not (Test-Path $frontend)) { throw "找不到前端目录: $frontend" }
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('HPF-Reader task-14 / task-12 - raw commands and raw output')
$lines.Add(('=' * 78))
$lines.Add("collected: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))")
$lines.Add("repo root: $repoRoot")
$lines.Add("run cwd  : $((Get-Location).Path)")
$lines.Add("node: $(& node --version)   pnpm: $(& corepack pnpm --version)")

# 所有命令都在前端包内执行（pnpm 脚本、playwright.config.ts、audit 的相对路径都以此为准）。
Push-Location $frontend
try {
  function Section([string]$title, [string]$cmd) {
    $lines.Add('')
    $lines.Add('### ' + $title)
    $lines.Add('$ ' + $cmd)
    $lines.Add(('-' * 78))
    $script:LASTEXITCODE = 0
    $out = & cmd /c "$cmd 2>&1"
    foreach ($line in $out) { $lines.Add([string]$line) }
    $lines.Add('[exit code] ' + $script:LASTEXITCODE)
  }

  Section 'build (vue-tsc --noEmit && vite build --mode production)' 'corepack pnpm run build'
  Section 'audit src --chrome 91' 'node scripts/audit-builtins.mjs src --chrome 91'
  Section 'audit dist --chrome 91' 'node scripts/audit-builtins.mjs dist --chrome 91'
  Section 'unit tests (vitest run)' 'corepack pnpm run test'
  if (-not $SkipE2E) {
    Section 'e2e (playwright test)' 'corepack pnpm run test:e2e'
  }
}
finally {
  Pop-Location
}

$lines | Set-Content -Path $log -Encoding UTF8
Write-Output ("written: $log  " + (Get-Item $log).Length + ' bytes')
Write-Output '--- tail ---'
Get-Content $log -Encoding UTF8 | Select-Object -Last 10
