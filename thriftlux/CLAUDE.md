# ThriftLux — project-specific LOCKED rules

These OVERRIDE the default `CATALOG-STANDARDS.md` wherever they conflict. Read this before changing ThriftLux behaviour.

## Enquire = straight to WhatsApp, NEVER the Web Share app-picker (LOCKED 2026-06-03)

The owner rejected the OS "select an app" share sheet: *"Enquire now asks me to select an app instead of going straight to WhatsApp!"*

- The Enquire button MUST open `wa.me` **directly** via the anchor's `href` (one tap, straight into the WhatsApp chat).
- Do **NOT** use `navigator.share` / `navigator.canShare` / the Web Share API — that's the "Tier 1" path in `CATALOG-STANDARDS.md`, and it pops the OS app-picker. It was removed once already (`tryShareWithImage` deleted); **do not reintroduce it**, even though the default standard lists Web Share as the primary mobile path.
- The wa.me message already appends the worker `/share/<id>` OG page, so WhatsApp still renders the product preview card (photo + name + price). That link-preview card is the intended "exact item + image" experience here — not a file attachment.

Same locked choice as Nzuri Couture (`nzuri-couture/CLAUDE.md`).

## Boost to top — admin float for slow stock (added 2026-06-12)

Bulk-bar action `⬆ Boost to top` stamps `boostedAt: ISO` on selected bags; on the public site, boosted (unsold) bags float to the top of the default **Featured** order, most-recently-boosted first. Buyer-chosen sorts (Newest / Price ↑ / Price ↓) ignore boost — the buyer's explicit intent wins. **Remove boost** deletes the field.

- Sold bags can't be boosted (admin guard) and won't float even if `boostedAt` is stale from a pre-sale boost (public `boostRank` returns 0 for sold).
- No public ribbon — position IS the signal. Admin list shows a gold `⬆ BOOSTED` tag next to the price line.
- Composes with Sale: a bag can be both boosted AND on sale (pinned + red SALE ribbon). Don't make them exclusive.
- Built for Venessa's "no idea what to do with old bags still in stock" — sibling of Sale; full spec in `Website Designs/CATALOG-STANDARDS.md` → "Boost to top". 3k Shop Records tier feature.

## Instagram checks (2026-10-07)

"Check for new posts" fetches only posts newer than the shop has seen (`onlyPostsNewerThan`, KV
`ig_newest_seen`), is capped at 2 a day (KV `apify_calls:<date>`), and tells the owner how many
checks are left. Full rule: `CATALOG-STANDARDS.md` → Instagram bulk sync.

## Hero shows real AVAILABLE bags + "Shop by bag type" row (2026-10-08)

Joel approved Jirani Fashion's new hero and asked for it here too. Copy left; right, four real
bags pulled live by `buildHeroCollage()` in `main.js`: **unsold only**, real price and photo,
newest first, one per bag type in turn (Shoulder, Top Handle, Crossbody, Bucket at launch).
Under it, `buildCatRow()`: one photo (a bag not already in the hero where possible) and the
count of **available** bags per type. Tapping a tile sets the Available pill AND the type, so
the number on the tile is what the buyer sees. Uncategorised bags are left out of the row.

- **Kept dark on purpose.** The logo is gold script on black; the hero stays black with gold
  glows instead of the light Jirani look. The page body below is already light.
- **Perks come only from her own copy** (How to buy + footer): Pick up in Nairobi CBD ·
  Delivery anywhere in Kenya · One of each, once it's gone it's gone. Delivery is at the
  buyer's cost (settings `location`), so never write "free delivery".
- Tile entrance moves position only, never opacity, so a stalled animation still shows them.
- On a phone the four photos sit in one row above the headline (Jirani rule).
