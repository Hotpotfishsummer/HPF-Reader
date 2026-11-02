# HPF-Reader 开发环境（本机已探测的确切路径）
# 用法:  . .\scripts\dev-env.ps1     (注意前面的点，表示在当前会话生效)

$env:HPF_GO      = 'C:\Users\HOTPOTFISH\go-portable\go\bin'
$env:HPF_GOBIN   = Join-Path $env:USERPROFILE 'go\bin'
$env:HPF_WAILS3  = Join-Path $env:HPF_GOBIN 'wails3.exe'
$env:HPF_JDK     = 'C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'
$env:HPF_ANDROID = Join-Path $env:LOCALAPPDATA 'Android\Sdk'

$env:PATH = ($env:HPF_GO + ';' + $env:HPF_GOBIN + ';' + $env:PATH)
$env:GOTOOLCHAIN = 'auto'
$env:JAVA_HOME = $env:HPF_JDK
$env:ANDROID_HOME = $env:HPF_ANDROID
$env:ANDROID_SDK_ROOT = $env:HPF_ANDROID

Write-Host 'HPF-Reader env ready' -ForegroundColor Green
Write-Host ('  go      : ' + (& $env:HPF_GO\go.exe version))
Write-Host ('  wails3  : ' + (& $env:HPF_WAILS3 version))
Write-Host ('  pnpm    : use  corepack pnpm <args>')
Write-Host ('  java    : ' + $env:JAVA_HOME)
Write-Host ('  android : ' + $env:ANDROID_HOME)

# 常用:
#   服务端:   cd apps\server; go run ./cmd/api
#   客户端:   cd apps\client; & $env:HPF_WAILS3 dev
#   容器:     docker compose -f deploy\docker-compose.yml up -d