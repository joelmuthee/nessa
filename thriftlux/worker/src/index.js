// ThriftLux API Worker
// Public:
//   GET  /api/bags                 → { bags, settings }
//   GET  /img/:filename            → image binary (served from KV)
// Admin (Authorization: Bearer <ADMIN_TOKEN>):
//   POST /api/bulk                 → replace { bags, settings }
//   POST /api/image                → upload image, returns { path }
//   GET  /api/ig-discover          → preview new IG posts as bag candidates
//   POST /api/ig-sync              → commit selected candidates to catalog
//   GET  /api/ig-accept-license    → one-shot Llama vision EULA accept
//   GET  /api/ig-classify          → debug a single shortcode through the classifier
// Open IG helpers:
//   GET  /api/ig-fetch?url=        → single-post embed pull (image + caption)
//   GET  /api/ig-proxy?url=        → CORS-friendly IG CDN image proxy
//   GET  /api/ig-feed              → server-side profile feed (seed-time backfill)
//
// Storage (KV binding "BAGS"):
//   "data"        → JSON { bags, settings }
//   "img:<name>"  → base64 string of image binary
//   "mime:<name>" → mime type for the corresponding image

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN;
};

// Master token = billing/agency only. Controls the suspend flag. The shop's
// ADMIN_TOKEN can NOT flip suspend, so the owner can't reactivate themselves.
const isMaster = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.MASTER_TOKEN && auth.slice(7).trim() === env.MASTER_TOKEN.trim();
};

// When the store is suspended (billing kill-switch), the owner keeps READ access
// to the admin but every WRITE is frozen. MASTER (agency) can still write so the
// store can be maintained while suspended. Returns a 403 Response when the caller
// is blocked, or null when the write may proceed. Authoritative gate: the admin
// UI also blocks these, but this is the real lock the owner can't bypass.
const suspendBlock = async (req, env) => {
  if (isMaster(req, env)) return null;
  if ((await env.BAGS.get("suspended")) === "1") {
    return json({ error: "account suspended; contact billing to restore the store" }, 403);
  }
  return null;
};

// SHA-256 hex helper for the owner password flow (Web Crypto, available in
// Workers). Used by /api/check-password and /api/set-password.
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// Decode HTML entities IG slathers across og:description and the embed Caption
// div. Named entities + decimal (&#064;) + hex (&#x40;). Without this, captions
// contain literal "&#064;" instead of "@", which breaks downstream parsing.
const decodeEntities = (s) => (s || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

// ---- Caption → brand/category heuristics for IG bulk sync ----
// ThriftLux stocks pre-loved handbags. Order matters: specific models before
// generic brand fallbacks. Category MUST be one of:
// Crossbody, Shoulder, Tote, Top Handle, Hobo, Bucket, Baguette, Clutch, Sling, Belt Bag
const BAG_BRANDS = [
  // Luxury / premium designers (style hint first when possible)
  ["fendi baguette",    "Fendi",           "Baguette"],
  ["louis vuitton",     "Louis Vuitton",   "Tote"],
  [/\blv\b/,            "Louis Vuitton",   "Tote"],
  ["gucci",             "Gucci",           "Shoulder"],
  ["chanel",            "Chanel",          "Shoulder"],
  ["prada",             "Prada",           "Tote"],
  ["dior",              "Dior",            "Top Handle"],
  ["fendi",             "Fendi",           "Baguette"],
  [/\bhermès\b/,        "Hermès",          "Top Handle"],
  ["hermes",            "Hermès",          "Top Handle"],
  [/\bchloé\b/,         "Chloé",           "Shoulder"],
  ["chloe",             "Chloé",           "Shoulder"],
  [/\bcéline\b/,        "Céline",          "Shoulder"],
  ["celine",            "Céline",          "Shoulder"],
  ["bottega veneta",    "Bottega Veneta",  "Shoulder"],
  ["bottega",           "Bottega Veneta",  "Shoulder"],
  ["mulberry",          "Mulberry",        "Top Handle"],
  // Contemporary / accessible
  ["michael kors",      "Michael Kors",    "Tote"],
  [/\bmk\b/,            "Michael Kors",    "Tote"],
  ["kate spade",        "Kate Spade",      "Crossbody"],
  ["tory burch",        "Tory Burch",      "Tote"],
  ["marc jacobs",       "Marc Jacobs",     "Shoulder"],
  ["furla",             "Furla",           "Shoulder"],
  ["longchamp",         "Longchamp",       "Tote"],
  ["fossil",            "Fossil",          "Crossbody"],
  ["coach",             "Coach",           "Crossbody"],
  ["radley",            "Radley",          "Crossbody"],
  ["guess",             "Guess",           "Crossbody"],
  ["aldo",              "Aldo",            "Crossbody"],
  ["nine west",         "Nine West",       "Crossbody"],
  ["dkny",              "DKNY",            "Crossbody"],
  ["calvin klein",      "Calvin Klein",    "Crossbody"],
  [/\bck\b/,            "Calvin Klein",    "Crossbody"],
  ["victoria's secret", "Victoria's Secret", "Tote"],
  ["victorias secret",  "Victoria's Secret", "Tote"],
  // Generic style fallbacks — apply only when no brand matched.
  ["fanny pack",        null,              "Belt Bag"],
  ["belt bag",          null,              "Belt Bag"],
  ["belt-bag",          null,              "Belt Bag"],
  ["bum bag",           null,              "Belt Bag"],
  ["bucket bag",        null,              "Bucket"],
  ["baguette",          null,              "Baguette"],
  ["top handle",        null,              "Top Handle"],
  ["top-handle",        null,              "Top Handle"],
  ["crossbody",         null,              "Crossbody"],
  ["cross-body",        null,              "Crossbody"],
  ["cross body",        null,              "Crossbody"],
  ["sling bag",         null,              "Sling"],
  ["sling",             null,              "Sling"],
  ["clutch",            null,              "Clutch"],
  ["hobo",              null,              "Hobo"],
  ["shoulder bag",      null,              "Shoulder"],
  ["tote bag",          null,              "Tote"],
  [/\btote\b/,          null,              "Tote"],
];

function deriveBrand(caption) {
  let text = (caption || "").toLowerCase().trim();
  text = text.replace(/^[a-z0-9._]+ /, "");  // strip leading "username "
  const padded = " " + text + " ";
  for (const [key, name, cat] of BAG_BRANDS) {
    if (key instanceof RegExp) {
      if (key.test(padded)) return [name, cat];
    } else if (padded.includes(key)) {
      return [name, cat];
    }
  }
  return [null, null];
}

// Bags are mostly one-of-one and one-size. Captions occasionally mention
// "small/medium/large" or "mini". Default to "One Size" if no hint.
function parseCaptionForBag(caption) {
  const text = (caption || "").trim();
  const lower = text.toLowerCase();
  const cleaned = text.split(/whastup|whatsapp|wa\.me|0746/i)[0].trim().replace(/[.\s]+$/, "");
  let [brand, category] = deriveBrand(caption);
  if (!brand) {
    const first = cleaned.split(/\.\.|,|\n/)[0].trim();
    brand = first ? first.slice(0, 60).replace(/\b\w/g, c => c.toUpperCase()) : "Pre-loved Bag";
    category = category || "Shoulder";
  }
  const stock = {};
  if (/\bmini\b/.test(lower)) stock["Mini"] = 1;
  else if (/\bsmall\b/.test(lower)) stock["Small"] = 1;
  else if (/\bmedium\b/.test(lower)) stock["Medium"] = 1;
  else if (/\blarge\b/.test(lower)) stock["Large"] = 1;
  else stock["One Size"] = 1;
  return {
    name: brand,
    category: category || "Shoulder",
    stock,
    description: "Pre-loved with care. Photographed exactly as it is. Worldwide delivery.",
  };
}

// Permissive "is this a bag/product post" heuristic. Caption contains a known
// brand or a bag-style keyword OR a price hint (e.g. "Ksh 4500", "@4500").
function looksLikeProduct(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  if (/\bksh\s*\d|@\s*\d{3,}|\bprice\b/.test(lower)) return true;
  for (const [key] of BAG_BRANDS) {
    if (key instanceof RegExp ? key.test(lower) : lower.includes(key)) return true;
  }
  // Generic catch: caption mentions "bag", "purse", "clutch" etc.
  if (/\b(?:bag|purse|handbag|clutch|tote|crossbody|shoulder bag|baguette|sling)\b/.test(lower)) return true;
  return false;
}

function arrayToB64(buf) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Vision-model classifier — looks at the actual bag photo + caption.
// Llama 3.2 Vision is GOLD for bags: the photo instantly tells you tote vs
// crossbody vs clutch even when the caption is just "pretty bag 4500".
// Returns { is_product, name, category, reason } or null on failure.
async function classifyPostWithVision(env, caption, imageUrl) {
  if (!env.AI || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { _debug: `img fetch ${imgRes.status}` };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const trimmed = (caption || "").replace(/\s+/g, " ").slice(0, 400);
    const prompt = `You sort Instagram posts from a Nairobi thrift HANDBAG shop (ThriftLux). You're given ONE photo + ONE caption. Decide:
1. Is this a single handbag for sale? (is_product true|false)
2. What brand/style is it? (name — short, e.g. "Coach Crossbody", or "Pre-loved Bag" if unknown)
3. What category? Pick EXACTLY one: Crossbody, Shoulder, Tote, Top Handle, Hobo, Bucket, Baguette, Clutch, Sling, Belt Bag.

NEVER use Shoes, Sneakers, Boots, Sandals, Clothing, Tshirt, Jeans, Dress — ThriftLux only stocks handbags. If the photo shows footwear or clothing or anything that is NOT a handbag, set is_product=false.

Category guide (look at the photo, not just the caption):
- Crossbody: small/medium bag with a long strap worn diagonally across the body.
- Shoulder: medium bag with a single shorter strap that hangs from one shoulder.
- Tote: large open-top bag with two short handles, often unstructured.
- Top Handle: structured bag carried by short top handle(s) (Birkin/Kelly-style).
- Hobo: slouchy crescent shape, single curved shoulder strap.
- Bucket: cylindrical body with drawstring or top-cinch closure.
- Baguette: small rectangular bag with a very short strap, tucked under the arm.
- Clutch: hand-held, no strap, evening/party style.
- Sling: small single-strap bag worn diagonally (smaller than Crossbody).
- Belt Bag: worn around the waist (fanny pack).

is_product=false ONLY for: shop intros, owner photos, marketing slides, announcements, anything that's not a handbag.

Caption: """${trimmed}"""

Reply with strict minified JSON, no prose, no code fences:
{"is_product":true|false,"name":"<brand+style or Pre-loved Bag>","category":"<one from the list>","reason":"<3-6 words>"}`;
    const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      prompt,
      image: Array.from(imgBytes),
      max_tokens: 200,
      temperature: 0.1,
    });
    let parsed = null;
    if (result?.response && typeof result.response === "object") {
      parsed = result.response;
    } else {
      let text = "";
      if (typeof result?.response === "string") text = result.response;
      else if (typeof result?.description === "string") text = result.description;
      else if (typeof result === "string") text = result;
      text = text.trim();
      if (text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
      }
    }
    if (!parsed) return { _debug: "could not parse vision output", raw: JSON.stringify(result).slice(0, 400) };
    return {
      is_product: !!parsed.is_product,
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
      via: "vision",
    };
  } catch (err) {
    return { _debug: `vision throw: ${err.message}` };
  }
}

// Text-only LLM classifier — fallback / second opinion on caption text.
async function classifyPostWithAi(env, caption) {
  if (!env.AI || !caption) return null;
  const trimmed = caption.replace(/\s+/g, " ").slice(0, 400);
  const prompt = `You sort Instagram posts from a Nairobi thrift HANDBAG shop (ThriftLux). Each post is either ONE handbag listed for sale OR a non-product post. Reply with strict minified JSON only, no prose, no code fences.

Schema:
{"is_product": true|false, "name": "<short brand + style OR generic descriptor>", "category": "<one of: Crossbody, Shoulder, Tote, Top Handle, Hobo, Bucket, Baguette, Clutch, Sling, Belt Bag>", "reason": "<3-6 words>"}

NEVER output Shoes, Sneakers, Boots, Sandals, Clothing, Tshirt, Jeans, Dress — ThriftLux only stocks handbags. If the caption clearly describes anything other than a handbag, set is_product=false.

Rules:
- is_product=true when the caption names a handbag brand (Coach, LV, Gucci, Michael Kors, etc.) or a bag style word (tote, crossbody, clutch, baguette, hobo, bucket, sling, belt bag, top handle, shoulder bag).
- is_product=false for shop intros, owner photos, marketing slides, restock announcements, holiday posts.
- name = brand + style when clear (e.g. "Coach Crossbody", "Louis Vuitton Tote"). Fall back to "Pre-loved Bag" when no brand is named.
- Decode shorthand: LV=Louis Vuitton, MK=Michael Kors, CK=Calvin Klein.
- category MUST be one from the list above.

Caption: """${trimmed}"""`;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 120,
    });
    const text = (result?.response || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      is_product: !!parsed.is_product,
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
    };
  } catch (_) {
    return null;
  }
}

// Feed-fetch helper — module-level so /api/ig-feed AND /api/ig-discover share
// logic. Workers can't fetch() their own URL (error 1042).
async function fetchIgFeed({ username, userId: directUserId, count = 50, maxId = "" } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username || ""}/`,
  };
  let userId, user = null, profile = null;
  if (directUserId) {
    userId = directUserId;
    profile = { id: userId, username: username || null };
  } else {
    const pRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers });
    if (!pRes.ok) return { error: `profile lookup ${pRes.status}` };
    const pData = await pRes.json();
    user = pData?.data?.user;
    if (!user?.id) return { error: "user id not found" };
    userId = user.id;
    profile = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followers: user.edge_followed_by?.count,
    };
  }
  const qsTail = `?count=${count}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
  let items = [];
  let moreAvailable = false;
  let nextMaxId = null;
  const embedded = user?.edge_owner_to_timeline_media;
  if (!maxId && embedded?.edges?.length) {
    items = embedded.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl);
    moreAvailable = !!embedded.page_info?.has_next_page;
    nextMaxId = embedded.page_info?.end_cursor || null;
  }
  if (items.length < count && (maxId || moreAvailable || directUserId)) {
    const cursor = maxId || nextMaxId;
    const variables = encodeURIComponent(JSON.stringify({ id: userId, first: count, after: cursor || null }));
    const gqlRes = await fetch(`https://www.instagram.com/graphql/query/?query_hash=003056d32c2554def87228bc3fd9668a&variables=${variables}`, { headers });
    if (gqlRes.ok) {
      const gData = await gqlRes.json();
      const media = gData?.data?.user?.edge_owner_to_timeline_media;
      if (media?.edges?.length) {
        items = items.concat(media.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl));
        moreAvailable = !!media.page_info?.has_next_page;
        nextMaxId = media.page_info?.end_cursor || null;
      }
    }
  }
  if (!items.length) {
    let fRes = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) fRes = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) return { error: `feed fetch ${fRes.status}`, profile };
    const fData = await fRes.json();
    items = (fData.items || []).map(extractFromFeedItem).filter(it => it.imageUrl);
    moreAvailable = !!fData.more_available;
    nextMaxId = fData.next_max_id || null;
  }
  return { profile, items, count: items.length, more_available: moreAvailable, next_max_id: nextMaxId };
}

function extractFromTimelineNode(node) {
  const shortcode = node.shortcode || node.code;
  let imageUrls = [];
  const children = node.edge_sidecar_to_children?.edges || [];
  if (children.length) {
    imageUrls = children.map(({ node: c }) => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (node.display_url) {
    imageUrls = [node.display_url];
  } else if (node.image_versions2?.candidates?.length) {
    imageUrls = [node.image_versions2.candidates[0].url];
  }
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : (node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null),
  };
}

function extractFromFeedItem(m) {
  const carousel = m.carousel_media || [];
  let imageUrls = [];
  if (carousel.length) {
    imageUrls = carousel.map(c => c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (m.image_versions2?.candidates?.length) {
    imageUrls = [m.image_versions2.candidates[0].url];
  }
  const shortcode = m.code;
  const caption = m.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
  };
}

// ---- IG auto-sync (cron) ----
// Same pipeline as the admin's "Check for new posts" widget, minus the human
// review step: fetch the feed, AI-classify (heuristic + vision + text), parse
// name/category from the caption, download the cover image into KV, prepend to
// the catalog in the THRIFT bag shape (sold:false, reel, no stock object).
// 3k+ tier feature (owner directive 2026-06-12). Cap 20/run on Workers Paid.
// Kill switch: KV key `autosync` = {"enabled":false}. Suspended shops skip.
// Stagger slot: 06:20 UTC (Iman holds 06:00 [disabled], Ryker 06:10) — IG
// rate-limits by source IP and the fleet shares Cloudflare egress IPs.
const IG_AUTOSYNC_USER_ID = "27867036937"; // @thriftlux.ke
const API_ORIGIN = "https://thriftlux-api.stawisystems.workers.dev";
const AUTOSYNC_MAX_ITEMS = 20;

async function runIgAutoSync(env) {
  if ((await env.BAGS.get("suspended")) === "1") return { ok: false, skipped: "suspended" };
  let cfg;
  try { cfg = JSON.parse(await env.BAGS.get("autosync")) || {}; } catch { cfg = {}; }
  if (cfg.enabled === false) return { ok: false, skipped: "disabled" };

  const existingRaw = await env.BAGS.get("data");
  const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
  // Dedup against both raw shortcode and ig_<shortcode> forms (legacy ids).
  const existingIds = new Set();
  for (const b of (data.bags || [])) {
    if (!b?.id) continue;
    existingIds.add(b.id);
    if (b.id.startsWith("ig_")) existingIds.add(b.id.slice(3));
    else existingIds.add(`ig_${b.id}`);
  }

  const feed = await fetchIgFeed({ userId: IG_AUTOSYNC_USER_ID, count: 24 });
  if (!feed.items) return { ok: false, error: feed.error || "feed empty" };

  // A few extra candidates beyond the cap so non-bag posts don't eat the run.
  const fresh = feed.items
    .filter(it => it.imageUrl && it.shortcode && !existingIds.has(`ig_${it.shortcode}`) && !existingIds.has(it.shortcode))
    .slice(0, AUTOSYNC_MAX_ITEMS + 3);

  const newBags = [];
  const skipped = [];
  for (const it of fresh) {
    if (newBags.length >= AUTOSYNC_MAX_ITEMS) break;
    const heuristic = looksLikeProduct(it.caption);
    const [vision, text] = await Promise.all([
      classifyPostWithVision(env, it.caption, it.imageUrl),
      classifyPostWithAi(env, it.caption),
    ]);
    const visionOk = vision && !vision._debug;
    const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
    if (!isProduct) { skipped.push({ shortcode: it.shortcode, reason: "not a product" }); continue; }

    // Same name/category resolution as /api/ig-discover, including the
    // drop-if-not-a-bag rule (category coercing to null means clothing/shoes).
    const sug = parseCaptionForBag(it.caption);
    const looksLikeFragment = (n) => !n || /^(bag|size|tn|hh|js\d+|nb)$/i.test(String(n).trim());
    let name = sug.name;
    if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "Pre-loved Bag") {
      name = text.name.trim();
    } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "Pre-loved Bag") {
      name = vision.name.trim();
    }
    let category = coerce(sug.category);
    if (visionOk && vision.is_product && vision.category) {
      const c = coerce(vision.category);
      if (c) category = c;
      else if (vision.category && !ALLOWED.has(vision.category)) {
        skipped.push({ shortcode: it.shortcode, reason: "vision says not a bag" });
        continue;
      }
    } else if (text?.is_product && text.category) {
      const c = coerce(text.category);
      if (c) category = c;
    }
    if (!category) { skipped.push({ shortcode: it.shortcode, reason: "category not a bag" }); continue; }

    // Cover image only on auto-sync; carousel extras via the admin edit form.
    try {
      const r = await fetch(it.imageUrl);
      if (!r.ok) throw new Error(`image fetch ${r.status}`);
      const b64 = arrayToB64(new Uint8Array(await r.arrayBuffer()));
      const fname = `bag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
      await env.BAGS.put(`img:${fname}`, b64);
      await env.BAGS.put(`mime:${fname}`, "image/jpeg");

      const postUrl = `https://www.instagram.com/p/${it.shortcode}/`;
      const bag = {
        id: `ig_${it.shortcode}`,
        name: (name || "Pre-loved Bag").slice(0, 80),
        category,
        description: sug.description,
        price: 0,
        sold: false,
        image: `${API_ORIGIN}/img/${fname}`,
        createdAt: it.takenAt || new Date().toISOString(),
        reel: postUrl,
        instagramUrl: postUrl,
        autoSynced: true,
      };
      newBags.push(bag);
      existingIds.add(bag.id);
      existingIds.add(it.shortcode);
    } catch (e) {
      skipped.push({ shortcode: it.shortcode, reason: e.message });
    }
  }

  if (newBags.length) {
    data.bags = newBags.concat(data.bags);
    // Bump the concurrency rev so any open admin tab refetches before its next
    // save (same guard the manual ig-sync uses — can't clobber fresh bags).
    data.rev = (typeof data.rev === "number" ? data.rev : 0) + 1;
    await env.BAGS.put("data", JSON.stringify(data));
  }
  return { ok: true, added: newBags.length, names: newBags.map(b => b.name), skipped };
}

export default {
  // Cloudflare Cron Trigger (see wrangler.toml [triggers]).
  //   "20 6 * * *" = 09:20 EAT → IG auto-sync (new posts add themselves)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIgAutoSync(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- Public reads ---
    if (request.method === "GET" && path === "/api/bags") {
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [], settings: {} };
      // Optimistic-concurrency version. The admin echoes this back as `baseRev`
      // on every save; /api/bulk rejects (409) any save built on a stale rev so
      // an idle/always-open tab can't overwrite a newer sale. Default 0 for data
      // written before versioning existed.
      if (typeof data.rev !== "number") data.rev = 0;
      // Billing kill-switch: stored in its own KV key so the owner's admin
      // publishes (which only write "data") can never clear it.
      data.suspended = (await env.BAGS.get("suspended")) === "1";
      // Paid-feature gate: loyalty program. Own KV key (like "suspended") so the
      // owner's /api/bulk publishes can never self-unlock it. Flipped by billing.
      data.loyaltyUnlocked = (await env.BAGS.get("loyalty_unlocked")) === "1";
      // PRIVACY: each sold bag carries soldTo { name, phone, notes } — buyer PII.
      // This endpoint is public, and the storefront only ever reads `sold`,
      // `price`, `salePrice` (never soldTo). So strip soldTo for unauthed callers;
      // the admin sends a Bearer token and gets the full data for its Clients view.
      const admin = isAuthed(request, env);
      if (!admin && Array.isArray(data.bags)) {
        data.bags = data.bags.map(b => {
          if (b && b.soldTo) { const { soldTo, ...rest } = b; return rest; }
          return b;
        });
      }
      // The manually-added clients list is owner-only CRM PII — never public.
      if (!admin && data.clients) delete data.clients;
      return json(data, 200, admin
        ? { "Cache-Control": "no-store" }
        : { "Cache-Control": "public, max-age=10" });
    }

    // Billing only: flip the suspend flag. Authed by MASTER_TOKEN (not the shop admin token).
    if (request.method === "POST" && path === "/api/suspend") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const suspended = !!body.suspended;
      await env.BAGS.put("suspended", suspended ? "1" : "0");
      return json({ ok: true, suspended });
    }

    // Billing only: flip the loyalty paid-feature unlock. MASTER_TOKEN gated, like /api/suspend.
    if (request.method === "POST" && path === "/api/loyalty-unlock") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const unlocked = !!body.unlocked;
      await env.BAGS.put("loyalty_unlocked", unlocked ? "1" : "0");
      return json({ ok: true, unlocked });
    }

    const imgMatch = path.match(/^\/img\/(.+)$/);
    if (request.method === "GET" && imgMatch) {
      const name = decodeURIComponent(imgMatch[1]);
      const b64 = await env.BAGS.get(`img:${name}`);
      if (!b64) return new Response("Not found", { status: 404, headers: CORS });
      const mime = (await env.BAGS.get(`mime:${name}`)) || "image/jpeg";
      return new Response(b64ToBytes(b64), {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...CORS,
        },
      });
    }

    // --- Share page: HTML with OpenGraph tags so WhatsApp/FB/iMessage
    //     render a rich preview (bag photo + name). WhatsApp will NOT
    //     preview a bare image URL - it needs an HTML page with og:image.
    //     Humans get redirected straight to the catalogue. ---
    const shareMatch = path.match(/^\/share\/([^/]+)$/);
    if (request.method === "GET" && shareMatch) {
      const id = decodeURIComponent(shareMatch[1]);
      const catalog = "https://nessa.co.ke/thriftlux/";
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [] };
      const bag = (data.bags || []).find((b) => b.id === id);
      if (!bag) return Response.redirect(catalog, 302);
      const esc = (s) => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      let img = bag.image || "";
      if (img && !/^https?:\/\//i.test(img)) img = `${url.origin}/img/${img.split("/").pop()}`;
      const priceTxt = bag.price > 0 ? ` · Ksh ${Number(bag.price).toLocaleString("en-KE")}` : "";
      const desc = (bag.description || `Pre-loved designer handbag on ThriftLux.`).slice(0, 200);
      const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(bag.name)} · ThriftLux</title>
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(bag.name)}${esc(priceTxt)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="600">
<meta property="og:image:height" content="600">
<meta property="og:url" content="${catalog}">
<meta property="og:site_name" content="ThriftLux">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(bag.name)}${esc(priceTxt)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${catalog}">
</head><body style="font-family:system-ui,sans-serif;background:#0d0d0d;color:#ead7a8;text-align:center;padding:60px 20px;">
<p>Opening ThriftLux…</p>
<p><a href="${catalog}" style="color:#c9a961;">Tap here if you're not redirected</a></p>
<script>location.replace(${JSON.stringify(catalog)});</script>
</body></html>`;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS },
      });
    }

    if (path === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Buyer capture → forward to GHL form submit (server-side, no CORS or captcha popup)
    // Owner password — verified server-side so the owner can change it once and
    // it works across every device. Master logins (MASTER_PASSWORD / MASTER_TOKEN)
    // always work for agency recovery.
    if (request.method === "POST" && path === "/api/check-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const pw = String(body.password || "");
      if (!pw) return json({ ok: false, source: null });
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      if ((mp && pw === mp) || (mt && pw === mt)) return json({ ok: true, source: "master" });
      const stored = await env.BAGS.get("adminpass");
      const hashHex = await sha256Hex(pw);
      if (stored) {
        return json({ ok: stored === hashHex, source: stored === hashHex ? "owner" : null });
      }
      const FALLBACK_OWNER_PASSWORD = "thriftlux2026";
      return json({ ok: pw === FALLBACK_OWNER_PASSWORD, source: pw === FALLBACK_OWNER_PASSWORD ? "owner" : null });
    }

    if (request.method === "POST" && path === "/api/set-password") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const current = String(body.current || "");
      const next = String(body.next || "");
      if (!next || next.length < 8) return json({ error: "new password must be at least 8 characters" }, 400);
      const mp = (env.MASTER_PASSWORD || "").trim();
      const mt = (env.MASTER_TOKEN || "").trim();
      let ok = (mp && current === mp) || (mt && current === mt);
      if (!ok) {
        const stored = await env.BAGS.get("adminpass");
        const curHash = await sha256Hex(current);
        if (stored) ok = stored === curHash;
        else ok = current === "thriftlux2026";
      }
      if (!ok) return json({ error: "current password is wrong" }, 401);
      await env.BAGS.put("adminpass", await sha256Hex(next));
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/api/buyer") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { name, phone, notes, bag_name, bag_price, captchaV3 } = body;
      if (!name && !phone) return json({ error: "name or phone required" }, 400);
      const fd = new FormData();
      fd.append("formData", JSON.stringify({
        first_name: name || "",
        phone: phone || "",
        multi_line_280v: [notes, bag_name && `Bag: ${bag_name} (Ksh ${bag_price})`].filter(Boolean).join(" | "),
      }));
      fd.append("locationId", "aTZHRdo8ius6WBzGQ5GD");
      fd.append("formId", "BWrG36c6p56ATDThPdN7");
      fd.append("eventData", JSON.stringify({
        source: "thriftlux-admin",
        type: "page-visit",
        domain: "thriftlux-ke.pages.dev",
      }));
      if (captchaV3) fd.append("captchaV3", captchaV3);
      try {
        const r = await fetch("https://backend.leadconnectorhq.com/forms/submit", {
          method: "POST",
          headers: {
            "Origin": "https://link.essenceautomations.com",
            "Referer": "https://link.essenceautomations.com/widget/form/BWrG36c6p56ATDThPdN7",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: fd,
        });
        const text = await r.text().catch(() => "");
        return json({ ok: r.ok, status: r.status, body: text.slice(0, 500) });
      } catch (err) {
        return json({ ok: false, error: err.message }, 502);
      }
    }

    // ---- Insights: site-wide event tracking (aggregated in KV) ----
    // Public visitors POST events here; the admin reads the aggregate back.
    // Sums every visitor on every device into one shared "stats" tally.
    const TRACK_METRICS = new Set(["itemViews", "itemEnquiries", "itemWishlist", "itemIgClicks", "searchNoResults"]);
    if (request.method === "POST" && path === "/api/track") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const metric = String(body.metric || "");
      const key = String(body.key || "").slice(0, 80).trim();
      if (!TRACK_METRICS.has(metric) || !key) return json({ error: "bad metric/key" }, 400);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      stats[metric] = stats[metric] || {};
      if (metric === "searchNoResults" && !(key in stats[metric]) && Object.keys(stats[metric]).length >= 800) {
        return json({ ok: true, capped: true });
      }
      stats[metric][key] = (stats[metric][key] || 0) + 1;
      stats._lastUpdated = new Date().toISOString();
      await env.BAGS.put("stats", JSON.stringify(stats));
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/insights") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      return json(stats);
    }

    if (request.method === "POST" && path === "/api/insights-reset") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      await env.BAGS.put("stats", JSON.stringify({ _lastUpdated: new Date().toISOString() }));
      return json({ ok: true });
    }

    // --- Admin ---
    if (request.method === "POST" && path === "/api/bulk") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.bags)) return json({ error: "bags must be array" }, 400);
      // Empty-publish guard — prevent a stray test call from wiping the catalog.
      if (body.bags.length === 0 && !body.force) {
        return json({ error: "refusing to publish empty bags array — pass force:true to override" }, 400);
      }
      // Optimistic concurrency: the save must be based on the current rev. This
      // is what stops an always-open / stale admin tab (or old cached admin code)
      // from clobbering a sale another device just recorded — it gets a 409 and
      // the admin retries against fresh data. `force:true` bypasses the check for
      // authoritative one-shot writers (seed tools, recovery scripts).
      const curRaw = await env.BAGS.get("data");
      const curData = curRaw ? JSON.parse(curRaw) : {};
      const curRev = typeof curData.rev === "number" ? curData.rev : 0;
      if (!body.force) {
        if (typeof body.baseRev !== "number") {
          return json({ error: "stale admin — please refresh the page and try again", currentRev: curRev }, 409);
        }
        if (body.baseRev !== curRev) {
          return json({ error: "someone else saved first — refreshing and retrying", currentRev: curRev }, 409);
        }
      }
      const payload = { bags: body.bags, settings: body.settings || {}, rev: curRev + 1 };
      if (Array.isArray(body.clients)) payload.clients = body.clients;
      await env.BAGS.put("data", JSON.stringify(payload));
      return json({ ok: true, count: body.bags.length, rev: payload.rev });
    }

    if (request.method === "POST" && path === "/api/image") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { base64, ext } = body;
      if (!base64) return json({ error: "base64 required" }, 400);
      const safeExt = (ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const name = `bag_${Date.now()}.${safeExt}`;
      const mime = safeExt === "png" ? "image/png" : safeExt === "webp" ? "image/webp" : "image/jpeg";
      await env.BAGS.put(`img:${name}`, base64);
      await env.BAGS.put(`mime:${name}`, mime);
      return json({ path: `/img/${name}`, name });
    }

    // ---- IG image proxy: bypass CORS so the admin can download IG CDN images.
    if (request.method === "GET" && path === "/api/ig-proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "url required" }, 400);
      let host;
      try { host = new URL(target).hostname; } catch { return json({ error: "bad url" }, 400); }
      if (!/(?:^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(host)) {
        return json({ error: "host not allowed" }, 403);
      }
      try {
        const r = await fetch(target);
        if (!r.ok) return json({ error: `upstream ${r.status}` }, 502);
        return new Response(r.body, {
          status: 200,
          headers: {
            "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG quick-add: server-side fetch of a single public IG post ----
    if (request.method === "GET" && path === "/api/ig-fetch") {
      const igUrl = url.searchParams.get("url");
      if (!igUrl) return json({ error: "url required" }, 400);
      const m = igUrl.match(/instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return json({ error: "not an Instagram post URL" }, 400);
      const code = m[1];

      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      };

      try {
        let caption = "", imageUrl = "", imageUrls = [];

        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const img = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i)
            || html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          if (img) imageUrl = img[1].replace(/&amp;/g, "&");
          const capDiv = html.match(/<div[^>]+class=["'][^"']*Caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (capDiv) caption = decodeEntities(capDiv[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          if (!caption) {
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (desc) caption = decodeEntities(desc[1]);
          }
        }

        try {
          const jsonRes = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
            headers: { ...headers, "X-IG-App-ID": "936619743392459" },
          });
          if (jsonRes.ok) {
            const text = await jsonRes.text();
            if (text.trim().startsWith("{")) {
              const data = JSON.parse(text);
              const media = data?.graphql?.shortcode_media || data?.items?.[0] || data?.shortcode_media;
              if (media) {
                const children = media.edge_sidecar_to_children?.edges?.map(e => e.node) || media.carousel_media || [];
                if (children.length) {
                  imageUrls = children.map(c => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
                }
                if (!imageUrls.length) {
                  const single = media.display_url || media.image_versions2?.candidates?.[0]?.url;
                  if (single) imageUrls = [single];
                }
                if (!caption) {
                  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text;
                  if (cap) caption = cap;
                }
              }
            }
          }
        } catch (_) {}

        if (!imageUrl && !imageUrls.length) {
          const pageRes = await fetch(`https://www.instagram.com/p/${code}/`, { headers });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const img = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (img) imageUrl = img[1].replace(/&amp;/g, "&");
            if (desc && !caption) {
              caption = decodeEntities(desc[1]);
              const m1 = caption.match(/^"(.+)"\s*-\s*@/s);
              if (m1) caption = m1[1];
            }
          }
        }

        if (!imageUrls.length && imageUrl) imageUrls = [imageUrl];
        if (!imageUrls.length) return json({ error: "Instagram blocked the request. Paste images manually instead." }, 502);

        return json({
          code,
          imageUrl: imageUrls[0],
          imageUrls,
          caption,
          postUrl: `https://www.instagram.com/p/${code}/`,
          isCarousel: imageUrls.length > 1,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG feed: server-side fetch of a profile's recent posts ----
    if (request.method === "GET" && path === "/api/ig-feed") {
      const username = url.searchParams.get("username");
      const count = Math.min(parseInt(url.searchParams.get("count") || "50", 10), 100);
      const maxId = url.searchParams.get("max_id") || "";
      const directUserId = url.searchParams.get("user_id") || "";
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const result = await fetchIgFeed({ username, userId: directUserId, count, maxId });
        return json(result, result.error ? 502 : 200);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // One-time Llama vision license acceptance. CF Workers AI requires
    // calling the model with prompt='agree' once to accept the EULA before
    // any further inference works.
    if (request.method === "GET" && path === "/api/ig-accept-license") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      try {
        const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 8 });
        return json({ ok: true, response: r });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Debug: classify a single IG shortcode through vision + text models.
    if (request.method === "GET" && path === "/api/ig-classify") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const sc = url.searchParams.get("shortcode");
      const capOverride = url.searchParams.get("caption");
      if (!sc) return json({ error: "shortcode required" }, 400);
      try {
        const feed = await fetchIgFeed({ userId: "27867036937", count: 50 });
        const found = (feed.items || []).find(i => i.shortcode === sc);
        const imageUrl = found?.imageUrl || null;
        const caption = capOverride || found?.caption || "";
        const vision = await classifyPostWithVision(env, caption, imageUrl);
        const text = await classifyPostWithAi(env, caption);
        return json({ shortcode: sc, caption, imageUrl, vision, text_only: text });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: discover new posts (admin-only preview) ----
    if (request.method === "GET" && path === "/api/ig-discover") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const username = url.searchParams.get("username");
      const directUserId = url.searchParams.get("user_id");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const existingRaw = await env.BAGS.get("data");
        const existing = existingRaw ? JSON.parse(existingRaw) : { bags: [] };
        // ThriftLux historical bags use raw shortcode as id (e.g. "DYVFsjwtb5g").
        // Newly synced bags will use `ig_<shortcode>` for clarity. Dedup must
        // check BOTH forms so re-imports don't duplicate.
        const existingIds = new Set();
        for (const b of (existing.bags || [])) {
          if (!b?.id) continue;
          existingIds.add(b.id);
          if (b.id.startsWith("ig_")) existingIds.add(b.id.slice(3));
          else existingIds.add(`ig_${b.id}`);
        }

        const feedData = await fetchIgFeed({ username, userId: directUserId, count: 50 });
        if (!feedData.items) return json({ error: feedData.error || "feed empty" }, 502);

        const fresh = feedData.items.filter(it => !existingIds.has(`ig_${it.shortcode}`) && !existingIds.has(it.shortcode)).slice(0, limit * 2);

        // Server-side category coerce — strip anything that isn't an allowed
        // ThriftLux category. Maps near-misses; drops clothing/footwear (null).
        const ALLOWED = new Set(["Crossbody", "Shoulder", "Tote", "Top Handle", "Hobo", "Bucket", "Baguette", "Clutch", "Sling", "Belt Bag"]);
        const coerce = (c) => {
          if (!c) return c;
          const t = String(c).trim();
          if (ALLOWED.has(t)) return t;
          if (/^cross[-\s]?body$/i.test(t)) return "Crossbody";
          if (/^top[-\s]?handle$/i.test(t)) return "Top Handle";
          if (/^belt[-\s]?bag$/i.test(t)) return "Belt Bag";
          if (/^hand[-\s]?bag$/i.test(t)) return "Shoulder";
          if (/^shoulder[-\s]?bag$/i.test(t)) return "Shoulder";
          if (/^tote[-\s]?bag$/i.test(t)) return "Tote";
          if (/^evening[-\s]?bag$/i.test(t)) return "Clutch";
          if (/^satchel$/i.test(t)) return "Top Handle";
          // ThriftLux sells handbags only — clothing/footwear must NEVER land.
          if (/^(shoes|sneakers?|boots?|sandals?|slides?|loafers?|heels?|formal|footwear|clothing|tshirts?|t-shirts?|shirts?|jeans?|trousers?|dress(?:es)?|coat|jacket|skirt|hat|cap)$/i.test(t)) return null;
          if (/^(bag|purse|other)$/i.test(t)) return null; // too generic — let heuristic win
          return null;
        };

        const classified = await Promise.all(fresh.map(async (it) => {
          const heuristic = looksLikeProduct(it.caption);
          const [vision, text] = await Promise.all([
            classifyPostWithVision(env, it.caption, it.imageUrl),
            classifyPostWithAi(env, it.caption),
          ]);
          const visionOk = vision && !vision._debug;
          // Visions's is_product is authoritative when it returns a clean
          // result — it actually saw the photo so it can rule out non-bags.
          // If vision says it's NOT a product, drop the candidate even if
          // heuristic/text-only thought it was.
          if (visionOk && vision.is_product === false) return null;
          const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
          if (!isProduct) return null;
          const heuristicSuggestion = parseCaptionForBag(it.caption);
          const looksLikeFragment = (n) => !n || /^(bag|size|tn|hh|js\d+|nb)$/i.test(n.trim());
          let name = heuristicSuggestion.name;
          if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "Pre-loved Bag") {
            name = text.name.trim();
          } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "Pre-loved Bag") {
            name = vision.name.trim();
          } else if (visionOk && vision.is_product && vision.name === "Pre-loved Bag") {
            name = "Pre-loved Bag";
          }
          // Category: vision wins (it saw the photo). Then text LLM. Then heuristic.
          // Coerce strips clothing/footwear — if everything coerces to null,
          // the post is not a bag and should be dropped.
          let category = coerce(heuristicSuggestion.category);
          if (visionOk && vision.is_product && vision.category) {
            const c = coerce(vision.category);
            if (c) category = c;
            else if (vision.category && !ALLOWED.has(vision.category)) {
              // Vision explicitly returned a non-bag category (e.g. "Shoes"). Drop.
              return null;
            }
          } else if (text?.is_product && text.category) {
            const c = coerce(text.category);
            if (c) category = c;
          }
          if (!category) return null;
          const reason = visionOk ? vision.reason : (text?.reason || (heuristic ? "matched product heuristic" : ""));
          let classifier = "heuristic";
          if (visionOk && text) classifier = "vision+text";
          else if (visionOk) classifier = "vision";
          else if (text) classifier = "text";
          return {
            ...it,
            suggested: {
              name,
              category,
              stock: heuristicSuggestion.stock,
              description: heuristicSuggestion.description,
            },
            ai_reason: reason,
            classifier,
          };
        }));
        const candidates = classified.filter(Boolean).slice(0, limit);

        return json({
          count: candidates.length,
          scanned: fresh.length,
          items: candidates,
          profile: feedData.profile,
          ai_enabled: !!env.AI,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: commit approved candidates ----
    // POST /api/ig-sync (auth) body: { items: [{ shortcode, name, category, stock, description, imageUrls, takenAt }] }
    // Downloads images from IG CDN, uploads to KV, prepends bag objects to the
    // catalog. Bag shape matches the existing ThriftLux thrift model:
    //   { id, name, category, description, price, sold, image, images?, reel, instagramUrl, createdAt }
    // Admin/agency: run the IG auto-sync on demand (same code the morning cron runs).
    if (request.method === "POST" && path === "/api/autosync-run") {
      if (!isAuthed(request, env) && !isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      const res = await runIgAutoSync(env);
      return json(res, res.ok ? 200 : 400);
    }

    if (request.method === "POST" && path === "/api/ig-sync") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const blocked = await suspendBlock(request, env); if (blocked) return blocked;
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: "items required" }, 400);

      const existingRaw = await env.BAGS.get("data");
      const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
      // Dedup against both raw shortcode and ig_<shortcode> forms.
      const existingIds = new Set();
      for (const b of data.bags) {
        if (!b?.id) continue;
        existingIds.add(b.id);
        if (b.id.startsWith("ig_")) existingIds.add(b.id.slice(3));
        else existingIds.add(`ig_${b.id}`);
      }

      const added = [];
      const errors = [];
      const newBags = [];

      for (const it of items) {
        const id = `ig_${it.shortcode}`;
        if (existingIds.has(id) || existingIds.has(it.shortcode)) {
          errors.push({ shortcode: it.shortcode, reason: "already in catalog" });
          continue;
        }
        const urls = (it.imageUrls || []).slice(0, 4);
        if (!urls.length) { errors.push({ shortcode: it.shortcode, reason: "no images" }); continue; }
        const uploaded = [];
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            const buf = new Uint8Array(await r.arrayBuffer());
            const b64 = arrayToB64(buf);
            const name = `bag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
            await env.BAGS.put(`img:${name}`, b64);
            await env.BAGS.put(`mime:${name}`, "image/jpeg");
            uploaded.push(`${url.origin}/img/${name}`);
          } catch (e) {
            errors.push({ shortcode: it.shortcode, reason: `image fetch: ${e.message}` });
          }
        }
        if (!uploaded.length) continue;
        const postUrl = `https://www.instagram.com/p/${it.shortcode}/`;
        const bag = {
          id,
          name: (it.name || "Pre-loved Bag").slice(0, 80),
          category: it.category || "Shoulder",
          description: it.description || "Pre-loved with care. Photographed exactly as it is. Worldwide delivery.",
          price: 0,
          sold: false,
          image: uploaded[0],
          createdAt: it.takenAt || new Date().toISOString(),
          reel: postUrl,
          instagramUrl: postUrl,
        };
        if (uploaded.length > 1) bag.images = uploaded;
        newBags.push(bag);
        added.push({ shortcode: it.shortcode, id });
        existingIds.add(id);
        existingIds.add(it.shortcode);
      }

      // Newest posts go to the top of the catalog
      data.bags = newBags.concat(data.bags);
      // Bump the concurrency rev so any admin tab open during the sync is forced
      // to refetch before its next save (can't clobber the freshly-added bags).
      data.rev = (typeof data.rev === "number" ? data.rev : 0) + 1;
      await env.BAGS.put("data", JSON.stringify(data));
      return json({ ok: true, added: added.length, errors, items: added });
    }

    return json({ error: "not found" }, 404);
  },
};
