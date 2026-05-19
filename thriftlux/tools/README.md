# Client provisioning

## `new-client.sh` — one-command site spin-up

### How to run it

From the `thriftlux-ke` repo root, just run:

```bash
./tools/new-client.sh
```

No arguments needed. The script asks you 3 questions:

1. **Instagram URL or handle** — paste anything: `https://instagram.com/mamamboga.ke/`, `@mamamboga.ke`, even just `mamamboga.ke`. The script extracts the handle and uses it to name everything internally.
2. **WhatsApp number** — country code + digits, no `+` or spaces. e.g. `254712345678`.
3. **Business name** — exactly as it should appear on the site. e.g. `Mama Mboga Bakery`.

Then it confirms the details, asks you to press ENTER, and runs.

### What it does automatically

1. Copies the ThriftLux template into `~/Website Designs/<slug>/`
2. Wipes ThriftLux's bags, history, CNAME (clean slate)
3. Generates a fresh admin password and a fresh worker token
4. Creates a brand-new Cloudflare Worker named `<slug>-api`
5. Creates a brand-new KV namespace
6. Sets the worker token as a Worker secret (never in source code)
7. Deploys the Worker
8. Rewrites `admin.js` / `main.js` / `index.html` / `admin.html` with the new values
9. Seeds the Worker's KV with an empty catalog + the WhatsApp number
10. Initialises a fresh git repo with one commit on `main`

### What it tells you to do at the end

The script prints exact step-by-step instructions for the 3 manual things you still have to do:

- **STEP 1** — Push to GitHub (one command if you have `gh`, otherwise 6 clicks)
- **STEP 2** — Turn on GitHub Pages (3 clicks in repo settings)
- **STEP 3** — Send the admin URL + password to the client

Plus optional steps when the client is ready:
- Custom domain
- Replace logo
- Tweak brand colour

The password is shown in a box at the end of the run. **Save it immediately** — the script doesn't store it anywhere.

### One-time setup on your machine

Before the first run, install these once:

- Node.js + npx
- Python 3
- `git`, `bash`, `curl`
- `npx wrangler login` (authenticates with Cloudflare)
- `gh auth login` (optional, lets the script auto-create the GitHub repo)

### Cost

Cloudflare Worker free tier covers ~100k requests/day. A small Nairobi catalog won't come close — infra cost per client is essentially zero.

The only ongoing cost is a custom domain (~Ksh 1500/year for `.co.ke`), which is optional. The default `<your-username>.github.io/<slug>/` URL is free forever.

Charge whatever the market bears. Ksh 15-25k setup is reasonable.
