<#
.SYNOPSIS
    A/B 验证「服务端提前回响应时，上传过程会不会被掐断」。

.DESCRIPTION
    场景：同一份字节的**第二次**上传会走服务端的"秒传"分支 ——
    服务端已经存有这份字节 ⇒ 直接回 200，**不再收请求体**。

    ★ 关键差异：
        旧服务端：handler 没读完 body 就返回 ⇒ Go 的 http.Server 关闭连接 ⇒
                  浏览器（以及本脚本的裸 socket）正在写的字节被打断 ⇒
                  "上传卡住 / network_error"。
        新服务端：先把请求体读完（丢弃）再回响应 ⇒ 整份字节顺利送达。

    ★ 为什么不用 curl：curl 对"提前回响应"是宽容的（照样拿到 200、退出码 0），
      测不出这个 bug。这里用 scripts/verify-upload-connection.js（裸 socket），
      它复刻浏览器的行为：持续写 body，并观察写入端有没有被对端打断。

    用法（需要两个服务端二进制）：
      pwsh -File .\scripts\verify-upload-dedup-ab.ps1 `
        -OldExe "$env:TEMP\hpf-api.exe" -NewExe "$env:TEMP\hpf-api-new.exe"
#>
[CmdletBinding()]
param(
    [string]$OldExe = '',
    [string]$NewExe = '',
    [int]$Port = 8123,
    [string]$PsqlContainer = 'hpf-pg'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $OldExe -or -not $NewExe) { Write-Error 'OldExe 与 NewExe 都要给'; exit 2 }

$env:DATABASE_URL = 'postgres://hpf:hpf@127.0.0.1:5432/hpf_reader?sslmode=disable'
$env:HPF_JWT_SECRET = 'local-verify-secret-0123456789-abcdefghijklmnop'

function Invoke-Api {
    param([string]$Method, [string]$Path, [string]$Token = '', $Body = $null)
    $params = @{ Method = $Method; Uri = "http://127.0.0.1:$Port$Path"; UseBasicParsing = $true; TimeoutSec = 60 }
    if ($Token) { $params['Headers'] = @{ Authorization = "Bearer $Token" } }
    if ($null -ne $Body) { $params['Body'] = ($Body | ConvertTo-Json -Compress); $params['ContentType'] = 'application/json' }
    return Invoke-RestMethod @params
}

function Test-UploadConnection {
    param([string]$Exe, [string]$Label)
    $env:HPF_ADDR = "127.0.0.1:$Port"
    $env:HPF_STORAGE_DIR = Join-Path $env:TEMP "hpf-ab-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $out = Join-Path $env:TEMP "hpf-ab-$Label.out"
    $err = Join-Path $env:TEMP "hpf-ab-$Label.err"
    $proc = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    try {
        Start-Sleep -Seconds 3
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 10

        $email = "ab-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
        $reg = Invoke-Api -Method POST -Path '/v1/auth/register' -Body @{ email = $email; password = 'Verify-Passw0rd!' }
        $token = $reg.accessToken
        if ($PsqlContainer) {
            $null = docker exec $PsqlContainer psql -U hpf -d hpf_reader -c "UPDATE users SET quota_bytes = 268435456 WHERE email = '$email'" 2>&1
        }

        # 8MB 随机内容（大于任何默认 socket 缓冲 ⇒ 一定会出现"写一半"）。
        $tmp = Join-Path $env:TEMP "hpf-ab-$([guid]::NewGuid().ToString('N')).bin"
        $bytes = New-Object byte[] (8MB)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        [System.IO.File]::WriteAllBytes($tmp, $bytes)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

        $book = Invoke-Api -Method POST -Path '/v1/books' -Token $token -Body @{ title = 'AB Dedup Book'; format = 'epub' }
        # ★ 首次上传必须发**原始字节**（走 -Body $bytes，不能走 JSON 转换）。
        $null = Invoke-WebRequest -Method PUT -Uri "http://127.0.0.1:$Port/v1/books/$($book.id)/file?contentHash=sha256:$hash" `
            -Headers @{ Authorization = "Bearer $token" } -Body $bytes -ContentType 'application/epub+zip' `
            -UseBasicParsing -TimeoutSec 120

        # 第二次 ⇒ 秒传分支（服务端提前回 200）。
        $nodeOut = & node scripts/verify-upload-connection.js $tmp '127.0.0.1' $Port "/v1/books/$($book.id)/file?contentHash=sha256:$hash" $token 2>&1
        $code = $LASTEXITCODE
        Remove-Item $tmp -ErrorAction SilentlyContinue

        $ok = $code -eq 0
        Write-Host ("  {0}  {1}  exit={2}  {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $Label, $code, ($nodeOut -join ' | '))
        return $ok
    }
    finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        Start-Sleep -Seconds 1
    }
}

Write-Host "`n== 上传连接不被掐断 A/B（裸 socket，模拟浏览器） ==" -ForegroundColor Cyan
$oldOk = Test-UploadConnection -Exe $OldExe -Label 'old(no drain fix)'
$newOk = Test-UploadConnection -Exe $NewExe -Label 'new(drain fix)'

Write-Host ("`n旧服务端：{0}    新服务端：{1}" -f $(if ($oldOk) { '整份 body 送达' } else { '★ 上传被掐断' }), $(if ($newOk) { '整份 body 送达' } else { '★ 上传被掐断' })) -ForegroundColor Cyan
if ($newOk -and -not $oldOk) {
    Write-Host '结论：服务端"提前回响应但不读完请求体"正是上传被掐断的根因；读完请求体后即修复。' -ForegroundColor Green
    exit 0
}
if ($newOk -and $oldOk) {
    Write-Host '结论：两个版本都没被掐断（该场景未复现差异）。' -ForegroundColor Yellow
    exit 0
}
Write-Host '结论：★ 新服务端仍失败，需要继续排查。' -ForegroundColor Red
exit 1
