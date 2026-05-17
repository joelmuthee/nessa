# Nessa - Hub site

Vanessa's portfolio: Makeup + Wardrobe Styling + ThriftLux Bags. Hub site at [nessa.essenceautomations.com](https://nessa.essenceautomations.com).

- **Hub home** (`index.html`) - 3-tile chooser, links Bags out to thriftlux.ke
- **Makeup** (`makeup.html`) - gallery of makeup work, tap card -> IG post
- **Styling** (`styling.html`) - gallery of wardrobe / costume work
- **Data** (`data.json`) - 142 posts pulled from @nessamakeupart and auto-classified

## Refreshing the gallery from IG

See [`workflows/nessa_ig_import.md`](workflows/nessa_ig_import.md). Short version:

1. Scrape new posts from `@nessamakeupart` (Chrome MCP, logged in).
2. `python classify.py captions.json` -> categorise each as makeup / styling / both / unclear.
3. Download cover images into `images/posts/`.
4. `python build_data.py` -> rebuild `data.json`.
5. `npx wrangler pages deploy . --project-name=nessa-essenceautomations --branch=main --commit-dirty=true`.

## Project spec

[`NESSA-PLAN.md`](NESSA-PLAN.md) - the architectural decisions and open questions.

## Standards

This project follows the patterns in [`../CATALOG-STANDARDS.md`](../CATALOG-STANDARDS.md), especially:

- "Multi-service owner -- hub site pattern"
- "Animation Standards -- fade-in-up on scroll"
- "Instagram quick-add -- standard workflow" (the og:title trick for caption extraction)
