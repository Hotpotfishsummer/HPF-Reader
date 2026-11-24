# HPF-Reader 版本号读取与一致性校验
#
# 版本号的唯一权威源是 apps/client/frontend/package.json 的 "version" 字段。
# Release 流程（.github/workflows/release.yml）只认这个值：tag 形如 v<version>，
# 该 tag 不存在时才构建并发布。
#
# 为了避免「exe 属性里还是旧版本号」这类不一致，这里同时校验下面几处必须与权威源相同：
#   - apps/client/appservice.go            AppVersion 常量（前端「关于」页显示的版本）
#   - apps/client/build/windows/info.json  Windows PE 文件/产品版本（exe 右键属性里看到的）
#
# 用法：
#   ./scripts/get-version.ps1            # 一致时输出版本号（如 0.2.0），不一致时抛错
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootDir = Split-Path -Parent $scriptDir

$pkgPath = Join-Path $rootDir 'apps/client/frontend/package.json'
$appPath = Join-Path $rootDir 'apps/client/appservice.go'
$infoPath = Join-Path $rootDir 'apps/client/build/windows/info.json'

$version = (Get-Content -Raw -LiteralPath $pkgPath | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw "invalid version '$version' in $pkgPath (expected semver like 0.2.0)"
}

$appMatch = Select-String -LiteralPath $appPath -Pattern 'const AppVersion\s*=\s*"([^"]+)"'
if (-not $appMatch) {
    throw "AppVersion constant not found in $appPath"
}
$appVersion = $appMatch.Matches[0].Groups[1].Value

$infoVersion = (Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json).'fixed'.product_version

$mismatches = @()
if ($appVersion -ne $version) { $mismatches += "apps/client/appservice.go            AppVersion = `"$appVersion`"" }
if ($infoVersion -ne $version) { $mismatches += "apps/client/build/windows/info.json  product_version = `"$infoVersion`"" }

if ($mismatches.Count -gt 0) {
    throw @"
version mismatch: package.json says "$version" but:
  $($mismatches -join "`n  ")
Update them to the same value (see scripts/get-version.ps1 header).
"@
}

# 只输出版本号本身，方便调用方 $v = ./scripts/get-version.ps1
$version
