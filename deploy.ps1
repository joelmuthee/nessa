# Deploy the Nessa hub site.
#
# Why this exists: the GitHub -> CF Pages auto-deploy webhook on the
# `nessa` Pages project silently stops firing after a few hours (known
# CF bug per CATALOG-STANDARDS). This script pushes to git AND directly
# triggers a wrangler deploy, so the live site always matches main.
#
# Usage:
#   ./deploy.ps1                   # push + deploy current uncommitted changes
#   ./deploy.ps1 "commit message"  # stage all, commit with msg, push + deploy
#   ./deploy.ps1 -SkipPush         # only run wrangler deploy (no git activity)
#
param(
  [Parameter(Position = 0)]
  [string]$Message = "",
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
$env:CLOUDFLARE_ACCOUNT_ID = '58685495706b973821d77208248c66fc'

if (-not $SkipPush) {
  $hasChanges = (git status --porcelain) -ne $null
  if ($hasChanges -and $Message) {
    Write-Host "Staging + committing..." -ForegroundColor Cyan
    git add -A
    git commit -m $Message
  } elseif ($hasChanges -and -not $Message) {
    Write-Host "Uncommitted changes detected but no commit message passed." -ForegroundColor Yellow
    Write-Host "Either commit manually then re-run, or pass a message: ./deploy.ps1 'your message'" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "Pushing to origin/main..." -ForegroundColor Cyan
  git push origin main
}

Write-Host "Deploying to Cloudflare Pages (project: nessa)..." -ForegroundColor Cyan
npx wrangler pages deploy . --project-name=nessa --branch=main --commit-dirty=true

Write-Host ""
Write-Host "Live at https://nessa.co.ke" -ForegroundColor Green
