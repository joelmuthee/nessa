#!/usr/bin/env bash
# new-client.sh — Spin up a new WhatsApp catalog site (clone of ThriftLux)
#
# Just run it with no arguments — it'll ask you everything it needs.
#
#   ./tools/new-client.sh
#
# Pre-requisites (one-time, on this machine):
#   • Node.js + npx
#   • Python 3
#   • git, bash, curl
#   • Run `npx wrangler login` once (authenticates with Cloudflare)
#   • (Optional) Run `gh auth login` once (authenticates with GitHub for auto repo creation)

set -euo pipefail

# ───────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
hr()     { printf '─%.0s' $(seq 1 60); echo; }

# ───────────────────────────────────────────────────────────────────
# Banner
# ───────────────────────────────────────────────────────────────────
clear || true
hr
bold "  Spin up a new WhatsApp catalog site"
hr
echo "Built from the ThriftLux template. Takes ~30 seconds."
echo ""

# ───────────────────────────────────────────────────────────────────
# Q1 — Instagram URL or handle (used to derive the slug)
# ───────────────────────────────────────────────────────────────────
echo ""
bold "1. Client's Instagram"
echo "   Examples:"
echo "     https://www.instagram.com/mamamboga.ke/"
echo "     instagram.com/lulu_skincare"
echo "     @joesvintage"
echo ""
read -rp "   ▶ Paste the Instagram URL or handle: " IG_INPUT

# Extract handle, then strip everything that isn't a letter/number → slug
HANDLE="$(printf '%s' "$IG_INPUT" \
  | sed -E 's|^https?://||I; s|^www\.||I; s|^instagram\.com/||I; s|^@||; s|/.*$||' \
  | tr -d '[:space:]')"
SLUG="$(printf '%s' "$HANDLE" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"

if [ -z "$SLUG" ]; then
  red "❌ Couldn't read an Instagram handle from that. Try again."
  exit 1
fi

echo "   ✓ Handle: @$HANDLE"
echo "   ✓ Internal name (slug): $SLUG"

# ───────────────────────────────────────────────────────────────────
# Q2 — WhatsApp
# ───────────────────────────────────────────────────────────────────
echo ""
bold "2. WhatsApp number"
echo "   Country code + number, digits only. No + or spaces."
echo "   Kenya example: 254712345678"
echo ""
while true; do
  read -rp "   ▶ WhatsApp number: " WHATSAPP
  WHATSAPP="$(printf '%s' "$WHATSAPP" | tr -cd '0-9')"
  if [[ "$WHATSAPP" =~ ^[0-9]{10,15}$ ]]; then
    echo "   ✓ $WHATSAPP"
    break
  fi
  red "   ❌ Need 10-15 digits. Try again."
done

# ───────────────────────────────────────────────────────────────────
# Q3 — Business name
# ───────────────────────────────────────────────────────────────────
echo ""
bold "3. Business name"
echo "   Exactly as it should appear on the site (e.g. \"Mama Mboga Bakery\")."
echo ""
read -rp "   ▶ Business name: " BIZ_NAME
if [ -z "$BIZ_NAME" ]; then
  red "❌ Business name can't be empty."
  exit 1
fi
echo "   ✓ $BIZ_NAME"

# ───────────────────────────────────────────────────────────────────
# Confirm
# ───────────────────────────────────────────────────────────────────
echo ""
hr
bold "Ready to deploy:"
echo "   Slug:          $SLUG"
echo "   Instagram:     @$HANDLE"
echo "   WhatsApp:      $WHATSAPP"
echo "   Business name: $BIZ_NAME"
hr
echo ""
read -rp "   Press ENTER to start, or Ctrl-C to bail. " _

# ───────────────────────────────────────────────────────────────────
# Paths
# ───────────────────────────────────────────────────────────────────
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT_DIR="$(dirname "$TEMPLATE_DIR")"
TARGET_DIR="$PARENT_DIR/$SLUG"

if [ -d "$TARGET_DIR" ]; then
  red "❌ Folder already exists: $TARGET_DIR"
  echo "   Delete it first or pick a different Instagram handle."
  exit 1
fi

# ───────────────────────────────────────────────────────────────────
# 1. Copy template
# ───────────────────────────────────────────────────────────────────
echo ""
green "▶ Copying template to $TARGET_DIR"
cp -r "$TEMPLATE_DIR" "$TARGET_DIR"
cd "$TARGET_DIR"
rm -rf .git .claude .tmp .playwright-mcp tools
rm -f images/bags/*.jpg
rm -f data.json CNAME

# ───────────────────────────────────────────────────────────────────
# 2. Generate fresh secrets
# ───────────────────────────────────────────────────────────────────
PASSWORD="$(python3 -c 'import secrets;print(secrets.token_urlsafe(8))')"
TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
TOKEN_B64="$(printf '%s' "$TOKEN" | base64 | tr -d '\n')"
WORKER_NAME="${SLUG}-api"

green "▶ Generated admin password and worker token"

# ───────────────────────────────────────────────────────────────────
# 3. Cloudflare Worker + KV
# ───────────────────────────────────────────────────────────────────
cd worker
sed -i.bak "s|^name = \".*\"|name = \"$WORKER_NAME\"|" wrangler.toml && rm wrangler.toml.bak

green "▶ Creating Cloudflare KV namespace…"
KV_RAW="$(npx wrangler kv namespace create BAGS 2>&1)"
echo "$KV_RAW" | grep -E "id|namespace" || true
KV_ID="$(printf '%s\n' "$KV_RAW" | grep -oE '"id": *"[a-f0-9]{32}"' | head -1 | sed 's/.*"\([a-f0-9]*\)".*/\1/')"
if [ -z "$KV_ID" ]; then
  red "❌ Failed to create KV namespace. Are you logged in to Cloudflare?"
  echo "   Run: npx wrangler login"
  exit 1
fi
sed -i.bak "s|id = \"[a-f0-9]\{32\}\"|id = \"$KV_ID\"|" wrangler.toml && rm wrangler.toml.bak

green "▶ Setting admin token as Worker secret…"
printf '%s' "$TOKEN" | npx wrangler secret put ADMIN_TOKEN > /dev/null

green "▶ Deploying Worker…"
DEPLOY_OUT="$(npx wrangler deploy 2>&1)"
WORKER_URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
if [ -z "$WORKER_URL" ]; then
  red "❌ Worker deploy failed."
  echo "$DEPLOY_OUT"
  exit 1
fi
echo "   ✓ Live at: $WORKER_URL"
cd ..

# ───────────────────────────────────────────────────────────────────
# 4. Customise frontend files
# ───────────────────────────────────────────────────────────────────
green "▶ Customising site files for $BIZ_NAME…"

WORKER_URL_ESC="$WORKER_URL" \
TOKEN_B64_ESC="$TOKEN_B64" \
PASSWORD_ESC="$PASSWORD" \
WHATSAPP_ESC="$WHATSAPP" \
BIZ_NAME_ESC="$BIZ_NAME" \
python3 <<'PY'
import os, re, pathlib

worker = os.environ['WORKER_URL_ESC']
token  = os.environ['TOKEN_B64_ESC']
pwd    = os.environ['PASSWORD_ESC']
wa     = os.environ['WHATSAPP_ESC']
biz    = os.environ['BIZ_NAME_ESC']

# admin.js
p = pathlib.Path("admin.js")
s = p.read_text(encoding="utf-8")
s = re.sub(r"const API_BASE = '[^']+'", f"const API_BASE = '{worker}'", s)
s = re.sub(r"const ADMIN_TOKEN = atob\('[^']+'\)", f"const ADMIN_TOKEN = atob('{token}')", s)
s = re.sub(r"const ADMIN_PASSWORD = '[^']+'", f"const ADMIN_PASSWORD = '{pwd}'", s)
p.write_text(s, encoding="utf-8")

# main.js
p = pathlib.Path("main.js")
s = p.read_text(encoding="utf-8")
s = re.sub(r"const API_BASE = '[^']+'", f"const API_BASE = '{worker}'", s)
s = re.sub(r"const IMG_VERSION = '[^']+'", "const IMG_VERSION = 'v1'", s)
# WhatsApp default fallback in whatsappLink()
s = re.sub(r"settings\.whatsappNumber \|\| '\d+'", f"settings.whatsappNumber || '{wa}'", s)
p.write_text(s, encoding="utf-8")

# index.html
p = pathlib.Path("index.html")
s = p.read_text(encoding="utf-8")
s = s.replace("ThriftLux", biz)
s = s.replace("254705044940", wa)
# Strip ThriftLux's OG image (point to logo placeholder for now)
s = re.sub(r'images/bags/reel_[A-Za-z0-9_]+\.jpg', 'images/logo.jpg', s)
p.write_text(s, encoding="utf-8")

# admin.html
p = pathlib.Path("admin.html")
s = p.read_text(encoding="utf-8")
s = s.replace("ThriftLux", biz)
p.write_text(s, encoding="utf-8")

print("   ✓ admin.js, main.js, index.html, admin.html updated")
PY

# ───────────────────────────────────────────────────────────────────
# 5. Seed empty catalog
# ───────────────────────────────────────────────────────────────────
green "▶ Seeding empty catalog in database…"
curl -s -X POST "$WORKER_URL/api/bulk" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"bags\":[],\"settings\":{\"whatsappNumber\":\"$WHATSAPP\"}}" > /dev/null
echo "   ✓ Catalog ready (empty, client adds bags via admin)"

# ───────────────────────────────────────────────────────────────────
# 6. Fresh git repo
# ───────────────────────────────────────────────────────────────────
green "▶ Initialising git repo…"
git init -q -b main
git add -A
git commit -q -m "Initial commit for $BIZ_NAME"
echo "   ✓ Local repo ready (1 commit on main)"

# ───────────────────────────────────────────────────────────────────
# 7. Final report — exactly what to do next
# ───────────────────────────────────────────────────────────────────
echo ""
hr
green "✅ Site built and deployed."
hr
echo ""
echo "What's already done:"
echo "  ✓ Cloudflare Worker deployed: $WORKER_URL"
echo "  ✓ Database created and seeded"
echo "  ✓ Admin password generated"
echo "  ✓ All files customised for $BIZ_NAME"
echo "  ✓ Local git repo initialised"
echo ""

bold "WHAT YOU DO NEXT — 3 manual steps (~5 mins):"
echo ""

# Step 1: GitHub repo
hr
bold "STEP 1 — Push to GitHub"
hr
if command -v gh >/dev/null 2>&1; then
  echo ""
  echo "You have 'gh' installed. Run these two lines:"
  echo ""
  yellow "    cd \"$TARGET_DIR\""
  yellow "    gh repo create $SLUG --public --source=. --push"
  echo ""
  echo "Done. Repo will be at: https://github.com/<your-username>/$SLUG"
else
  echo ""
  echo "1. Open https://github.com/new in your browser"
  echo "2. Repository name: ${YELLOW}$SLUG${NC}"
  echo "3. Public, no README, no .gitignore, no licence"
  echo "4. Click 'Create repository'"
  echo "5. Copy the repo URL it shows (looks like https://github.com/you/$SLUG.git)"
  echo "6. Run these in your terminal:"
  echo ""
  yellow "    cd \"$TARGET_DIR\""
  yellow "    git remote add origin <PASTE THE URL>"
  yellow "    git push -u origin main"
fi
echo ""

# Step 2: GitHub Pages
hr
bold "STEP 2 — Turn on GitHub Pages"
hr
echo ""
echo "1. Go to: https://github.com/<your-username>/$SLUG/settings/pages"
echo "2. Under 'Source', select: Deploy from a branch"
echo "3. Branch: main · Folder: / (root) · Save"
echo "4. Wait 30 seconds. Site goes live at:"
echo ""
yellow "    https://<your-username>.github.io/$SLUG/"
echo ""

# Step 3: Hand over
hr
bold "STEP 3 — Give the client these details"
hr
echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │                                                  │"
echo "  │  Site:      https://<your-username>.github.io/$SLUG/"
echo "  │  Admin:     <site>/admin.html"
echo "  │  Password:  $PASSWORD"
echo "  │                                                  │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
red "  ⚠️  SAVE THIS PASSWORD NOW — it's not stored anywhere else."
echo "      (Recommend: 1Password / Bitwarden / a notes app)"
echo ""

# Optional steps
hr
bold "OPTIONAL — When the client is ready"
hr
echo ""
echo "▸ Custom domain (e.g. mamamboga.co.ke):"
echo "    cd \"$TARGET_DIR\""
echo "    echo 'mamamboga.co.ke' > CNAME"
echo "    git add CNAME && git commit -m 'Add domain' && git push"
echo "    Then in their domain registrar:"
echo "      Add CNAME record: name=@ value=<your-username>.github.io"
echo ""
echo "▸ Replace logo:"
echo "    Drop their logo at: $TARGET_DIR/images/logo.jpg"
echo "    Then: git add . && git commit -m 'Add logo' && git push"
echo ""
echo "▸ Brand colour tweak:"
echo "    Edit $TARGET_DIR/styles.css — search for 'gold' or '--gold:'"
echo ""
hr
echo ""
green "Done. Welcome aboard, $BIZ_NAME 🎉"
echo ""
