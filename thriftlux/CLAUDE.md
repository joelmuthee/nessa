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
