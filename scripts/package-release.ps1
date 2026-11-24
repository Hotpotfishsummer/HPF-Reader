# HPF-Reader Release 打包脚本（在 build-all.ps1 成功之后运行）
#
# 把 build-all.ps1 产出的二进制整理成可直接上传到 GitHub Release 的文件：
#   dist/release/HPF-Reader-<version>-windows-amd64.exe              桌面客户端（内嵌最新前端）
#   dist/release/HPF-Reader-<version>-server-windows-amd64.zip        服务端 api.exe + migrate.exe
#   dist/release/SHA256SUMS.txt                                       上述文件的 SHA-256
#
# 用法：
#   ./scripts/package-release.ps1
#   ./scripts/package-release.ps1 -OutDir D:\somewhere
param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $scriptDir
if (-not $OutDir) { $OutDir = Join-Path $rootDir 'dist/release' }

$version = & (Join-Path $scriptDir 'get-version.ps1')

$exe = Join-Path $rootDir 'apps/client/bin/hpfreader.exe'
$api = Join-Path $rootDir 'apps/server/bin/api.exe'
$migrate = Join-Path $rootDir 'apps/server/bin/migrate.exe'
foreach ($p in @($exe, $api, $migrate)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "missing build artifact '$p' (run scripts/build-all.ps1 first)" }
}

# 只清空输出目录里的旧文件（目录本身保留）
if (Test-Path -LiteralPath $OutDir) {
    Get-ChildItem -LiteralPath $OutDir -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$clientName = "HPF-Reader-$version-windows-amd64.exe"
$serverName = "HPF-Reader-$version-server-windows-amd64.zip"

Copy-Item -LiteralPath $exe -Destination (Join-Path $OutDir $clientName)

$stage = Join-Path ([System.IO.Path]::GetTempPath()) "hpf-reader-server-$version"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item -LiteralPath $api, $migrate -Destination $stage
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $OutDir $serverName)
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# 以 GitHub Release 资产的下载文件名为准生成校验和（顺序与目录枚举顺序无关）
$sums = Get-ChildItem -LiteralPath $OutDir -File | Sort-Object Name | ForEach-Object {
    $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$h  $($_.Name)"
}
Set-Content -LiteralPath (Join-Path $OutDir 'SHA256SUMS.txt') -Value $sums -Encoding ascii

Write-Host "Release $version packaged into $OutDir" -ForegroundColor Green
Get-ChildItem -LiteralPath $OutDir -File | ForEach-Object {
    Write-Host ("  {0,-52} {1,10:N0} bytes" -f $_.Name, $_.Length)
}
