$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
$ev = '..\evidence'
New-Item -ItemType Directory -Force -Path $ev | Out-Null
$log = Join-Path $ev 'task-14-compat-raw-output.txt'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('HPF-Reader task-14 / task-12 - raw commands and raw output')
$lines.Add(('=' * 78))
$lines.Add("collected: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))")
$lines.Add("cwd: $((Get-Location).Path)")
$lines.Add("node: $(& node --version)   pnpm: $(& corepack pnpm --version)")

function Section([string]$title, [string]$cmd) {
  $lines.Add('')
  $lines.Add('### ' + $title)
  $lines.Add('$ ' + $cmd)
  $lines.Add(('-' * 78))
  $out = & cmd /c "$cmd 2>&1"
  foreach ($line in $out) { $lines.Add([string]$line) }
  $lines.Add('[exit code] ' + $LASTEXITCODE)
}

Section 'build (vue-tsc --noEmit && vite build --mode production)' 'corepack pnpm run build'
Section 'audit src --chrome 91' 'node scripts/audit-builtins.mjs src --chrome 91'
Section 'audit dist --chrome 91' 'node scripts/audit-builtins.mjs dist --chrome 91'
Section 'unit tests (vitest run)' 'corepack pnpm run test'
Section 'e2e (playwright test)' 'corepack pnpm run test:e2e'

$lines | Set-Content -Path $log -Encoding UTF8
Write-Output ("written: $log  " + (Get-Item $log).Length + ' bytes')
Write-Output '--- tail ---'
Get-Content $log -Encoding UTF8 | Select-Object -Last 10