# Server one-click build + deploy + restart (Windows host / local)
# Usage: run  ./build.ps1  from the mochi-oa-server repo root
# Flow: tsc compile -> sync static (templates/static) into dist -> Docker deploy/restart
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$serverDir = Join-Path $root 'server'
if (-not (Test-Path (Join-Path $serverDir 'package.json'))) {
  Write-Host '[ERR] server/ not found. Run from the mochi-oa-server repo root.'
  exit 1
}

Write-Host '===== [1/3] tsc compile -> dist ====='
Set-Location $serverDir
node node_modules\typescript\bin\tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Host '[ERR] tsc failed'; exit $LASTEXITCODE }

Write-Host '===== [2/3] sync static (templates/static -> dist) ====='
node tools\copy-templates.mjs
if ($LASTEXITCODE -ne 0) { Write-Host '[ERR] static sync failed'; exit $LASTEXITCODE }

Write-Host '===== [3/3] Docker deploy/restart ====='
Set-Location $root
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Write-Host '[warn] compose up failed, try direct restart...'
  docker restart mochi-oa-server-2f8e9c
}
Write-Host '===== DONE ====='
