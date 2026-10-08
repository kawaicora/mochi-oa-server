# build-server.ps1 —— 服务端编译为二进制并导出 docker 压缩包（不含源代码）
# 流程：npm ci → tsc + esbuild + bytenode（dist 只留 index.js loader + app.jsc 字节码）→ docker build（Dockerfile 不编译）→ docker save 压缩
# 用法：.\build-server.ps1            （默认 tag: mochi-oa-server:<version>）
#      .\build-server.ps1 -Tag mytag
param(
  [string]$Tag = ""
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host '==> 1/3 编译服务端（tsc + esbuild + bytenode -> 字节码）' -ForegroundColor Cyan
Push-Location (Join-Path $Root 'server')
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
Pop-Location

Write-Host '==> 2/3 构建镜像（Dockerfile 只 COPY 二进制 + 生产依赖，不含源码）' -ForegroundColor Cyan
$ver = node -p "require('./server/package.json').version"
if (-not $Tag) { $Tag = "mochi-oa-server:$ver" }
docker build -f Dockerfile -t $Tag .
if ($LASTEXITCODE -ne 0) { throw 'docker build 失败' }

Write-Host '==> 3/3 导出 docker 压缩包（仅二进制，不含源代码）' -ForegroundColor Cyan
$Out = "mochi-oa-server-$ver.tar.gz"
$Tmp = Join-Path $env:TEMP "mochi-oa-server-$ver.tar"
docker save $Tag -o $Tmp
if ($LASTEXITCODE -ne 0) { throw 'docker save 失败' }
$in = [System.IO.File]::OpenRead($Tmp)
$out = [System.IO.File]::Create((Join-Path $Root $Out))
$gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($gz)
$gz.Dispose(); $out.Dispose(); $in.Dispose()
Remove-Item $Tmp -Force
Write-Host "已导出: $Out ($Tag) —— 仅含二进制字节码，不含源代码" -ForegroundColor Green
