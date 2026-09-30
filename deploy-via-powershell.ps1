# ============================================================================
# LumberCorp 2.0 -> lumber12345/lumbercorp2.0  (run on YOUR machine)
# ============================================================================
# Pulls the latest build from the public Arena branch (PR #1) and pushes it to
# your lumbercorp2.0 repo using YOUR GitHub login - which has write access.
#
# How to run:
#   1. Open PowerShell on your Windows machine
#   2. Paste this whole file (or run:  powershell -ExecutionPolicy Bypass -File deploy-via-powershell.ps1)
#   3. First push may pop a GitHub sign-in window - accept it. Done.
#
# Needs: git installed (git-scm.com). Nothing else.
# ============================================================================

$ErrorActionPreference = "Stop"

$srcRepo = "https://github.com/lumber12345/lumbercorp-companion.git"
$srcRef  = "arena/01a0f073-lumbercorp-companion"   # PR #1 branch = latest build
$dstRepo = "https://github.com/lumber12345/lumbercorp2.0.git"

$work = Join-Path $env:TEMP "lc20-deploy"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work | Out-Null

Write-Host "==> cloning the build (public repo, no login needed)..." -ForegroundColor Cyan
git clone --depth 1 -b $srcRef $srcRepo "$work\src"
if ($LASTEXITCODE -ne 0) { throw "Clone of the build repo failed - check your internet connection." }

Write-Host "==> cloning your lumbercorp2.0 repo..." -ForegroundColor Cyan
git clone $dstRepo "$work\dst"
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "Clone of lumbercorp2.0 failed. If a GitHub login window appeared, sign in with the lumber12345 account."
}

Write-Host "==> overlaying the build (app + proxy + render.yaml + zip)..." -ForegroundColor Cyan
Copy-Item "$work\src\lumbercorp-2"           "$work\dst\" -Recurse -Force
Copy-Item "$work\src\proxy"                  "$work\dst\" -Recurse -Force
Copy-Item "$work\src\render.yaml"            "$work\dst\" -Force
Copy-Item "$work\src\DEPLOY.md"              "$work\dst\" -Force
Copy-Item "$work\src\lumbercorp2-render.zip" "$work\dst\" -Force
Remove-Item "$work\src" -Recurse -Force

Push-Location "$work\dst"

# first-time git identity, only if this machine never set one
if (-not (git config user.email)) { git config user.email "lumber12345@users.noreply.github.com" }
if (-not (git config user.name))  { git config user.name  "lumber12345" }

git add -A
if (-not (git status --porcelain)) {
    Write-Host "Your repo already matches the build - nothing to push." -ForegroundColor Yellow
    Pop-Location
    exit 0
}

$ver = (Select-String -Path "lumbercorp-2\index.html" -Pattern 'APP_VERSION = "([^"]+)"').Matches[0].Groups[1].Value
git commit -m "LumberCorp 2.0 v$ver - sync from Arena build (PR #1 branch)"
Write-Host "==> pushing with YOUR GitHub login..." -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Push failed - make sure you signed in as an account with write access to lumbercorp2.0." }
Pop-Location

Write-Host ""
Write-Host "DONE - lumber12345/lumbercorp2.0 is now on v$ver." -ForegroundColor Green
Write-Host "If your Render service watches this repo, it will auto-deploy."
Write-Host "(Working copy kept at $work in case you want to inspect it)"
