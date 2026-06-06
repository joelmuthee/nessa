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
  # Auto-stamp the ThriftLux admin bundle cache-bust version. admin.html is
  # served no-cache (see _headers) so it always revalidates; bumping ?v= here is
  # what makes the freshly-revalidated HTML point at the new admin.js/styles.css.
  # Done automatically so a forgotten manual bump can't reintroduce the "stale
  # admin on another phone" bug. Committed on its own so it never tangles with
  # the user's commit logic below.
  STAMP="$(date +%Y%m%d%H%M)"
  sed -i -E "s/(admin\.js\?v=)[^\"']*/\1${STAMP}/; s/(styles\.css\?v=)[^\"']*/\1${STAMP}/" thriftlux/admin.html
  if [ -n "$(git status --porcelain thriftlux/admin.html)" ]; then
    git add thriftlux/admin.html
    git commit -q -m "Deploy: cache-bust ThriftLux admin bundle ($STAMP)"
    echo "Stamped admin bundle version: ${STAMP}"
  fi

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
echo "Live at https://nessa.co.ke"
