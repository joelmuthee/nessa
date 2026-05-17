# Workflow: Refresh Nessa portfolio from @nessamakeupart

**Objective:** Pull the latest posts from Nessa's Instagram, classify each as makeup / styling / both / unclear, download cover images, and rebuild `data.json`.

**Last run:** 2026-05-17

---

## Checkpoint (update after every run)

| Field | Value |
|---|---|
| Last run date | 2026-05-17 |
| Most recent post imported | `DOTmIkdiJaW` (top of grid) |
| Total posts in `data.json` | 142 (33 makeup, 68 styling, 18 both, 23 unclear) |
| Stragglers not fetched | 0 (caption worker hit throttle; the 8 missing from the original 150 were skipped) |

**How the checkpoint works:** the grid shows newest-first. On the next run, scroll until you see the checkpoint shortcode (`DOTmIkdiJaW`), set `STOP_AT` to it in the scraper, and only newer posts are picked up.

---

## The standards this project follows

Read these first if you haven't built a hub site before:

- `Website Designs/CATALOG-STANDARDS.md` --> "Multi-service owner -- hub site pattern" (architecture, IGNORE-Highlights rule, classification heuristic)
- `Website Designs/CATALOG-STANDARDS.md` --> "Instagram quick-add -- standard workflow" (og:title trick, JS-output filter, CORS gotchas)
- `Website Designs/thriftlux-ke/workflows/thriftlux_instagram_import.md` (mirror flow for thrift catalog)

---

## Step-by-step (the way it actually worked)

### 1. Open IG in the logged-in Chrome MCP

Navigate to `https://www.instagram.com/nessamakeupart/`. Chrome MCP carries the user's session cookies; Playwright does not (and IG returns "content unavailable" on older posts without cookies). Always Chrome MCP for IG work.

### 2. Scroll the grid with real wheel events

Programmatic `window.scrollTo()` does NOT trigger IG's lazy-load observer on the profile grid. Use `computer-use scroll` (real wheel event) in batches. Pace: 4 scrolls of 10 ticks, wait 2s, collect, repeat. Roughly 30-40 scrolls to load the 150 most recent posts.

Collect shortcodes + thumbnail URLs as you go. Cards get virtualised out of the DOM when you scroll past them, so the map needs accumulating across scroll passes:

```javascript
window.__nessaMap = window.__nessaMap || new Map();
const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
for (const link of links) {
  const m = link.href.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  if (!m) continue;
  const sc = m[1];
  const img = link.querySelector('img');
  const isReel = /\/reel(?:s)?\//.test(link.href);
  if (img && img.src && !window.__nessaMap.has(sc)) {
    window.__nessaMap.set(sc, { shortcode: sc, url: img.src, isReel });
  }
}
```

### 3. Fetch caption per post via og:title (NOT the embed page)

IG's `/embed/captioned/` no longer surfaces captions in plain HTML. The reliable path is the `<meta property="og:title">` on the actual post page:

```javascript
// Run inside the logged-in Chrome MCP tab (same origin = instagram.com)
async function fetchCaption(sc) {
  const r = await fetch(`https://www.instagram.com/p/${sc}/`, {credentials: 'include'});
  const html = await r.text();
  const ogt = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (!ogt) return '';
  const inner = ogt[1].match(/Instagram:\s*&quot;([\s\S]*?)&quot;\s*$/);
  return inner ? inner[1] : '';
}
```

IG throttles aggressively. A serial loop with 250ms delays does ~1.5 posts/second, but rate-limits kick in after ~50 posts and slow to ~1 post per 20s. Use a **fire-and-forget** parallel worker (chunks of 3, no `await` at the top level) so the CDP call returns immediately:

```javascript
window.__worker = (async () => {
  for (let i = 0; i < window.__scs.length; i += 3) {
    const chunk = window.__scs.slice(i, i + 3);
    const results = await Promise.all(chunk.map(fetchCaption));
    chunk.forEach((sc, idx) => { window.__caps[sc] = results[idx]; });
    await new Promise(r => setTimeout(r, 200));
  }
})();
```

Poll `Object.keys(window.__caps).length` every minute. 150 posts takes 4-8 minutes depending on IG's mood. Stragglers (last 5-10) can take another 10 min -- ship without them on a tight schedule and backfill later.

### 4. Classify each caption

`classify.py` reads captions and assigns each to **makeup / styling / both / unclear**.

```bash
python classify.py captions.json
```

The heuristic parses role-credit phrases ("`<role list>` by `<person>`") and only counts roles credited to `@nessamakeupart`. Falls back to role-specific hashtags (`#nessastyling`, `#wardrobestylist`, etc).

**KEY RULES** (also captured in `CATALOG-STANDARDS.md`):
- `#nessamakeupart` is her signature hashtag and appears on EVERY post -- do NOT use it as a makeup signal.
- Captions credit OTHER artists for roles she didn't play ("Makeup by @makeupby_bilha, Styling by @nessamakeupart" means she did styling only). Only count roles where the person is `@nessamakeupart` / "yours truly" / "myself" / "me".
- `unclear` items are usually personal posts ("babyshower", "this too shall pass") and should NOT appear in the gallery. They're filtered out at render time in `main.js`.

### 5. Fetch cover images

For each shortcode, fetch the post page for `og:image`, then fetch the image binary, then trigger browser download. Same fire-and-forget pattern as captions, parallel=4 for binaries (IG CDN tolerates more concurrency than IG.com itself):

```javascript
async function downloadCover(sc) {
  const r = await fetch(`https://www.instagram.com/p/${sc}/`, {credentials: 'include'});
  const html = await r.text();
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (!m) return;
  const imgUrl = m[1].replace(/&amp;/g, '&');
  const resp = await fetch(imgUrl, {mode: 'cors'});
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nessa_${sc}.jpg`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
```

Move from `~/Downloads/nessa_*.jpg` into `images/posts/` and back up to `.tmp/posts_original/`:

```powershell
$proj = "C:\Users\Joel\Website Designs\nessa-essenceautomations"
$posts = Join-Path $proj "images\posts"
$backup = Join-Path $proj ".tmp\posts_original"
New-Item -ItemType Directory -Force -Path $posts, $backup | Out-Null
Move-Item "$env:USERPROFILE\Downloads\nessa_*.jpg" $posts -Force
foreach ($f in (Get-ChildItem $posts -Filter "nessa_*.jpg")) {
  $b = Join-Path $backup $f.Name
  if (-not (Test-Path $b)) { Copy-Item $f.FullName $b }
}
```

### 6. Build data.json

```bash
python build_data.py
```

This script merges `captions.json` + classification + image paths into the final `data.json` that the site reads. Reports `<makeup, styling, both, unclear>` counts at the end.

### 7. Bump cache + deploy

```bash
# bump `?v=N` in index.html, makeup.html, styling.html when CSS/JS changes
# or when data.json changes substantially
npx wrangler pages deploy . --project-name=nessa-essenceautomations --branch=main --commit-dirty=true
```

### 8. Update checkpoint

Edit the table at the top of THIS file:
- "Most recent post imported" --> newest shortcode in the grid
- "Total posts" --> count from build_data.py output
- "Stragglers" --> any that didn't fetch

---

## Honest limitations of this v1

- **No web admin.** Re-imports are scripted, not click-to-add. Add an admin panel + worker if Nessa wants to add posts without the dev.
- **No incremental import yet.** Each run pulls 150 from scratch. Add a `STOP_AT` checkpoint to the scrape loop when v2 ships.
- **classification.csv has ~16% in the "unclear" bucket** -- these are filtered from the gallery (personal posts, junk). If a legitimate post lands there it gets hidden. The CSV exists for spot-checking; a `manual_overrides.json` could pin specific shortcodes to a category in a future version.
- **Cover images are IG-CDN thumbnails (~320x320 to 1080x1080).** Quality varies. For hero/about images use original-resolution photos uploaded manually to `images/`.
