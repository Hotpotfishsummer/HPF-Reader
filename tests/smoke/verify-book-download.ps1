<#
.SYNOPSIS
    验证「书籍上传 / 下载」链路的真实行为（黑盒，端到端）。

.DESCRIPTION
    这是 tests/smoke/smoke-test.sh 里第 3 段（书籍与文件）的加强版：
    smoke 用随机字节 + Range 只验证状态码，这里用**真实书籍文件**验证
    「下载回来的字节与上传的字节逐字节相同」，并补齐 smoke 没覆盖的分支：

      ① 完整下载的 sha256 == 上传时的 sha256（字节级一致，不是"看起来对"）
      ② Content-Length == 实际字节数
      ③ ETag 二次请求 → 304（缓存语义正确）
      ④ Range 请求 → 206 且字节与原文件对应区间一致
      ⑤ 还没上传文件的书 → 404（不是 500，也不是 200 空 body）
      ⑥ 别人的书 → 404（不泄露存在性）
      ⑦ 未登录 → 401
      ⑧ 建书时声明的 contentHash 与列表里返回的格式一致（sha256:<hex>）

    用法（先起好服务端）：
      pwsh -File .\tests\smoke\verify-book-download.ps1 -Base http://127.0.0.1:8099
      pwsh -File .\tests\smoke\verify-book-download.ps1 -Base http://127.0.0.1:8099 -Book ..\fixtures\books\frankenstein.epub
#>
[CmdletBinding()]
param(
    [string]$Base = 'http://127.0.0.1:8099',
    # ★ 参数名必须是 $BookPath 而不是 $Book：PowerShell 变量名**大小写不敏感**，
    #   后面的局部变量 $book（建书 API 的响应）会和它撞名，
    #   结果被 [string] 类型约束强制转成字符串，`.id` 取不到 → 后续 PUT 打到
    #   /v1/books//file → 405 "Method Not Allowed"。
    [string]$BookPath = (Join-Path $PSScriptRoot '..\fixtures\books\frankenstein.epub'),
    # 配额用例需要一个能改用户 quota_bytes 的数据库通道（本地 docker postgres）。
    # 传空字符串则跳过该用例（不失败，只提示）。
    [string]$PsqlContainer = 'hpf-pg',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$script:Pass = 0
$script:Fail = 0
$script:Results = @()

function Write-Result {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) { $script:Pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else { $script:Fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
    $script:Results += [pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }
}

function Check-Equal {
    param([string]$Name, $Actual, $Expected)
    $ok = "$Actual" -eq "$Expected"
    Write-Result -Name $Name -Ok $ok -Detail "got=[$Actual] want=[$Expected]"
}

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Token = '',
        $Body = $null,
        [byte[]]$Bytes = $null,
        [hashtable]$Headers = @{}
    )
    $uri = "$Base$Path"
    $params = @{
        Method      = $Method
        Uri         = $uri
        UseBasicParsing = $true
        TimeoutSec  = 120
    }
    if ($Token) { $params['Headers'] = @{ Authorization = "Bearer $Token" } }
    if ($Headers.Count -gt 0) {
        $h = @{}
        if ($Token) { $h['Authorization'] = "Bearer $Token" }
        foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
        $params['Headers'] = $h
    }
    if ($null -ne $Bytes) {
        $params['Body'] = $Bytes
        $params['ContentType'] = 'application/epub+zip'
    }
    elseif ($null -ne $Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress)
        $params['ContentType'] = 'application/json'
    }
    $resp = Invoke-RestMethod @params -ResponseHeadersVariable respHeaders -StatusCodeVariable st
    # 状态码/响应头带回调用方（-StatusCodeVariable 在函数作用域里，外层看不到）。
    $script:LastStatus = $st
    $script:LastHeaders = $respHeaders
    return $resp
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

# ---------------------------------------------------------------- 准备
if (-not (Test-Path $BookPath)) { throw "找不到测试书籍：$BookPath" }
$resolvedBookPath = (Resolve-Path $BookPath).Path
$bytes = [System.IO.File]::ReadAllBytes($resolvedBookPath)
$hash = Get-Sha256Hex -Bytes $bytes
$size = $bytes.Length

Write-Host "== 准备 ==" -ForegroundColor Cyan
Write-Host "  书籍文件 : $resolvedBookPath"
Write-Host "  字节数   : $size"
Write-Host "  sha256   : $hash"

$email = "verify-$([guid]::NewGuid().ToString('N').Substring(0,12))@example.com"
$password = 'verify-pass-0123456789'

# ---------------------------------------------------------------- 建号
Write-Host "`n== 1. 账号 ==" -ForegroundColor Cyan
$reg = Invoke-Api -Method POST -Path '/v1/auth/register' -Body @{ email = $email; password = $password; displayName = 'Verify' }
$token = $reg.accessToken
Write-Result -Name '注册并拿到 accessToken' -Ok ([bool]$token)

# 第二个账号：用来验证"别人的书读不到"
$email2 = "verify2-$([guid]::NewGuid().ToString('N').Substring(0,12))@example.com"
$reg2 = Invoke-Api -Method POST -Path '/v1/auth/register' -Body @{ email = $email2; password = $password }
$token2 = $reg2.accessToken
Write-Result -Name '第二个账号（越权对照）' -Ok ([bool]$token2)

# ---------------------------------------------------------------- 建书 + 上传
Write-Host "`n== 2. 上传 ==" -ForegroundColor Cyan
$book = Invoke-Api -Method POST -Path '/v1/books' -Token $token -Body @{ title = 'Verify Book'; author = 'Verifier'; format = 'epub' }
$bookId = $book.id
Write-Result -Name '建书返回 id' -Ok ([bool]$bookId) -Detail "id=$bookId"

$up = Invoke-Api -Method PUT -Path "/v1/books/$bookId/file?contentHash=sha256:$hash" -Token $token -Bytes $bytes
Write-Result -Name '上传文件返回 contentHash' -Ok ($up.contentHash -eq "sha256:$hash") -Detail "got=$($up.contentHash)"
Check-Equal '上传返回的 sizeBytes 与实际一致' $up.sizeBytes $size
# ★ 201 = 新建；200 = 这份字节此前已被上传过（服务端按 hash 秒传去重）。
#   两种都是成功；断言"必须不是秒传"会让脚本**第二次运行时必然失败**。
Write-Result -Name '上传成功（201 新建 / 200 秒传去重）' -Ok ($script:LastStatus -eq 201 -or $script:LastStatus -eq 200) -Detail "status=$($script:LastStatus)"

# 再传一次同一本书：幂等，必须 200 且内容哈希不变（不是 409）。
$up2 = Invoke-Api -Method PUT -Path "/v1/books/$bookId/file?contentHash=sha256:$hash" -Token $token -Bytes $bytes
Write-Result -Name '同一本书重传同一文件 → 200（幂等，不是 409）' -Ok ($script:LastStatus -eq 200) -Detail "status=$($script:LastStatus)"
Write-Result -Name '重传后 contentHash 不变' -Ok ($up2.contentHash -eq "sha256:$hash") -Detail "got=$($up2.contentHash)"

# ---------------------------------------------------------------- 下载
Write-Host "`n== 3. 下载（完整字节） ==" -ForegroundColor Cyan
$resp = Invoke-WebRequest -Uri "$Base/v1/books/$bookId/file" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 120
$down = $resp.RawContentStream.ToArray()
$downHash = Get-Sha256Hex -Bytes $down
Check-Equal '下载字节数 == 上传字节数' $down.Length $size
Write-Result -Name '下载字节的 sha256 == 上传时的 sha256（逐字节一致）' -Ok ($downHash -eq $hash) -Detail "got=$downHash want=$hash"
Check-Equal 'Content-Length == 实际字节数' ([string]($resp.Headers['Content-Length'] | Select-Object -First 1)) "$size"
Check-Equal 'Content-Type 是 epub' ([string]($resp.Headers['Content-Type'] | Select-Object -First 1)) 'application/epub+zip'
# ★ PS7 的 Headers['ETag'] 返回 String[]，直接塞进 -Headers 会报
#   "The format of value 'System.String[]' is invalid"。
$etag = [string]($resp.Headers['ETag'] | Select-Object -First 1)
Write-Result -Name '响应带 ETag（内容哈希）' -Ok ([bool]$etag) -Detail "etag=$etag"

# ---------------------------------------------------------------- 缓存 / Range
Write-Host "`n== 4. 缓存与 Range ==" -ForegroundColor Cyan
$cached = Invoke-WebRequest -Uri "$Base/v1/books/$bookId/file" -Headers @{ Authorization = "Bearer $token"; 'If-None-Match' = $etag } -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
Check-Equal '带 If-None-Match 再取 → 304' $cached.StatusCode 304

$range = Invoke-WebRequest -Uri "$Base/v1/books/$bookId/file" -Headers @{ Authorization = "Bearer $token"; Range = 'bytes=100-199' } -UseBasicParsing -TimeoutSec 60
Check-Equal 'Range 请求 → 206' $range.StatusCode 206
$rangeBytes = $range.RawContentStream.ToArray()
Check-Equal 'Range 返回 100 字节' $rangeBytes.Length 100
$expectSlice = $bytes[100..199]
$same = $true
for ($i = 0; $i -lt 100; $i++) { if ($rangeBytes[$i] -ne $expectSlice[$i]) { $same = $false; break } }
Write-Result -Name 'Range 字节与原文件对应区间一致' -Ok $same

# ---------------------------------------------------------------- 错误分支
Write-Host "`n== 5. 错误分支 ==" -ForegroundColor Cyan
$emptyBook = Invoke-Api -Method POST -Path '/v1/books' -Token $token -Body @{ title = 'No File Yet'; format = 'epub' }
$nf = Invoke-WebRequest -Uri "$Base/v1/books/$($emptyBook.id)/file" -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
Check-Equal '未上传文件的书 → 404' $nf.StatusCode 404

$other = Invoke-WebRequest -Uri "$Base/v1/books/$bookId/file" -Headers @{ Authorization = "Bearer $token2" } -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
Check-Equal '别人的书 → 404（不泄露存在性）' $other.StatusCode 404

$anon = Invoke-WebRequest -Uri "$Base/v1/books/$bookId/file" -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 60
Check-Equal '未登录 → 401' $anon.StatusCode 401

# ---------------------------------------------------------------- 列表契约
Write-Host "`n== 6. 列表契约 ==" -ForegroundColor Cyan
$list = Invoke-Api -Method GET -Path '/v1/books?limit=50' -Token $token
$item = $list.items | Where-Object { $_.id -eq $bookId } | Select-Object -First 1
Write-Result -Name '列表里能找到刚上传的书' -Ok ([bool]$item)
if ($item) {
    Write-Result -Name '列表返回 contentHash 为 sha256:<hex>' -Ok ($item.contentHash -eq "sha256:$hash") -Detail "got=$($item.contentHash)"
    Check-Equal '列表返回 sizeBytes' $item.sizeBytes $size
}

# ---------------------------------------------------------------- 配额：幂等重传
# 场景：把用户配额调到**正好等于这本书的大小**，然后把同一本书再传一次。
# 正确行为：这次上传不新增占用（账本里已经算过这本书）⇒ 成功。
# 旧行为：按全额再收一次 ⇒ used + size > quota ⇒ 误报 507 "storage quota exceeded"。
Write-Host "`n== 7. 配额：幂等重传不重复计费 ==" -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($PsqlContainer)) {
    Write-Host "  SKIP  未提供 -PsqlContainer，跳过配额用例"
} else {
    $sql = "UPDATE users SET quota_bytes = $size WHERE email = '$email'"
    $null = docker exec $PsqlContainer psql -U hpf -d hpf_reader -c $sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  SKIP  改不了 quota_bytes（容器不可用），跳过配额用例"
    } else {
        $reUp = Invoke-WebRequest -Method PUT -Uri "$Base/v1/books/$bookId/file?contentHash=sha256:$hash" `
            -Headers @{ Authorization = "Bearer $token" } -Body $bytes -ContentType 'application/epub+zip' `
            -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 120
        $ok = $reUp.StatusCode -eq 200 -or $reUp.StatusCode -eq 201
        Write-Result -Name '配额=书大小 时重传同一本书仍然成功（不重复计费）' -Ok $ok -Detail "status=$($reUp.StatusCode) body=$($reUp.Content)"
    }
}

# ---------------------------------------------------------------- 大文件秒传：连接不被掐断
# 场景：上传一份**大文件**（8MB），服务端已经存有这份字节（秒传路径）。
# 关键：秒传分支在服务端是"读到已有字节 ⇒ 直接回 200，不再收请求体"。
# 旧行为：handler 没读完 body 就返回 ⇒ Go 的 http.Server 关闭连接 ⇒
#         客户端还在写这 8MB，写端被打断 ⇒ 上传"卡住 / network_error"。
#         （PowerShell 的 Invoke-RestMethod 可能侥幸成功，所以这里用 curl ——
#          curl 会如实报告发送阶段的失败。）
# 新行为：服务端先把请求体读完（丢弃）再回响应 ⇒ 整份 8MB 顺利送达 ⇒ 200。
Write-Host "`n== 8. 大文件秒传：上传过程不被连接掐断 ==" -ForegroundColor Cyan
$bigSize = 8MB
$bigBytes = New-Object byte[] $bigSize
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bigBytes)
$bigHash = Get-Sha256Hex -Bytes $bigBytes
$bigTmp = Join-Path ([System.IO.Path]::GetTempPath()) "hpf-big-$([guid]::NewGuid().ToString('N')).bin"
[System.IO.File]::WriteAllBytes($bigTmp, $bigBytes)
try {
    # ★ 用第二个账号：第一个账号的配额刚被第 7 段调成了"正好一本书的大小"，
    #   8MB 的大文件必然 507。用一个配额充足的账号来测"连接不被掐断"。
    $bigEmail = "big-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
    $bigReg = Invoke-Api -Method POST -Path '/v1/auth/register' -Body @{ email = $bigEmail; password = $password }
    $bigToken = $bigReg.accessToken
    if ([string]::IsNullOrWhiteSpace($PsqlContainer)) {
        Write-Host '  SKIP  未提供 -PsqlContainer，跳过大文件秒传用例'
    }
    else {
        $null = docker exec $PsqlContainer psql -U hpf -d hpf_reader -c "UPDATE users SET quota_bytes = 104857600 WHERE email = '$bigEmail'" 2>&1
    }
    $bigBook = Invoke-Api -Method POST -Path '/v1/books' -Token $bigToken -Body @{ title = 'Big Dedup Book'; format = 'epub' }
    $bigBookId = $bigBook.id
    $null = Invoke-Api -Method PUT -Path "/v1/books/$bigBookId/file?contentHash=sha256:$bigHash" -Token $bigToken -Bytes $bigBytes
    Write-Result -Name '大文件首次上传成功' -Ok ($script:LastStatus -eq 201 -or $script:LastStatus -eq 200) -Detail "status=$($script:LastStatus)"

    # 第二次：同样的字节 ⇒ 秒传路径。curl 必须能把整份 body 发完并拿到 200。
    $curlOut = Join-Path ([System.IO.Path]::GetTempPath()) "hpf-curl-$([guid]::NewGuid().ToString('N')).json"
    $curlErr = "$curlOut.err"
    $null = & curl.exe -sS -o $curlOut -w '%{http_code}' -X PUT `
        -H "Authorization: Bearer $bigToken" `
        -H 'Content-Type: application/epub+zip' `
        --data-binary "@$bigTmp" `
        "$Base/v1/books/$bigBookId/file?contentHash=sha256:$bigHash" 2> $curlErr
    $curlExit = $LASTEXITCODE
    $curlErrText = if (Test-Path $curlErr) { (Get-Content $curlErr -Raw) } else { '' }
    $curlBody = if (Test-Path $curlOut) { (Get-Content $curlOut -Raw) } else { '' }
    Write-Result -Name '大文件秒传：整份 body 发完且拿到 200（连接未被掐断）' `
        -Ok ($curlExit -eq 0 -and $curlBody -match '"deduplicated"\s*:\s*true') `
        -Detail "curlExit=$curlExit body=$($curlBody -replace '\s+',' ') err=$($curlErrText -replace '\s+',' ')"
    Remove-Item $curlOut, $curlErr -ErrorAction SilentlyContinue
}
finally {
    Remove-Item $bigTmp -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 汇总
Write-Host "`n==== 汇总: PASS=$script:Pass FAIL=$script:Fail ====" -ForegroundColor Cyan
if ($Json) {
    $script:Results | ConvertTo-Json -Depth 4
}
if ($script:Fail -ne 0) { exit 1 }
Write-Host 'ALL DOWNLOAD CHECKS PASSED' -ForegroundColor Green
