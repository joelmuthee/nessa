# ThriftLux — project-specific LOCKED rules

These OVERRIDE the default `CATALOG-STANDARDS.md` wherever they conflict. Read this before changing ThriftLux behaviour.

## Enquire = straight to WhatsApp, NEVER the Web Share app-picker (LOCKED 2026-06-03)

The owner rejected the OS "select an app" share sheet: *"Enquire now asks me to select an app instead of going straight to WhatsApp!"*

- The Enquire button MUST open `wa.me` **directly** via the anchor's `href` (one tap, straight into the WhatsApp chat).
- Do **NOT** use `navigator.share` / `navigator.canShare` / the Web Share API — that's the "Tier 1" path in `CATALOG-STANDARDS.md`, and it pops the OS app-picker. It was removed once already (`tryShareWithImage` deleted); **do not reintroduce it**, even though the default standard lists Web Share as the primary mobile path.
- The wa.me message already appends the worker `/share/<id>` OG page, so WhatsApp still renders the product preview card (photo + name + price). That link-preview card is the intended "exact item + image" experience here — not a file attachment.

Same locked choice as Nzuri Couture (`nzuri-couture/CLAUDE.md`).
