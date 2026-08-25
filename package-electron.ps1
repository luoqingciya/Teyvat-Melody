# -*- coding: utf-8 -*-
# Teyvat Melody - Electron 一键打包脚本
# 用法（项目根目录，PowerShell）：
#   .\package-electron.ps1                全量：同步依赖 → 构建前端 → 打后端 exe → electron-builder
#   .\package-electron.ps1 -SkipFrontend  跳过前端构建（dist 已存在时加速）
#
# 依赖：uv、node/npm、electron-builder（已在 package.json devDependencies）
# 产物：backend-dist/TeyvatBackend.exe + electron-dist/ 安装包

param(
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "==> [1/4] uv sync dependencies" -ForegroundColor Cyan
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: uv not found. Install it first: https://docs.astral.sh/uv/" -ForegroundColor Red
    exit 1
}
uv sync

if (-not $SkipFrontend) {
    Write-Host "==> [2/4] build frontend (Vite)" -ForegroundColor Cyan
    Push-Location "$Root\frontend"
    if (-not (Test-Path "node_modules")) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Write-Host "ERROR: node/npm not found, cannot build frontend" -ForegroundColor Red
            Pop-Location
            exit 1
        }
        npm install --registry=https://registry.npmmirror.com --cache "$Root\.npm-cache"
    }
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: frontend build failed" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
} else {
    Write-Host "==> [2/4] skip frontend build (-SkipFrontend)" -ForegroundColor DarkGray
}

Write-Host "==> [3/4] PyInstaller backend exe (TeyvatBackend)" -ForegroundColor Cyan
uv run pyinstaller build.spec --noconfirm --distpath "$Root\backend-dist" --workpath "$Root\build-temp"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: backend packaging failed" -ForegroundColor Red
    exit 1
}

Write-Host "==> [4/4] electron-builder" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: electron-builder failed" -ForegroundColor Red
    exit 1
}

$installer = Get-ChildItem "$Root\electron-dist" -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "TeyvatMelody" } | Select-Object -First 1
if ($installer) {
    Write-Host ""
    Write-Host "Done:" -ForegroundColor Green
    Write-Host ("  installer : {0:N2} MB" -f ($installer.Length / 1MB))
    Write-Host ("  path      : {0}" -f $installer.FullName)
}

Write-Host "==> [5/5] rename unpacked dir to portable name" -ForegroundColor Cyan
$unpackedDir = Join-Path $Root "electron-dist\win-unpacked"
$portableDir = Join-Path $Root "electron-dist\TeyvatMelody-portable"
if (Test-Path $portableDir) {
    try {
        Remove-Item -Path $portableDir -Recurse -Force -ErrorAction Stop
        Write-Host "  removed old TeyvatMelody-portable" -ForegroundColor DarkGray
    } catch {
        Write-Host "WARN: could not remove old TeyvatMelody-portable: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}
if (Test-Path $unpackedDir) {
    try {
        Rename-Item -Path $unpackedDir -NewName "TeyvatMelody-portable" -ErrorAction Stop
        Write-Host "  unpacked dir renamed to: $portableDir" -ForegroundColor Green
    } catch {
        Write-Host "WARN: could not rename win-unpacked (likely in use): $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "      close apps using the folder, then rename manually or re-run this script" -ForegroundColor Yellow
    }
} else {
    Write-Host "  win-unpacked not found, skip renaming" -ForegroundColor DarkGray
}
