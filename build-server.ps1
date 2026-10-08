# build-server.ps1 -- compile server to bytecode & export a docker archive (no source code)
# flow: npm ci -> tsc + esbuild + bytenode (dist keeps only index.js loader + app.jsc) -> docker build (Dockerfile does NOT compile) -> docker save+gzip
# usage: .\build-server.ps1            (default tag: mochi-oa-server:<version>)
#      .\build-server.ps1 -Tag mytag
param(
  [string]$Tag = ""
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host '==> [1/3] compiling server in node:22-slim (same V8 as runtime image)' -ForegroundColor Cyan
# bytenode bytecode is tied to the exact Node/V8 version; compile with the SAME node:22-slim
# as the runtime image, otherwise the container fails with cachedDataRejected.
$vol = "$Root`:/app"
docker run --rm -v "$vol" -w /app/server node:22-slim sh -c "npm ci && npm run build"
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }

Write-Host '==> [2/3] docker build (Dockerfile only COPYs bytecode + prod deps, no source)' -ForegroundColor Cyan
$ver = node -p "require('./server/package.json').version"
if (-not $Tag) { $Tag = "mochi-oa-server:$ver" }
docker build -f Dockerfile -t $Tag .
if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }

Write-Host '==> [3/3] exporting docker archive (bytecode only, no source code)' -ForegroundColor Cyan
$Out = "mochi-oa-server-$ver.tar.gz"
$Tmp = Join-Path $env:TEMP "mochi-oa-server-$ver.tar"
docker save $Tag -o $Tmp
if ($LASTEXITCODE -ne 0) { throw 'docker save failed' }
$in = [System.IO.File]::OpenRead($Tmp)
$out = [System.IO.File]::Create((Join-Path $Root $Out))
$gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($gz)
$gz.Dispose(); $out.Dispose(); $in.Dispose()
Remove-Item $Tmp -Force
Write-Host "done: $Out ($Tag) -- bytecode only, no source code" -ForegroundColor Green
