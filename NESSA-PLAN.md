# Nessa Hub Site — Project Spec

> **Apply the standards.** General patterns for hub sites, multi-service classification, and IG sourcing live in [`Website Designs/CATALOG-STANDARDS.md`](../CATALOG-STANDARDS.md) ("Multi-service owner — hub site pattern" + "Instagram quick-add — standard workflow"). This file holds only what's specific to Nessa.

**Domain:** `nessa.co.ke` (subdomain of Joel's agency CF zone, Joel owns DNS)

**Owner:** Vanessa ("Nessa"), the same person behind ThriftLux. Three service lines under one umbrella.

**Status:** **LIVE** at [nessa.co.ke](https://nessa.co.ke) since 2026-05-17. Source on GitHub: [joelmuthee/nessa](https://github.com/joelmuthee/nessa).

---

## Three services

1. **Professional makeup** — her core trade. Bio: "Makeup is my art. MUA…"
2. **Wardrobe / costume styling** — Kalasha Nominee 2022 for Best Costume Designer. Real award-nominated portfolio with commercial shoots (Premier Bet, Farmer's Choice, etc.).
3. **ThriftLux** — pre-loved designer bags, the existing catalog at `thriftlux.essenceautomations.com` (her side hustle).

Single IG for makeup + styling: [@nessamakeupart](https://www.instagram.com/nessamakeupart/) (417 posts, 2,545 followers). Bags has its own: [@thriftlux.ke](https://www.instagram.com/thriftlux.ke/).

---

## Decisions locked in (2026-05-17)

| Question | Choice |
|---|---|
| Domain | `nessa.co.ke` (subdomain pattern, see CATALOG-STANDARDS) |
| Categorisation | Read captions of most recent 150 posts and infer makeup vs styling. **IGNORE Highlights** — many are personal. |
| CTA | WhatsApp to book, same number as ThriftLux: **0705 044 940**. No separate booking form for now. |
| Refresh model | Live, incremental import — re-runnable workflow with `STOP_AT` checkpoint, same as ThriftLux |

---

## Hub home page — what visitor sees

3 tiles in a row (stack on mobile per the multi-service hub standard):

| Tile | Headline | Subhead | Click → |
|---|---|---|---|
| Makeup | "Makeup" | "Professional MUA. Editorial, beauty, bridal." | `/makeup.html` (internal) |
| Styling | "Wardrobe Styling" | "Kalasha-nominated costume designer. Editorial + commercial styling." | `/styling.html` (internal) |
| Bags | "ThriftLux Bags" | "Curated pre-loved designer handbags." | `https://thriftlux.essenceautomations.com` (external, new tab) |

Hero above the tiles: 1-sentence intro, her photo / wordmark, single WhatsApp CTA in the nav.

Footer: WhatsApp · IG · **mention Kalasha 2022 nomination as social proof.**

---

## Classification heuristic — first pass (per the hub-site standard)

```js
const isMakeup  = /\bmakeup\b|\bmua\b|\bbeauty\b|\bbridal\b|\blip(s|stick)?\b|\beye\s*(shadow|liner|look)\b|\bglam\b|💄|👄/i.test(caption);
const isStyling = /\bstyl(ing|ed|ist)\b|\bwardrobe\b|\bcostum(e|ing)\b|\boutfit\b|\bfitting\b|\bensemble\b/i.test(caption);
```

Refine these against ~10 real captions before running on all 150. Items where neither matches → `unclear` → CSV for Nessa to tag.

---

## Build phases

1. **Discovery — IG scrape + classification validation.** Pull 150 posts from `@nessamakeupart`, fetch each caption via og:title, run the heuristic, **report makeup/styling/both/unclear breakdown to Joel before writing any pages.** If too many `unclear`, revisit the rules or build an admin tagging step.
2. **Project scaffold.** Fork ThriftLux structure into this folder. Strip price/sold/sizes (portfolio data model per the hub-site standard).
3. **Worker + KV.** New `nessa-api` worker on the same CF account, new KV namespace, mirror ThriftLux's endpoint shape (`/api/posts` instead of `/api/bags`). Seed KV from the 150 scraped posts.
4. **Hub home page.** Three-tile layout, hero, footer, OG meta.
5. **Makeup gallery + Styling gallery.** Reuse ThriftLux gallery render (cards, lightbox, IG link, WhatsApp Enquire). Filter by `category` field on each page.
6. **CF Pages deploy + DNS.** New CF Pages project, custom domain `nessa.co.ke`. Joel adds the CNAME on the agency zone.
7. **Workflow doc.** `workflows/nessa_ig_import.md` mirroring `thriftlux_instagram_import.md` plus the per-post classification step.

---

## Open questions — revisit before / during build

- **Logo / wordmark for the hub.** ThriftLux has its own logo. Does Nessa have a personal/makeup logo, or do we design a wordmark (script "Nessa" in gold on cream)?
- **OG image.** A hero shot of her at work, or a triple-tile mosaic showing all three services?
- **About / bio copy.** Joel drafts, Nessa approves. Must mention Kalasha 2022 nomination — it's serious credibility.
- **Pricing / packages.** Probably not on v1 — keep it WhatsApp-driven like ThriftLux. Confirm before going live.
- **Like pill on portfolio cards?** ThriftLux just shipped one. Worth considering on the makeup/styling galleries too — visual social proof reads less spammy on a portfolio than on a product card. Optional per the catalog standard.

---

## Reference data — Nessa's IG (read 2026-05-17)

- Bio: "Kalasha Nominee 2022 For, Best Costume Designer. Makeup is my art. MUA…"
- 417 posts, 2,545 followers, 6,542 following
- Highlights (mostly personal, IGNORE for categorisation): ThriftLux.ke bags, Motherhood, 2026, #makeupcoverup, Samburu sarova, Corporate shoot, Project, 2025, Naivasha, Premier bet, Farmer's Choice, 2024, SKETCHY AF, Premier
