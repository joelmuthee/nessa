# Workflow: Import New Bags from @thriftlux.ke Instagram

**Objective:** Download new reel thumbnails and captions from Venessa's Instagram, add them to `data.json`, and crop them to look great in the website grid.

**Last run:** 2026-05-17

---

## Checkpoint (update after every run)

| Field | Value |
|---|---|
| Last run date | 2026-05-17 |
| Most recent reel imported | `DYVFsjwtb5g` (Camel Kelly-Style Pebbled Leather Top Handle Bag) |
| Total bags in `data.json` | 45 |

**How to use the checkpoint:** Reels grid shows newest first. On the next run, scroll the grid until the checkpoint shortcode (`DYVFsjwtb5g`) is visible, then run the Step 2 script with `STOP_AT` set to the checkpoint. Only newer reels will be collected.

---

## Inputs

| Input | Value |
|---|---|
| Instagram profile URL | `https://www.instagram.com/thriftlux.ke/reels/` |
| Stop-at shortcode (last imported) | `DYVFsjwtb5g` |
| Project root | `C:\Users\Joel\Website Designs\thriftlux-ke` |
| Backup of originals | `.tmp/bags_original/` |

---

## Rule: one IG post per physical bag

Each physical bag should appear in IG **once**. If Venessa wants a better photo on the catalogue, the workflow is:

1. Open admin → click **Edit** on the bag.
2. Use the **Main image** picker (top of the form) to upload the new photo.
3. Save.

**Do not** post the same bag to IG a second time and re-import it. Each IG post has a unique shortcode, so a second import creates a brand-new listing with a new id — the public site then shows the bag twice. The IG quick-add dedupes by shortcode (same post), not by physical bag, so it can't catch this for you.

If a duplicate slips through anyway, delete the older listing via admin → **Delete**, or by editing `data.json` and re-syncing KV.

---

## What does NOT work (skip these)

- **Apify `instagram-reel-scraper`** — returns CDN URLs that the VM can't fetch (network block).
- **`/media?size=l`** trick on Instagram — long dead.
- **Static `<img>` extraction from the reels grid** — Instagram renders thumbnails as CSS `background-image` on a `<div>`, not as `<img>`.
- **Playwright for caption collection** — not logged in to Instagram, older reels return "This content is unavailable". Use the Chrome MCP (logged in) instead.
- **JavaScript returning CDN URLs or base64** — output is filtered. Store in `window.__*` globals and trigger downloads via `<a download>`.

---

## The process that works

### Step 1 — Open the reels page in Chrome

Navigate to `https://www.instagram.com/thriftlux.ke/reels/` and scroll until the checkpoint shortcode is visible:

```javascript
!!document.querySelector('a[href*="DYDQo8Pt0xH"]')  // should be true
```

### Step 2 — Extract only NEW thumbnail URLs

```javascript
const STOP_AT = 'DYDQo8Pt0xH'; // ← update each run

const reelLinks = document.querySelectorAll('a[href*="/reel/"]');
const seen = new Set();
window.__reelData = [];

for (const link of reelLinks) {
  const m = link.href.match(/\/reel\/([^/]+)/);
  if (!m || seen.has(m[1])) continue;
  if (m[1] === STOP_AT) break;
  seen.add(m[1]);
  const firstDiv = link.querySelector('div');
  if (firstDiv) {
    const bg = firstDiv.style.backgroundImage;
    const urlMatch = bg.match(/url\("(.+?)"\)/);
    if (urlMatch) window.__reelData.push({ shortcode: m[1], url: urlMatch[1] });
  }
}
'Found ' + window.__reelData.length + ' new reels';
```

### Step 3 — Fetch images as base64 (logged-in browser)

Run in batches of 5 to avoid timeouts:

```javascript
(async () => {
  async function fetchImage(item) {
    const resp = await fetch(item.url);
    const blob = await resp.blob();
    const reader = new FileReader();
    const b64 = await new Promise(r => { reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
    return { shortcode: item.shortcode, data: b64.split(',')[1], size: blob.size };
  }
  window.__batch1 = [];
  for (let i = 0; i < 5; i++) window.__batch1.push(await fetchImage(window.__reelData[i]));
  return window.__batch1.map(r => ({ shortcode: r.shortcode, size: r.size, hasData: !!r.data }));
})();
```

Repeat with `__batch2`, `__batch3`, etc. Then merge:
```javascript
window.__allImages = [...window.__batch1, ...window.__batch2, ...];
```

### Step 4 — Trigger browser downloads

```javascript
(async () => {
  for (const img of window.__allImages) {
    const byteChars = atob(img.data);
    const byteArray = new Uint8Array(byteChars.length);
    for (let j = 0; j < byteChars.length; j++) byteArray[j] = byteChars.charCodeAt(j);
    const blob = new Blob([byteArray], { type: 'image/jpeg' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reel_${img.shortcode}.jpg`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    await new Promise(r => setTimeout(r, 300));
  }
})();
```

### Step 5 — Move and back up

```powershell
$bags = "C:\Users\Joel\Website Designs\thriftlux-ke\images\bags"
$backup = "C:\Users\Joel\Website Designs\thriftlux-ke\.tmp\bags_original"
Move-Item "$env:USERPROFILE\Downloads\reel_*.jpg" $bags -Force
# Backup any new originals before cropping
foreach ($f in (Get-ChildItem $bags -Filter reel_*.jpg)) {
  $b = Join-Path $backup $f.Name
  if (-not (Test-Path $b)) { Copy-Item $f.FullName $b }
}
```

### Step 6 — Collect captions

For each new shortcode, navigate to `https://www.instagram.com/reel/<shortcode>/` in the **logged-in Chrome MCP** (not Playwright — it's not logged in) and screenshot the caption. The caption format is:

```
<Bag Name> @<price>/= [SOLD OUT]
#thriftlux #thrifted #qualityhandbags #thrifthandbags
```

JS extraction (when not blocked by URL filter):
```javascript
const el = Array.from(document.querySelectorAll('span[dir="auto"]'))
  .find(s => s.innerText && s.innerText.includes('@'));
el ? el.innerText.trim() : 'not found';
```

When the JS output is blocked (because captions contain `@` which looks like cookie/query data), fall back to a screenshot and read the caption from the image.

### Step 7 — Update `data.json`

For each new bag, add an entry to the `bags` array (newest first):

```json
{
  "id": "<shortcode>",
  "name": "<clean bag name from caption>",
  "description": "<short, no em-dashes>",
  "price": <integer Ksh>,
  "sold": <true if caption says SOLD/SOLD OUT, else false>,
  "image": "images/bags/reel_<shortcode>.jpg",
  "reel": "https://www.instagram.com/reel/<shortcode>/"
}
```

### Step 8 — Auto-centre the new images

Run the auto-centring crop script. It detects each bag's bounding box and iteratively adjusts the crop window until horizontal AND vertical offsets are under ~1.5%:

```bash
cd "C:\Users\Joel\Website Designs\thriftlux-ke"
python .tmp/auto_center_bags.py
```

### Step 8b — VERIFY (mandatory)

**You MUST verify centring before pushing. Skip this and you will ship off-centre bags. The store owner notices.**

Run the audit script:
```bash
python .tmp/verify_centering.py
```

It reports `dx%`, `dy%`, and left/right margin in pixels for every bag. Anything `>5%` is flagged `<-- OFF CENTER`. **Target: 0 flagged bags.**

Then take a screenshot of every problem bag at the rendered site (desktop AND mobile) and confirm it actually looks centred:
```python
# In Playwright or the browser MCP, after `localhost:8765/index.html?v=<bumped>` reload:
# - scroll to each bag
# - take a viewport screenshot
# - view it inline and confirm L/R and top/bottom margins are roughly equal
# Do NOT skip this. Numerical metrics can lie about visual perception.
```

If a bag still looks off after auto-centring, add a `MANUAL_OVERRIDE` entry in `auto_center_bags.py`:
```python
MANUAL_OVERRIDE = {
    "reel_<shortcode>.jpg": (y_center_pct, x_center_pct),
}
```
where `y_center_pct` is the bag's actual vertical position in the original (0–1) and `x_center_pct` is the horizontal position. Then rerun the crop + verify loop.

### Step 9 — Margins are CSS, not baked into the image (do NOT run add_margins.py)

Earlier in this project we baked an `11%` white border into every JPEG via `.tmp/add_margins.py`. That approach is **dead**. It made every image 78% bag + 22% white pixels saved to disk, which:

- lost image resolution unnecessarily (bag rendered smaller but at the same file size)
- meant re-running the script doubled the padding if you forgot it was already applied
- coupled the card's visual treatment to the image file itself

The current approach is **CSS-only**, in `styles.css`:

```css
.card-img-wrap {
  aspect-ratio: 4 / 5;
  background: #fff;                /* the breathing room you see around the bag */
  display: flex; align-items: center; justify-content: center;
}
.card-img {
  width: 82%; height: 82%;         /* bag fills 82% of the card; ~9% gap each side */
  object-fit: cover;
  border-radius: 12px;             /* rounded corners on the bag photo itself */
}
```

What this means for the import workflow:

- After Step 8 (auto-centring) the bag image is `560×700` and fills the file edge-to-edge. **That's correct. Don't pad it.** The card renders it at 82% inside a flex-centered wrap whose background is white, so the margin appears around it automatically.
- Image quality stays sharper — no resampling, no quality-88 re-save.
- The bag gets clean 12px rounded corners.
- Margin width is a single CSS value (`82%`). Change it once, every bag updates. The store owner flagged the original tight-frame look — that fix lives in `styles.css`, not in any cropping script.

If you ever see a card where the bag is butting against the card edge with no breathing room, the problem is `.card-img` width/height being set to `100%` somewhere — not a missing image step. Check `styles.css` first.

### Step 10 — Bump cache-bust + commit

In `main.js`, increment `IMG_VERSION` (`v2` → `v3` etc.) so any cached old image gets force-reloaded. Then:

```bash
git add images/bags/ .tmp/crop_bags.py main.js data.json
git commit -m "Import N new bags from Instagram"
git push origin main
```

### Step 11 — Update the checkpoint

Edit the **Checkpoint** table at the top of this file:
- Set "Most recent reel imported" to `window.__reelData[0].shortcode` (the newest one downloaded)
- Update date and total count

---

## Cropping Recipe (auto)

Originals are 640×1136 portrait. Cards are 4:5 product format. The cropper outputs **560×700** (4:5).

`auto_center_bags.py` works in three steps:

1. **Background detection.** Sample the four corners of the original; the median brightness is the wall colour.
2. **Bag bbox detection.** Mark every pixel that differs from the background by >25 grayscale levels. Strip the bottom 5% (floor/fluff) and the top 30% (asymmetric strap/hand region). Take the 2nd–98th percentile bounding box of the remaining pixels — that's the bag.
3. **Iterative refinement.** Crop a 560×700 window centred on that bbox. Re-detect inside the crop, measure how far the bag's centre is from the crop centre, shift the crop window by 70% of the offset, repeat. Up to 8 iterations or until both axes are under 1.5% offset.

This converges on properly centred crops for ~99% of bags without manual intervention. For edge cases (e.g. bag colour matches the background, or the bag is photographed in front of a busy backdrop), use `MANUAL_OVERRIDE`.

`verify_centering.py` is the independent auditor: it computes `dx%` and `dy%` from the cropped image's foreground bbox vs. its geometric centre and prints the L/R margins in pixels. **It is the source of truth. If it flags anything, fix before pushing.**

The cropper always reads from `.tmp/bags_original/`, so re-running is non-destructive.

---

## Margin Recipe (CSS, not a script)

The bag's breathing room inside the card is rendered by the card's `display: flex` wrap and the image's `width/height: 82%`. There is no script to run. The original `add_margins.py` is retired — bake nothing into the image.

If at some point a card looks tight again, the fix is in `styles.css`:

| Selector | Property | Purpose |
|---|---|---|
| `.card-img-wrap` | `background: #fff` | The breathing-room colour the viewer sees |
| `.card-img-wrap` | `display: flex; align-items: center; justify-content: center` | Centres the image both ways inside the wrap |
| `.card-img` | `width: 82%; height: 82%` | Inset the image; raise toward 88–90% for tighter, lower toward 75% for airier |
| `.card-img` | `object-fit: cover` | Bag fills the inset rectangle without distortion |
| `.card-img` | `border-radius: 12px` | Rounded corners on the bag photo itself, distinct from the card |

Tuning notes that came out of three iterations on this:

- **78% felt floaty, 92% felt cramped.** 82% is what the store owner approved.
- **Use the card's `#fff` background as the margin — don't paint margin onto the image.** When we baked margins in, the JPEG quality dropped and any later background-colour change to the card surface left a visible white box.
- **Always give the bag its own `border-radius`** so it reads as a photo inside a card, not a card-filling background.

---

## Notes & gotchas

- **Chrome MCP is logged in** to Instagram; **Playwright is not**. Older reels (DX*) return "content unavailable" in Playwright.
- **JavaScript output filter** blocks anything with `@`, query strings, or base64. Use `window.__*` globals and DOM downloads, never `return`/`console.log` raw URLs or data.
- **Image cache:** browsers aggressively cache `.jpg` files. After re-cropping, bump `IMG_VERSION` in `main.js` so the `?v3` query forces a reload, otherwise users see the old version even after a normal refresh.
- **Em-dashes are banned in user-facing copy.** Use full stops, colons, or middle-dots (`·`) instead.
- **"At your expense" and similar standoff-ish phrasing should be softened.** Lead with "we can arrange" rather than putting cost on the customer up front.
- **Caption parsing:** Instagram puts the caption in a `<span dir="auto">` containing the text. Sold status is detected from the words `SOLD` or `SOLD OUT` in the caption.
- **NEVER ship without verifying centring with a screenshot.** Numerical metrics (dx%, dy%) can disagree with visual perception when a bag's strap goes off to one side or a hand is visible. After running `verify_centering.py`, take screenshots of EVERY bag (or at least every flagged one) on the rendered site and confirm L/R margins look equal. Earlier in this project, the assistant pushed off-centre crops three times because it relied on metrics alone — don't repeat that.
- **Always look at all four margins.** Top, bottom, left, and right. A bag with equal top/bottom margins but heavy bias to one side is still "off-centre" and the store owner WILL notice.
- **Margins come from the card, not from the image file.** The store owner flagged tight edge-to-edge bags; that was fixed by rendering the image at `82%` inside a flex-centred white card wrap with a 12px border radius (see "Margin Recipe" above). Do NOT bring back `add_margins.py` or any other script that bakes white padding into the JPEGs — we went through three iterations and the CSS-only approach is the one that stuck. If a card looks cramped, edit `.card-img` width/height in `styles.css`, not the image files.

- **Don't ship fake analytics.** If a dashboard's data source isn't wired up, do not seed it with placeholder numbers, mock data, "demo" charts, or example rows. Either:
  1. Ship the data source first (the emitter, the API endpoint, the database table) before exposing the dashboard, **or**
  2. Show the dashboard with an honest **"Pending implementation"** banner (yellow `.pending-banner` style in `styles.css`) explaining exactly what isn't connected yet, and leave the widgets at their real values — which for "no events yet" means 0.
  Fake/seeded analytics rot trust the moment the owner spots a number that doesn't add up. Per CLAUDE.md's catalog standard: "Always disclose in the admin UI that this is per-browser, not server-aggregated" — and never imply tracking is happening when it isn't. Reference implementation: ThriftLux admin Analytics section (`#analyticsDash` in `admin.html`) ships the pending banner pointing back to this rule.

- **The Instagram quick-add panel is the recommended path, not the manual upload.** Keep the `⚡ Add from Instagram` block at the TOP of the Add/Edit form, visually loud (gold border, gold glow, "RECOMMENDED" badge), with a `form-or-divider` separating it from manual upload below. Most new bags will already exist as a reel on the IG account — pulling them in by URL is faster than re-uploading. If the worker `/api/ig-fetch` endpoint is not yet deployed, the panel must fail gracefully with a friendly message pointing back to this workflow's manual flow (Steps 1–9), not hide itself.

---

## "Add from Instagram" panel — spec

This is the recommended primary path for adding bags. It MUST be visually unmissable so the owner reaches for it before scrolling to the manual upload. Implementation reference: `admin.html` (`.ig-quick-add` block inside `#addForm`) + `styles.css` (`.ig-quick-add`, `.ig-quick-head`, `.ig-quick-badge`, `.ig-quick-desc`, `.ig-quick-row`, `.ig-quick-status`, `.form-or-divider`) + `admin.js` (`igQuickBtn` click handler).

### Layout (top of `#addForm`, BEFORE main image field)

```html
<div class="field ig-quick-add">
  <div class="ig-quick-head">
    <span class="ig-quick-badge">RECOMMENDED</span>
    <h3>Add from Instagram</h3>
  </div>
  <p class="ig-quick-desc">
    Already posted the bag on
    <a href="https://www.instagram.com/thriftlux.ke/" target="_blank" rel="noopener">@thriftlux.ke</a>?
    Paste the reel or post URL and we'll pull the cover image, caption, and price automatically.
    Faster than re-uploading.
  </p>
  <div class="ig-quick-row">
    <input id="igQuickInput" type="url" placeholder="https://www.instagram.com/reel/...">
    <button class="btn-admin gold" id="igQuickBtn" type="button">⚡ Fetch from Instagram</button>
  </div>
  <p id="igQuickStatus" class="ig-quick-status"></p>
</div>

<div class="form-or-divider"><span>or upload manually below ↓</span></div>
```

### Visual requirements (non-negotiable — store owner WILL miss it otherwise)

| Element | Spec |
|---|---|
| Card background | `linear-gradient(135deg, #fff8ec 0%, #f5e9d3 60%, #ead7a8 100%)` — warm cream to champagne |
| Border | **2px** solid `var(--gold)` (`#c9a961`). Not 1px. Not `var(--line)`. |
| Shadow | `0 4px 18px rgba(201,169,97,0.18), 0 1px 3px rgba(0,0,0,0.04)` — soft gold halo |
| Corner radius | 14px (matches card style elsewhere) |
| Padding | 22px 24px desktop, 16px on mobile |
| Badge | Black-on-gold "RECOMMENDED" pill, 10px font, `0.14em` letter-spacing |
| Heading | Serif "Add from Instagram", 22px, weight 600 |
| Description | 13.5px, includes a linked `@thriftlux.ke` in `var(--gold-deep)` with underline |
| URL input | Gold border, 13px padding, 15px font. Focus shows `0 0 0 3px rgba(201,169,97,0.2)` glow. |
| CTA button | `.btn-admin.gold` (gold fill, ink text, bold) with `⚡ Fetch from Instagram` label. NOT a small dark "Fetch" button. |
| Divider below card | `.form-or-divider` saying "or upload manually below ↓" — uppercase, letter-spaced, with horizontal rules on either side. Makes manual upload feel like a fallback, not the default. |

### Behaviour

1. Pastes URL → `igQuickBtn` click → `GET ${API_BASE}/api/ig-fetch?url=<encoded>`
2. Worker should return `{ imageUrl, caption, postUrl }`. The image is then fetched through the browser and staged via the same `readFileAsStaged` pipeline as a manual file pick — same upload flow on Save, no special case.
3. Caption is parsed: first line `Name @1500/= [SOLD]` extracts `name` + `price`; full caption becomes the description with `#hashtags` stripped; presence of `SOLD` ticks the sold checkbox.
4. `igQuickStatus` shows green tick on success, red message on failure. Status messages must never be HTML-techy ("404 from worker", "fetch failed at network layer"). Use plain English; point to this workflow when the endpoint isn't deployed.

### Failure mode (worker `/api/ig-fetch` not deployed yet)

Show this message verbatim — friendly, points back to the manual flow without exposing the failure cause to the owner:

> ✗ IG fetch endpoint not deployed yet. Use the manual flow in `workflows/thriftlux_instagram_import.md` — download the reel cover, then use the Main image picker below.

Do **not** hide the panel. Do **not** disable the button. Do **not** show a stack trace. The panel staying visible is what reminds the owner this path will be the default once the endpoint ships.

### Why all this fuss

Earlier in this project the IG panel was technically present but visually identical to every other form field — a small label and a small dark "Fetch" button buried above the Main image picker. The store owner consistently scrolled past it and uploaded files manually, which defeats the entire point. The gold-glow + RECOMMENDED badge + or-divider treatment is what reliably draws the eye before the manual upload does. Don't tone it down.
