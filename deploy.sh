#!/usr/bin/env bash
# Bash twin of deploy.ps1 — for Claude Code / WSL / git-bash users.
# Same behaviour: push to main + wrangler deploy to the `nessa` Pages project.
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID=58685495706b973821d77208248c66fc

skip_push=0
msg=""
for arg in "$@"; do
  case "$arg" in
    --skip-push|-s) skip_push=1 ;;
    *) msg="$arg" ;;
  esac
done

if [ $skip_push -eq 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    if [ -n "$msg" ]; then
      echo "Staging + committing..."
      git add -A
      git commit -m "$msg"
    else
      echo "Uncommitted changes detected but no commit message passed."
      echo "Either commit manually then re-run, or pass a message: ./deploy.sh 'your message'"
      exit 1
    fi
  fi
  echo "Pushing to origin/main..."
  git push origin main
fi

echo "Deploying to Cloudflare Pages (project: nessa)..."
npx wrangler pages deploy . --project-name=nessa --branch=main --commit-dirty=true

echo ""
echo "Live at https://nessa.essenceautomations.com"
