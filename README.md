# Nessa - Hub site

**Live:** [nessa.essenceautomations.com](https://nessa.essenceautomations.com)

Vanessa's portfolio: Makeup + Wardrobe Styling + ThriftLux Bags. Three lines of work, one phone number.

- **Hub home** (`index.html`) - 3-tile chooser, links Bags out to thriftlux.essenceautomations.com
- **Makeup** (`makeup.html`) - gallery of makeup work, tap card -> IG post
- **Styling** (`styling.html`) - gallery of wardrobe / costume work
- **Data** (`data.json`) - 142 posts pulled from @nessamakeupart and auto-classified

## Deploying

The GitHub -> CF Pages auto-deploy webhook on the `nessa` Pages project silently stops firing after a few hours (known CF bug; see CATALOG-STANDARDS "Catalog hosting"). So **always deploy via the bundled script**, which pushes to git AND directly triggers a wrangler deploy:

```powershell
# Windows
./deploy.ps1 "your commit message"   # commits + pushes + deploys
./deploy.ps1                         # if you already committed, just push + deploy
./deploy.ps1 -SkipPush               # deploy only (no git activity)
```

```bash
# bash / Claude Code / WSL / git-bash
./deploy.sh "your commit message"
./deploy.sh
./deploy.sh --skip-push
```

Live: [nessa.essenceautomations.com](https://nessa.essenceautomations.com)

## Refreshing the gallery from IG

See [`workflows/nessa_ig_import.md`](workflows/nessa_ig_import.md). Short version:

1. Scrape new posts from `@nessamakeupart` (Chrome MCP, logged in).
2. `python classify.py captions.json` -> categorise each as makeup / styling / both / unclear.
3. Download cover images into `images/posts/`.
4. `python build_data.py` -> rebuild `data.json`.
5. `./deploy.ps1 "Import N new posts"` (or `./deploy.sh` from bash).

## Project spec

[`NESSA-PLAN.md`](NESSA-PLAN.md) - the architectural decisions and open questions.

## Standards

This project follows the patterns in [`../CATALOG-STANDARDS.md`](../CATALOG-STANDARDS.md), especially:

- "Multi-service owner -- hub site pattern"
- "Animation Standards -- fade-in-up on scroll"
- "Instagram quick-add -- standard workflow" (the og:title trick for caption extraction)
