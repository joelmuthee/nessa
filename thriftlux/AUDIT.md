# ThriftLux audit — against `Website Designs/CATALOG-STANDARDS.md`

Date: 2026-05-12.
Scope: thrift-only. New-stock rules (per-size stock grid, "Only N left" badge, size-required Enquire, size guide modal, Roman-numeral dedup, "One Size" hiding, "Sold out — notify me" semantics) are explicitly skipped per the thrift exclusion in CATALOG-STANDARDS.md "Catalog data model — thrift vs new-stock".

## Status table

| Standard (thrift-relevant only) | Status | Action |
|---|---|---|
| **Animation: fade-in-up on scroll** (hero auto + cards paused→.in-view, IO re-observed after render) | ✗ missing | Phase 3 |
| **Hero** (eyebrow + serif w/ italic accent + 2 CTAs) | ✓ done | — |
| **Availability filter pills** (All / Available / Sold) | ✓ done | — |
| **Category filter pills** (wrap on mobile, not horizontal-scroll) | ✗ missing | Phase 1 |
| **Public search input** (debounced ~180ms, name+desc+category, × clear) | ✗ missing | **Phase 1 — ship now** |
| **Sort dropdown** (Featured / Newest / Price ↑ / Price ↓) | ✗ missing | **Phase 1 — ship now** |
| **NEW badge** (gold ribbon, 7-day window, needs `createdAt`) | ✗ missing | **Phase 1 — ship now** |
| **Wishlist** (heart, localStorage, drawer, bundled WA Enquire) | ✗ missing | Phase 3 |
| **Multi-image carousels on cards** | ✗ missing | Phase 3 |
| **Enquire WA message includes image URL on its own line** (so WA shows preview card) | ✗ missing | **Phase 1 — CRITICAL ship now** |
| **"View on IG" button on each card** | partial — labelled "360° View" | rename in Phase 1 |
| **Pagination 15/page** | ✗ missing (24 bags fit; not urgent) | Phase 3 |
| **Embedded Google Map** for Nairobi CBD drop-off | ✗ missing | Phase 3 |
| **Price-on-request** when price=0 | partial — admin requires price | Phase 2 |
| **Admin sticky sub-nav** with count badges | ✓ done | — |
| **"All items" at the BOTTOM** of admin | ✓ done | — |
| **Admin search above All items** (160ms debounce, "N matches") | ✓ done (shipped commit 941b294) | — |
| **Mobile admin rows** (78×78 thumb, 110px height, single-line) | ✓ done (shipped commit 941b294) | — |
| **Single-word action labels** (Edit / Sell / Delete) | ✓ done (shipped commit 941b294) | — |
| **Sales dashboard** (KPI + top cats + recent sales) | ✓ done | — |
| **Inventory dashboard** (thrift-adapted KPIs + filterable table) | ✓ done | — |
| **WhatsApp Marketing** (recipients dedup, 700ms tabs, copy fallback, "Hi {Firstname}!") | ✓ done | — |
| **Bulk actions** (checkbox + sticky bar) | ✓ done | — |
| **Login form polish** (440px, 16px padding/font) | ✓ done | — |
| **Insights section** (NOT "Analytics" — locked rule) with "(This device only)" badge | ✗ section removed entirely; needs to come back as Insights | **Phase 1 — ship now** |
| **searchNoResults tracking + "Searches with no results" warm-amber pills card** ⭐ killer feature | ✗ missing | **Phase 1 — ship now** |
| **Edit-mode UX**: hide IG quick-add + manual-entry divider, scroll to `#formTitle` with `auto` not `smooth` | ✗ missing | **Phase 1 — ship now** |
| **Long-list custom scrollbar** (gold thumb, surface track) | ✗ missing | **Phase 1 — ship now** |
| **IG quick-add: "⚡ FASTEST WAY" pill + 4px gold-deep left bar** | partial — currently "RECOMMENDED" pill | **Phase 1 — rename** |
| **Worker `/api/ig-fetch?url=`** | ✗ missing — admin panel falls back to friendly error | Phase 2 |
| **Worker `/api/ig-proxy?url=`** (CORS bypass for IG CDN images) | ✗ missing | Phase 2 |
| **Hosting on CF Pages, no `CNAME` file in repo** | partial — repo HAS a CNAME file (mutually incompatible with CF Pages custom domain) | **Phase 1 — remove now** |
| **Mobile nav overlay z-index** (nav 200, .nav-mobile 210) | needs check | Phase 2 |
| **Full OG meta set** (og:image:secure_url, type, locale, twitter:card, canonical) | partial | Phase 3 |

## What I'm shipping in this pass (Phase 1)

1. **WA Enquire message includes image URL** on its own line (so WhatsApp generates the preview card)
2. **Remove `CNAME` file** from repo root (CF Pages incompatibility per gotcha)
3. **Bring back Insights section** (renamed from Analytics per locked rule) with "(This device only)" badge
4. **searchNoResults tracking** in public site + "Searches with no results" warm-amber pills card in admin Insights
5. **Public search input** (debounced 180ms, name+desc+category, × clear button) with no-results tracking wired
6. **Sort dropdown** (Featured / Newest / Price low→high / Price high→low)
7. **NEW badge** (gold ribbon top-left, last 7 days, `createdAt`-driven)
8. **Category filter pills** (alongside Availability), wrapping on mobile
9. **"View on IG" rename** (was "360° View") with IG icon
10. **Admin edit-mode UX**: hide IG quick-add + divider on enter-edit, scroll to `#formTitle` with `auto`
11. **Long-list scrollbar styling** (gold thumb on surface track) for admin lists
12. **IG quick-add pill** renamed from "RECOMMENDED" → "⚡ FASTEST WAY" with 4px gold-deep left bar

## Phase 2 (next pass)

- Worker `/api/ig-fetch` and `/api/ig-proxy` endpoints (currently the admin panel shows a graceful "endpoint not deployed yet" message)
- Price-on-request handling (admin allows blank price → stored as 0 → public shows "Price on request" italic)
- Mobile nav overlay z-index verification

## Phase 3 (later)

- Fade-in-up animation standard (hero auto + cards paused→.in-view IO + accessibility floor)
- Wishlist (heart + localStorage + drawer + bundled WA)
- Multi-image carousels on cards
- Pagination 15/page (not urgent — 24 bags fits)
- Embedded Google Map for Nairobi CBD drop-off
- Full OG meta tag set
