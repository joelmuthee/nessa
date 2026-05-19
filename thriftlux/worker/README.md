# ThriftLux API Worker

Cloudflare Worker that backs the ThriftLux admin panel. Stores bags + settings in a Cloudflare KV namespace and exposes a tiny REST API.

## Endpoints

| Method | Path             | Auth | Notes |
|--------|------------------|------|-------|
| GET    | `/api/bags`      |  no  | Returns `{ bags, settings }`. Cached 10s at the edge. |
| GET    | `/api/bags/:id`  |  no  | Single bag |
| PATCH  | `/api/bags/:id`  | yes  | Partial update (e.g. `{ "sold": true }`) |
| POST   | `/api/bags`      | yes  | Create. Body must include `name` and `price`. `id` is auto-generated if absent. |
| DELETE | `/api/bags/:id`  | yes  | Remove |
| POST   | `/api/bulk`      | yes  | Replace whole catalogue with `{ bags, settings }` |
| GET    | `/api/health`    |  no  | Returns `{ ok: true }` |

Auth is `Authorization: Bearer <ADMIN_TOKEN>`. CORS allows any origin for GET; mutations require the bearer token.

## Deploy

```bash
cd worker
npm install              # one-time, installs wrangler
npx wrangler login       # one-time, opens browser to your CF account
npx wrangler secret put ADMIN_TOKEN   # paste a long random string when prompted
npm run deploy
```

After deployment, the worker is live at `https://thriftlux-api.<your-subdomain>.workers.dev`. Copy that URL and put it into `main.js` and `admin.js` (search for `API_BASE`).

To later move the API onto `api.thriftlux.essenceautomations.com`:

1. Make sure `essenceautomations.com` is on Cloudflare (orange cloud).
2. Open the Worker in the dashboard → Settings → Triggers → Add Custom Domain.
3. Type `api.thriftlux.essenceautomations.com`. Cloudflare provisions DNS and SSL automatically.
4. Update `API_BASE` in the frontend.

## One-time data migration

After deploy, seed KV with the current `data.json`:

```bash
TOKEN="<your ADMIN_TOKEN>"
URL="https://thriftlux-api.<your-subdomain>.workers.dev"
curl -X POST "$URL/api/bulk" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @../data.json
```

## Local dev

```bash
npm run dev
# Worker runs at http://localhost:8787
```

`wrangler dev` automatically uses your KV namespace via the binding in `wrangler.toml`.
