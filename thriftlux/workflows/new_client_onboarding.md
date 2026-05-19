# Workflow: Spin Up a New WhatsApp Catalog Site (New Client)

**Objective:** Take a brand-new client (likely an Instagram-based business in Nairobi) and give them a working catalog site with admin panel, in under 15 minutes total.

**This workflow exists so future Claude sessions can act on vague prompts** like:

- "Set up a new catalog for this client"
- "Spin up a new client site"
- "Onboard a new business"
- "Make a new ThriftLux for [business]"
- "I got a new sale, run the script"
- "New client: <Instagram URL>"

When you see prompts like that, follow this workflow.

---

## Tooling

The heavy lifting is done by **`tools/new-client.sh`**. It is interactive, asks the user for the Instagram URL, WhatsApp number, and business name, then deploys a Cloudflare Worker, customises the site, and prints exact next-step instructions.

**Do NOT replicate what the script already does.** Run the script. Read its output. Translate it for the user if needed.

---

## What you do as the agent

### Step 1 — Gather the inputs

Before running the script, make sure you have:

| Input | What it is | Example |
|---|---|---|
| Instagram URL or handle | Client's Instagram presence | `https://instagram.com/lulu_skincare` |
| WhatsApp number | Country code + digits, no `+` or spaces | `254712345678` |
| Business name | Exactly as it should appear on the site | `Lulu Skincare KE` |

If the user only gave you one of these (e.g. just an Instagram URL), **ask for the other two** in a single message before doing anything. Do not invent values.

### Step 2 — Run the script

```bash
cd "C:\Users\Joel\Website Designs\thriftlux-ke"
./tools/new-client.sh
```

The script is interactive. It will prompt for the three inputs. You can either:

- Run it and **let the user type the answers** (they'll see the prompts)
- Or pipe the answers in if you have them and want it automated:

```bash
printf '%s\n%s\n%s\n\n' \
  "<instagram url>" \
  "<whatsapp digits>" \
  "<business name>" \
  | ./tools/new-client.sh
```

(The trailing empty line is the ENTER for the confirmation prompt.)

### Step 3 — Read what the script printed

At the end the script prints:

- The Worker URL (already deployed, nothing to do)
- The admin password
- **Three numbered manual steps** for: pushing to GitHub, enabling GitHub Pages, handing over to the client

Relay these to the user. The script's output is already user-facing — you usually don't need to add to it, just remind them to read it.

### Step 4 — Help with the manual steps if needed

The user may ask you to do parts of the manual steps:

- **`gh repo create`** — if they have `gh` installed, you can run this for them. Default to `--public --source=. --push`.
- **GitHub Pages** — they have to click in their browser. You can't enable it via CLI without admin tokens. Tell them the exact URL: `https://github.com/<user>/<slug>/settings/pages`.
- **Custom domain** — if they have one, add a `CNAME` file with the bare domain, commit, push. They handle the DNS at their registrar themselves (Truehost, Safaricom, etc.).
- **Logo replacement** — wait for them to give you the logo file, then drop it at `images/logo.jpg`, commit, push.

### Step 5 — Save the password

Remind the user to save the admin password immediately. The script does NOT store it anywhere. If they lose it, the only fix is to re-run the script (which gives a new password and recreates the worker).

---

## Pre-requisites the user's machine needs

If `new-client.sh` fails on a fresh setup, check these first:

- `npx wrangler login` — must have run once
- Node.js + npx installed
- Python 3 installed (used inside the script for token generation and JSON manipulation)
- `git`, `bash`, `curl` available
- (Optional) `gh auth login` for auto repo creation

Common failures:

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to create KV namespace` | Cloudflare not authed | `npx wrangler login` |
| `Worker deploy failed` | Same as above OR account doesn't have a workers.dev subdomain set up | Log in to Cloudflare dashboard, set workers.dev subdomain |
| `Folder already exists` | Running twice with same Instagram handle | Delete the old folder or pick a different handle |
| `WhatsApp number should be 10-15 digits` | User pasted a `+` or spaces | Strip non-digits and re-enter |

---

## Buyer name capture popup → GHL

Every site ships with a "Mark as sold" popup in the admin that captures buyer name + phone + notes and forwards them to GHL automatically. This is a **paid feature** — it's the main reason a client pays Ksh 5k/mo instead of running a free Wix site. Without GHL integration, you're just a static catalog. With it, you're a CRM-fed lead engine.

### How the flow works

1. Admin clicks "Mark sold" on a bag in `admin.html`
2. Custom popup opens (Cormorant title, gold accent, dark button — branded)
3. Admin types buyer name + phone (+ optional notes like drop-off location)
4. On Save: bag goes SOLD in KV **and** the buyer details POST to `/api/buyer` on the Worker
5. Worker forwards to `https://backend.leadconnectorhq.com/forms/submit` with a reCAPTCHA Enterprise token + spoofed Origin/Referer headers
6. GHL creates/updates the contact in the client's subaccount, tagged with what they bought

### What you need to set up per client

For each new client you need to provision a GHL form and wire the IDs into both `admin.js` and `worker/src/index.js`. Specifically:

| Place | What to put | Where it currently is (ThriftLux) |
|---|---|---|
| `admin.js` `GHL_RECAPTCHA_KEY` | reCAPTCHA Enterprise site key from the GHL form widget | `6LeDBFwpAAAAAJe8ux9-imrqZ2ueRsEtdiWoDDpX` (this is GHL's global key, same for all forms — leave it as-is) |
| `worker/src/index.js` `formId` | The GHL form's ID | `BWrG36c6p56ATDThPdN7` |
| `worker/src/index.js` `locationId` | The client's GHL subaccount (location) ID | `aTZHRdo8ius6WBzGQ5GD` |
| `worker/src/index.js` `multi_line_280v` field key | The Notes field's query key — varies per form | `multi_line_280v` (regenerated per form) |

To get these: open the GHL subaccount → Sites → Forms → create a form with **First Name, Phone, Multi-line text (Notes)** → Integrate → grab the form ID from the embed snippet's `data-form-id`. Location ID is in the URL of any GHL page (`/v2/location/<locationId>/...`). For the Notes field's query key, click the field in the form builder and read the "Query Key" in the right panel.

### Caveats

- **The captcha route is fragile.** GHL's reCAPTCHA Enterprise key is registered for their domains. Tokens generated from the client's own domain *might* get rejected by GHL's backend. If submissions silently fail (Worker returns `ok:false, status:401`), check the GHL form Settings for a captcha toggle or fall back to one of: paid Inbound Webhook, embedded iframe, or manual contact entry.
- **Don't ship a client site without testing this end-to-end.** Mark a fake bag sold with a test name → check Contacts in their GHL subaccount within 30s. If the contact doesn't appear, the integration is broken and they're paying 5k/mo for nothing.
- **The custom popup HTML lives in `admin.html` (search for `BUYER CAPTURE MODAL`).** The submit logic is in `admin.js` (`commitSold` + `sendBuyerToGHL`). The proxy endpoint is in `worker/src/index.js` (`/api/buyer`). All three need to stay in sync.

### What to tell the client

Don't say "GHL". Say **"Every customer who buys gets saved to your contacts list automatically — so when new stock drops you can WhatsApp them in one click instead of starting from scratch."** That's the value, not the plumbing.

---

## Pricing guidance (only if user asks)

- **Cloudflare Worker free tier**: 100k requests/day. Tiny Nairobi catalogs use <100/day. Free.
- **GitHub Pages**: Free.
- **Domain**: ~Ksh 1,500/year for `.co.ke`, optional. Default `<username>.github.io/<slug>/` works free forever.
- **Joel's pricing model**: Ksh 5,000/month, no setup fee. First 3 months paid upfront (Ksh 15,000) so the build cost is covered before going monthly. Cancel anytime after month 3. Annual upfront option: Ksh 50,000/year (saves 10k vs monthly). Don't quote different numbers without checking with Joel first.

---

## WhatsApp icon on Enquire buttons

Every "Enquire" button on the public site ships with the official WhatsApp glyph beside the text. This is **not optional** — it's the single biggest reason mobile users tap the button. Kenyans recognise the WhatsApp logo before they read the word.

- **Where it lives:** inline SVG inside the button render in `main.js` (search for `wa-icon`). The SVG uses `fill="currentColor"` so it inherits the button colour automatically (dark default, gold on hover).
- **Spacing:** controlled by `.btn-card .wa-icon` in `styles.css` — `vertical-align: -3px; margin-right: 6px;`.
- **Sold-out state:** no icon, just the text "Sold out". Don't add the icon to disabled buttons — defeats the visual cue that the button isn't actionable.

If a future client wants a different chat platform (Telegram, Messenger, etc.) you'd swap the SVG path data + the `whatsappLink()` function in `main.js`. But default ships with WhatsApp because that's what 99% of Nairobi small businesses use.

---

## What this workflow does NOT cover

- **Designing custom layouts per client** — every client gets the ThriftLux template. Customisation is logo, colour, copy.
- **Importing existing Instagram bags** — that's a separate workflow (see `thriftlux_instagram_import.md`). For a new client, start with an empty catalog and let them populate it via the admin.
- **Payments / e-commerce** — these sites are catalog + WhatsApp lead-gen only. No cart, no checkout. Tell the user this if they ask for payment integration; it's a different product.

---

## Notes & gotchas

- **The `slug` is derived from the Instagram handle.** The script lowercases it and strips dots/underscores/dashes. So `@mamamboga.ke` becomes `mamambogake`. This is used as the folder name, the Worker name, and the suggested GitHub repo name. The client never sees it.
- **The admin token is stored as a Cloudflare Worker secret**, not in the source code. GitHub's secret scanner won't flag it. Tokens never get auto-revoked the way a GitHub PAT does.
- **The admin password is hardcoded in `admin.js`** and committed to the public repo. It's a soft barrier (defence-in-depth: the *real* gate is the Worker token, which is server-side). For higher security, swap the password check for a random-token-via-magic-link flow — but that's overkill for the price point.
- **One Worker per client.** Don't try to multi-tenant a single Worker — the per-client Worker isolation is a feature, not a bug. If a client gets popular, their Worker scales independently.
- **GitHub Pages takes 30-60 seconds** to build the site after a push. If the user says "it's not loading" right after enabling Pages, wait a minute and try again before debugging.
