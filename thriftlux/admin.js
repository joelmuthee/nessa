// ThriftLux Admin
// Thrift store: each bag is one-of-one. No stock grid, no restock modal, no
// "Only N left" — sold/available toggle only. See AUDIT.md.
const ADMIN_PASSWORD = 'thriftlux2026';
const API_BASE = 'https://thriftlux-api.stawisystems.workers.dev';
const ADMIN_TOKEN = atob('TGRCVjlCUEJzNTBrWXBzQjdNWUs1eDlUR1ZNNlh3bE5VUEMzTVRzN3BpUQ==');
const SHOP_URL = 'https://nessa.co.ke/thriftlux'; // public storefront — used in WhatsApp messages to clients

let bags = [];
let settings = {};
let clients = []; // manually-added clients (server-synced); sale buyers derived from soldTo
let expenses = []; // operating expenses (ad spend, packaging, etc.) — admin-only, server-synced
let accountSuspended = false;
let loyaltyUnlocked = false;
let dataRev = 0; // optimistic-concurrency version of the catalogue (from /api/bags); echoed back on save
let editingId = null;
// stagedImage = { base64, ext, dataUrl } | null
let stagedImage = null;
// stagedExtras = [{ base64, ext, dataUrl } ...]
let stagedExtras = [];
let bulkSelected = new Set();

// ==================== AUTH ====================
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginBtn = document.getElementById('loginBtn');
const loginPassword = document.getElementById('loginPassword');
const loginError = document.getElementById('loginError');

function checkAuth() {
  if (sessionStorage.getItem('thriftlux_auth') === '1') {
    loginScreen.style.display = 'none';
    dashboard.style.display = 'block';
    init();
  }
}
loginBtn.addEventListener('click', login);
loginPassword.addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
async function login() {
  const pw = loginPassword.value;
  loginError.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/api/check-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const j = await res.json();
    if (j.ok) { sessionStorage.setItem('thriftlux_auth', '1'); checkAuth(); }
    else { loginError.style.display = 'block'; }
  } catch (e) {
    if (pw === ADMIN_PASSWORD) { sessionStorage.setItem('thriftlux_auth', '1'); checkAuth(); }
    else { loginError.style.display = 'block'; }
  }
}
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('thriftlux_auth');
  location.reload();
});

// ====== CHANGE PASSWORD ======
document.getElementById('changePasswordBtn')?.addEventListener('click', () => {
  const m = document.getElementById('changePasswordModal');
  if (!m) return;
  m.style.display = 'flex';
  ['cpCurrent','cpNew','cpConfirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('cpError').style.display = 'none';
  document.getElementById('cpCurrent')?.focus();
});
function _closeChangePassword() { const m = document.getElementById('changePasswordModal'); if (m) m.style.display = 'none'; }
document.getElementById('cpCancelBtn')?.addEventListener('click', _closeChangePassword);
document.getElementById('changePasswordModal')?.addEventListener('click', e => { if (e.target.id === 'changePasswordModal') _closeChangePassword(); });
document.getElementById('cpSaveBtn')?.addEventListener('click', async () => {
  const cur = document.getElementById('cpCurrent').value;
  const nw  = document.getElementById('cpNew').value;
  const cf  = document.getElementById('cpConfirm').value;
  const err = document.getElementById('cpError');
  err.style.display = 'none';
  if (!cur) { err.textContent = 'Enter your current password.'; err.style.display = 'block'; return; }
  if (nw.length < 8) { err.textContent = 'New password must be at least 8 characters.'; err.style.display = 'block'; return; }
  if (nw !== cf) { err.textContent = 'New password and confirmation do not match.'; err.style.display = 'block'; return; }
  const btn = document.getElementById('cpSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(`${API_BASE}/api/set-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: cur, next: nw })
    });
    const j = await res.json();
    if (j.ok) {
      _closeChangePassword();
      showToast('Password changed. You stay signed in; the new password takes effect on next login.');
    } else {
      err.textContent = j.error || 'Could not change password.';
      err.style.display = 'block';
    }
  } catch (e) {
    err.textContent = 'Network error: ' + (e.message || e);
    err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Change password';
  }
});

// ==================== API ====================
// Billing kill-switch: when the store is suspended the owner can still VIEW the
// admin but every write is frozen. The worker is the real gate (403); these
// client guards surface a clean message instead of a raw error. `accountSuspended`
// is set by loadData() from /api/bags.
const SUSPENDED_MSG = 'Your store is offline. Contact Essence Automations to restore it before making changes.';

async function apiUploadImage(base64, ext) {
  if (accountSuspended) throw new Error(SUSPENDED_MSG);
  const res = await fetch(`${API_BASE}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ base64, ext }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed: ${res.status}`);
  }
  const data = await res.json();
  return `${API_BASE}${data.path}`;
}

// Low-level publish of the current in-memory `bags`. Prefer apiMutateAndPublish
// for any user-triggered write — direct use risks clobbering concurrent edits.
// Sends `baseRev` so the worker can reject a save built on stale data (409); on
// a version conflict it throws an error tagged `.conflict` so the caller can
// refetch + reapply. Updates `dataRev` from the worker's new rev on success.
async function publishBags() {
  const res = await fetch(`${API_BASE}/api/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ bags, settings, clients, expenses, baseRev: dataRev }),
  });
  if (res.status === 409) {
    const e = new Error('version conflict'); e.conflict = true; throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save failed: ${res.status}`);
  }
  const out = await res.json().catch(() => ({}));
  if (typeof out.rev === 'number') dataRev = out.rev;
}

// Every admin write MUST go through this. It refetches live KV, applies the
// caller's mutation against the FRESH list, then publishes — so a stale admin
// tab (or a concurrent direct-API edit) can't silently wipe other changes.
// That stale-overwrite was the bug that deleted Venessa's bags once before.
// Mutators close over module-level `bags` and MUST look up bags by id inside
// the callback — any reference captured before the fetch is stale.
//
// Optimistic concurrency: each attempt fetches fresh (capturing `dataRev`),
// reapplies the mutation, and publishes with that baseRev. If another device
// saved in between, the worker returns 409 and we retry against the new data —
// so two devices saving at once never lose a write, they serialize. The mutator
// is written to be idempotent across retries (looks bags up by id on the fresh
// list each time), which is the same contract that already made it safe.
async function apiMutateAndPublish(mutate) {
  if (accountSuspended) throw new Error(SUSPENDED_MSG);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    if (!res.ok) throw new Error(`Failed to load fresh data: ${res.status}`);
    const json = await res.json();
    bags = Array.isArray(json.bags) ? json.bags : [];
    settings = json.settings || {};
    clients = Array.isArray(json.clients) ? json.clients : [];
    expenses = Array.isArray(json.expenses) ? json.expenses : [];
    loyaltyUnlocked = !!json.loyaltyUnlocked;
    dataRev = typeof json.rev === 'number' ? json.rev : 0;
    backfill();
    await mutate();
    try {
      await publishBags();
      return;
    } catch (e) {
      if (e.conflict) continue; // someone saved between our fetch and publish — refetch + reapply
      throw e;
    }
  }
  throw new Error('Another device kept saving at the same time. Please try again.');
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  const json = await res.json();
  bags = json.bags || [];
  settings = json.settings || {};
  clients = Array.isArray(json.clients) ? json.clients : [];
  expenses = Array.isArray(json.expenses) ? json.expenses : [];
  accountSuspended = !!json.suspended;
  loyaltyUnlocked = !!json.loyaltyUnlocked;
  dataRev = typeof json.rev === 'number' ? json.rev : 0;
  backfill();
}

// Owner-facing notice when billing has suspended the store. The public site is
// dark; this tells the owner why and how to restore (they can't unflip it).
function renderSuspendedBanner() {
  let b = document.getElementById('suspendedBanner');
  if (!accountSuspended) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'suspendedBanner';
    b.style.cssText = 'position:sticky;top:0;z-index:9000;background:#b00020;color:#fff;padding:12px 16px;text-align:center;font-size:14px;font-weight:600;line-height:1.4;';
    document.body.prepend(b);
  }
  b.innerHTML = 'Your store is offline and in read-only mode. You can still view everything, but changes are frozen until it\'s restored. Contact Essence Automations to bring it back. <a href="https://wa.me/254720615606" style="color:#fff;text-decoration:underline;">Message us</a>';
}

// Backfill new optional fields onto legacy bags so renders don't crash.
function backfill() {
  bags.forEach(b => {
    if (b.category == null) b.category = '';
    if (!Array.isArray(b.images)) b.images = [];
    if (!b.createdAt) b.createdAt = b.soldTo?.soldAt || new Date().toISOString();
    if (!b.instagramUrl && b.reel) b.instagramUrl = b.reel;
  });
}

// ==================== HELPERS ====================
const toast = document.getElementById('toast');
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

function confirmAction(message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmModalMsg');
    const okBtn = document.getElementById('confirmModalOk');
    const cancelBtn = document.getElementById('confirmModalCancel');
    msgEl.textContent = message;
    okBtn.textContent = okLabel;
    modal.style.display = 'flex';
    const cleanup = result => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}
function setSaving(on) {
  const btn = document.getElementById('saveBtn');
  btn.disabled = on;
  btn.textContent = on ? 'Publishing…' : 'Save bag';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const fmtKsh = n => 'Ksh ' + Number(n || 0).toLocaleString('en-KE');
const isSold = b => !!b.sold;
function salePrice(b) { return Number(b.soldTo?.salePrice ?? b.price ?? 0); }
function soldAt(b) { return b.soldTo?.soldAt || null; }

// ====== MONEY OWED — customer balances (buying on credit / pay later) ======
// Each sold bag carries soldTo.amountPaid (cash taken at sale) + soldTo.payments[]
// (subsequent part-payments). Absent amountPaid is treated as paid in full, so
// historical sales (pre-feature) never appear as owing.
function saleTotal(b) { return (b.sold && b.soldTo) ? Number(b.soldTo.salePrice ?? b.price ?? 0) : 0; }
function salePaid(b) {
  if (!b.sold || !b.soldTo) return 0;
  const total = saleTotal(b);
  const initial = (b.soldTo.amountPaid != null) ? Math.max(0, Number(b.soldTo.amountPaid) || 0) : total;
  const extra = (b.soldTo.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return Math.min(total, initial + extra);
}
function saleBalance(b) { return Math.max(0, saleTotal(b) - salePaid(b)); }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function startOfMonth(d) { const x = new Date(d.getFullYear(), d.getMonth(), 1); x.setHours(0,0,0,0); return x; }
function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms/60000), h = Math.round(ms/3600000), d = Math.round(ms/86400000);
  if (ms < 60000) return 'just now';
  if (m < 60) return m + 'm ago';
  if (h < 48) return h + 'h ago';
  if (d < 14) return d + 'd ago';
  return new Date(iso).toLocaleDateString('en-KE');
}
// Short readable date, e.g. "6 Jun 2026". Used by the Owed dashboard + reminder.
// (The Owed feature was ported referencing this helper but it was never carried
// over, so renderOwed threw "fmtDate is not defined" and the dashboard rendered
// blank — no rows, no Remind button — even when money was owed.)
function fmtDate(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  return dt.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Best-effort "added to the website" timestamp: explicit createdAt, else the IG
// post date (takenAt; epoch-seconds or ISO), else the millis baked into a manual id.
// Returns an ISO string, or null if nothing usable.
function itemAddedAt(bag) {
  if (bag.createdAt) return bag.createdAt;
  if (bag.takenAt != null) {
    const t = bag.takenAt;
    if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t).toISOString();
    return t;
  }
  const m = String(bag.id || '').match(/_(\d{10,})/);
  return m ? new Date(parseInt(m[1], 10)).toISOString() : null;
}
// Re-encode any uploaded image to JPEG, max 1280px, quality 0.82, alpha
// flattened onto white. WhatsApp's link-preview crawler skips images that are
// too heavy (multi-MB PNGs) or webp, so the /share/<id> OG card silently breaks
// unless every staged image is a lean JPEG. All staged images become ext 'jpg'.
function blobToStagedJpeg(blob, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.split(',')[1], ext: 'jpg', dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}
function readFileAsStaged(file) { return blobToStagedJpeg(file); }

// ==================== ADD/EDIT FORM ====================
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const extraImagesInput = document.getElementById('extraImagesInput');
const extraImagesPreview = document.getElementById('extraImagesPreview');
const nameInput = document.getElementById('nameInput');
const categoryInput = document.getElementById('categoryInput');
const descInput = document.getElementById('descInput');
const priceInput = document.getElementById('priceInput');
const salePriceInput = document.getElementById('salePriceInput');
const costInput = document.getElementById('costInput');
const reelInput = document.getElementById('reelInput');
const soldInput = document.getElementById('soldInput');
const editingIdField = document.getElementById('editingId');
const formTitle = document.getElementById('formTitle');
const cancelBtn = document.getElementById('cancelBtn');

imageInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  stagedImage = await readFileAsStaged(file);
  imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:200px;border-radius:8px;">`;
});

extraImagesInput.addEventListener('change', async e => {
  const files = Array.from(e.target.files || []).slice(0, 8 - stagedExtras.length);
  for (const f of files) stagedExtras.push(await readFileAsStaged(f));
  renderExtras();
  extraImagesInput.value = '';
});

function renderExtras() {
  extraImagesPreview.innerHTML = stagedExtras.map((s, i) => `
    <div class="extra-img">
      <img src="${s.dataUrl || s}" alt="">
      <button type="button" class="extra-img-rm" data-i="${i}" title="Remove">&times;</button>
    </div>
  `).join('');
  extraImagesPreview.querySelectorAll('.extra-img-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      stagedExtras.splice(parseInt(btn.dataset.i, 10), 1);
      renderExtras();
    });
  });
}

// IG quick-add — uses the worker's /api/ig-fetch when available. Fails politely otherwise.
// Parse an IG caption into { name, price, description, sold } honouring the
// Nairobi-thrift conventions Venessa writes. Permissive price detection:
// "@1500 /=", "4000/=", "1500/-", "Ksh 4000". Description keeps the full
// caption (only the IG handle prefix + hashtags stripped) so product detail
// survives. Name = the text before the price marker.
function parseIgCaption(raw) {
  if (!raw) return { name: '', price: null, description: '', sold: false };
  const clean = raw
    .replace(/^[a-z0-9._]+\s+/i, '')   // leading IG handle ("thriftlux.ke ")
    .replace(/#\w+/g, '')              // hashtags
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sold = /\bSOLD(?:\s*OUT)?\b/i.test(clean);
  const patterns = [
    /@\s*(\d{2,7})\s*\/?=?/i,
    /(\d{2,7})\s*\/=/,
    /(\d{2,7})\s*\/-/,
    /\b(?:ksh\.?|kes)\s*(\d{2,7})/i,
  ];
  let m = null;
  for (const re of patterns) { const hit = clean.match(re); if (hit) { m = hit; break; } }
  let name, price;
  if (m) {
    name = (clean.slice(0, m.index).trim() || clean.split(/[\n.!?]/)[0] || '').trim();
    price = parseInt(m[1], 10);
  } else {
    name = (clean.split(/[\n.!?]/)[0] || clean).trim();
    price = null;
  }
  // Description keeps the caption detail but NOT the price (it has its own field —
  // owner rule 2026-06-17) or the SOLD flag. Em/en dashes → commas (copy standard).
  const description = clean
    .split(/dm to order|dm to buy|inbox|order now/i)[0]
    .replace(/\d[\d,]*(?:\.\d+)?\s*\/[=\-]/g, '')
    .replace(/(?:ksh?s?\.?|kes)\s*\.?\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, '')
    .replace(/@\s*\d[\d,]*(?:\.\d+)?\s*k?\b/gi, '')
    .replace(/\s*\/[=\-]/g, '')
    .replace(/\s*@(?!\w)/g, '')
    .replace(/\bsold(?:\s*out)?\b/gi, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.,\-:;]+|[\s.,\-:;]+$/g, '')
    .trim();
  return { name, price, description, sold };
}

document.getElementById('igQuickBtn').addEventListener('click', async () => {
  const url = document.getElementById('igQuickInput').value.trim();
  const status = document.getElementById('igQuickStatus');
  if (!url) { status.className = 'ig-quick-status err'; status.textContent = 'Paste an Instagram URL first.'; return; }
  status.className = 'ig-quick-status'; status.textContent = 'Fetching…';
  try {
    const r = await fetch(`${API_BASE}/api/ig-fetch?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error('endpoint not deployed yet');
    const data = await r.json();
    if (data.imageUrl) {
      // CORS-critical: IG CDN doesn't send Access-Control-Allow-Origin, so the
      // image MUST be fetched through the Worker's /api/ig-proxy. A direct
      // fetch of cdninstagram.com / fbcdn.net throws "Failed to fetch".
      const proxied = `${API_BASE}/api/ig-proxy?url=${encodeURIComponent(data.imageUrl)}`;
      const imgRes = await fetch(proxied);
      if (!imgRes.ok) throw new Error(`ig-proxy ${imgRes.status}`);
      const blob = await imgRes.blob();
      stagedImage = await blobToStagedJpeg(blob);
      imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:200px;border-radius:8px;">`;
    }
    if (data.caption) {
      const parsed = parseIgCaption(data.caption);
      if (parsed.name) nameInput.value = parsed.name;
      if (parsed.price != null) priceInput.value = parsed.price;
      descInput.value = parsed.description;
      if (parsed.sold) soldInput.checked = true;
    }
    if (data.postUrl) reelInput.value = data.postUrl;
    const manualEntry = document.getElementById('manualEntry');
    if (manualEntry) manualEntry.open = true;  // reveal the auto-filled fields
    status.className = 'ig-quick-status ok';
    status.textContent = '✓ Loaded. Edit anything above, then click Save bag.';
  } catch(e) {
    status.className = 'ig-quick-status err';
    status.textContent = '✗ IG fetch endpoint not deployed yet. Use the manual flow in workflows/thriftlux_instagram_import.md — download the reel cover, then use the Main image picker below.';
  }
});

document.getElementById('aiBtn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { showToast('Type the bag name first.'); return; }
  descInput.value = generateDescription(name, getCategoryValue());
});

function generateDescription(name, cat) {
  const lower = name.toLowerCase();
  const colors = { black:'sleek black', white:'crisp white', beige:'warm beige', brown:'rich brown', caramel:'caramel', grey:'soft grey', gray:'soft grey', blue:'deep blue', denim:'denim blue', green:'rich green', cream:'soft cream', tan:'warm tan' };
  let color = '';
  for (const c in colors) if (lower.includes(c)) { color = colors[c]; break; }
  const mats = ['leather','suede','patent','canvas','denim','vegan leather','croc-embossed leather','quilted leather'];
  const mat = mats.find(m => lower.includes(m)) || 'leather';
  const style = (cat || '').toLowerCase() || (['crossbody','shoulder','tote','clutch','hobo','bucket','baguette','top handle','sling'].find(s => lower.includes(s)) || 'handbag');
  const openers = [
    `Beautifully crafted ${color || 'designer-style'} ${mat} ${style} bag.`,
    `A statement ${color || ''} ${mat} ${style}, hand-picked.`,
    `${(color ? color[0].toUpperCase() + color.slice(1) : 'Classic')} ${mat} ${style} silhouette.`,
  ];
  const middles = [
    `Quality reviewed and ready for its next chapter.`,
    `Hand-picked for ThriftLux. Clean lines and timeless appeal.`,
    `Pre-loved with care, photographed exactly as it is.`,
  ];
  const closers = [
    `One-of-one. Once it's gone, it's gone.`,
    `Tap Enquire to chat with Venessa on WhatsApp.`,
    `Drop-off in Nairobi CBD, or arrange delivery.`,
  ];
  return [openers, middles, closers].map(a => a[Math.floor(Math.random()*a.length)]).join(' ');
}

document.getElementById('saveBtn').addEventListener('click', saveBag);
cancelBtn.addEventListener('click', resetForm);

async function saveBag() {
  const name = nameInput.value.trim();
  const price = parseInt(priceInput.value, 10);
  const desc = descInput.value.trim();
  const reel = reelInput.value.trim();
  const category = getCategoryValue();
  const sold = soldInput.checked;
  if (!name) { showToast('Bag name is required.'); return; }
  if (!price || price < 0) { showToast('Enter a valid price.'); return; }

  // Sale price: optional. Must be a positive number below the regular price.
  // Blank/0 = not on sale. Invalid (>= price) is rejected so it can't silently
  // produce a "discount" that isn't one.
  const salePriceRaw = salePriceInput.value.trim();
  let salePrice = null;
  if (salePriceRaw !== '') {
    salePrice = parseInt(salePriceRaw, 10);
    if (isNaN(salePrice) || salePrice <= 0) { showToast('Sale price must be a positive number, or leave it blank.'); return; }
    if (salePrice >= price) { showToast('Sale price must be lower than the regular price.'); return; }
  }

  // Buying price (cost): optional, for the owner's profit tracking. Blank/0 = not recorded.
  const costRaw = costInput.value.trim();
  const cost = costRaw === '' ? 0 : Math.max(0, parseInt(costRaw, 10) || 0);

  setSaving(true);
  try {
    let imagePath = null;
    if (stagedImage) {
      showToast('Uploading main image…');
      imagePath = await apiUploadImage(stagedImage.base64, stagedImage.ext);
    }

    // Upload any NEW extras (those that have base64; existing string URLs pass through)
    const extraPaths = [];
    for (const s of stagedExtras) {
      if (typeof s === 'string') { extraPaths.push(s); continue; }
      const p = await apiUploadImage(s.base64, s.ext);
      extraPaths.push(p);
    }

    if (editingId) {
      await apiMutateAndPublish(() => {
        const bag = bags.find(b => b.id === editingId);
        if (!bag) throw new Error('Bag no longer exists — refresh admin');
        bag.name = name; bag.description = desc; bag.price = price;
        bag.category = category; bag.reel = reel; bag.instagramUrl = reel || bag.instagramUrl;
        if (imagePath) bag.image = imagePath;
        if (extraPaths.length) bag.images = extraPaths;
        bag.sold = sold;
        if (salePrice) bag.salePrice = salePrice; else delete bag.salePrice;
        if (cost) bag.cost = cost; else delete bag.cost;
        if (!sold) delete bag.soldTo;
      });
      showToast('Bag updated and live!');
    } else {
      if (!stagedImage) { showToast('Add a bag image.'); setSaving(false); return; }
      await apiMutateAndPublish(() => {
        const id = 'bag_' + Date.now();
        const bag = {
          id, name, description: desc, category, price,
          reel, instagramUrl: reel, sold,
          image: imagePath,
          images: extraPaths,
          createdAt: new Date().toISOString(),
        };
        if (salePrice) bag.salePrice = salePrice;
        if (cost) bag.cost = cost;
        bags.unshift(bag);
      });
      showToast('Bag added and live!');
    }
    resetForm();
    renderAll();
  } catch(err) {
    showToast('Sync failed: ' + err.message);
    console.error(err);
  } finally {
    setSaving(false);
  }
}

// ===== Category field helpers =====
// The form category <select> is a fixed list, but the shop owner can add their
// own. Picking "+ Add new category…" reveals a free-text box; any category that
// already exists on an item is auto-injected so it shows up for everyone after.
function toggleNewCategoryInput() {
  const sel = document.getElementById('categoryInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel || !box) return;
  if (sel.value === '__new__') {
    box.style.display = '';
    box.focus();
  } else {
    box.style.display = 'none';
    box.value = '';
  }
}

// Read the chosen category, resolving the "+ Add new…" free-text path.
function getCategoryValue() {
  const sel = document.getElementById('categoryInput');
  if (!sel) return '';
  if (sel.value === '__new__') {
    return document.getElementById('categoryNewInput').value.trim();
  }
  return sel.value || '';
}

// Set the select to a category, injecting it as an option if it isn't a
// built-in one (so editing a custom-category item shows it selected).
function setCategoryValue(cat) {
  const sel = document.getElementById('categoryInput');
  const box = document.getElementById('categoryNewInput');
  if (!sel) return;
  if (box) { box.style.display = 'none'; box.value = ''; }
  const c = cat || '';
  if (!c) { sel.value = ''; return; }
  const exists = [...sel.options].some(o => o.value === c);
  if (!exists) ensureCategoryOption(c);
  sel.value = c;
}

// Ensure a category exists as a <option> in the select. Custom (owner-added)
// categories land in a dedicated "Your categories" group above "+ Add new…".
function ensureCategoryOption(cat) {
  const sel = document.getElementById('categoryInput');
  if (!sel || !cat) return;
  if ([...sel.options].some(o => o.value === cat)) return;
  let group = document.getElementById('customCatGroup');
  if (!group) {
    group = document.createElement('optgroup');
    group.id = 'customCatGroup';
    group.label = 'Your categories';
    const newOpt = [...sel.options].find(o => o.value === '__new__');
    sel.insertBefore(group, newOpt || null);
  }
  const opt = document.createElement('option');
  opt.value = cat;
  opt.textContent = cat;
  group.appendChild(opt);
}

// Sweep every category already used on an item into the dropdown, so an
// owner-added category becomes a permanent choice for all future items.
// Works for flat OR optgroup selects: the built-in option values are
// snapshotted once (before any custom injection) so we never re-classify
// a built-in as custom.
let _builtinCatValues = null;
function syncCustomCategories() {
  const sel = document.getElementById('categoryInput');
  if (!sel) return;
  if (!_builtinCatValues) {
    _builtinCatValues = new Set([...sel.options].map(o => o.value).filter(v => v && v !== '__new__'));
  }
  [...new Set(bags.map(b => b.category).filter(Boolean))]
    .filter(c => !_builtinCatValues.has(c))
    .sort((a, b) => a.localeCompare(b))
    .forEach(ensureCategoryOption);
}

function resetForm() {
  editingId = null;
  editingIdField.value = '';
  nameInput.value = ''; descInput.value = ''; priceInput.value = '';
  salePriceInput.value = '';
  costInput.value = '';
  reelInput.value = ''; setCategoryValue('');
  soldInput.checked = false;
  imageInput.value = ''; imagePreview.innerHTML = ''; stagedImage = null;
  extraImagesInput.value = ''; stagedExtras = []; renderExtras();
  document.getElementById('igQuickInput').value = '';
  document.getElementById('igQuickStatus').textContent = '';
  formTitle.textContent = 'Add a new bag';
  cancelBtn.style.display = 'none';
  // Restore IG quick-add panel + manual divider that editBag() hid
  const igPanel = document.getElementById('igQuickPanel');
  const manualDiv = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = '';
  if (manualDiv) manualDiv.style.display = '';
  const manualEntry = document.getElementById('manualEntry');
  if (manualEntry) manualEntry.open = false;
}

function editBag(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  editingId = id;
  editingIdField.value = id;
  nameInput.value = bag.name; descInput.value = bag.description || '';
  priceInput.value = bag.price; reelInput.value = bag.reel || bag.instagramUrl || '';
  salePriceInput.value = bag.salePrice || '';
  costInput.value = bag.cost || '';
  setCategoryValue(bag.category || '');
  soldInput.checked = !!bag.sold;
  stagedImage = null;
  imagePreview.innerHTML = `<img src="${bag.image}" style="max-width:200px;border-radius:8px;">`;
  stagedExtras = (bag.images || []).slice().map(url => url);
  renderExtrasForEdit(stagedExtras);
  formTitle.textContent = 'Edit bag';
  cancelBtn.style.display = 'inline-block';

  // Edit-mode UX (CATALOG-STANDARDS.md): hide the IG quick-add panel + the
  // "or upload manually below" divider — they're confusing during edit. Then
  // scroll to the form heading (NOT the form container, which lands on the
  // hidden IG panel anyway). Use `auto` not `smooth` — smooth scrolling
  // across a long admin page reads as lag.
  const igPanel = document.getElementById('igQuickPanel');
  const manualDiv = document.getElementById('manualEntryDivider');
  if (igPanel) igPanel.style.display = 'none';
  if (manualDiv) manualDiv.style.display = 'none';
  const manualEntry = document.getElementById('manualEntry');
  if (manualEntry) manualEntry.open = true;  // edit hides the toggle, so .open is what reveals the fields
  document.getElementById('formTitle').scrollIntoView({ behavior: 'auto', block: 'start' });
}

// While editing, mix existing URL strings with new staged uploads.
function renderExtrasForEdit(list) {
  extraImagesPreview.innerHTML = list.map((s, i) => {
    const src = typeof s === 'string' ? s : s.dataUrl;
    return `
      <div class="extra-img">
        <img src="${src}" alt="">
        <button type="button" class="extra-img-rm" data-i="${i}" title="Remove">&times;</button>
      </div>`;
  }).join('');
  extraImagesPreview.querySelectorAll('.extra-img-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      stagedExtras.splice(parseInt(btn.dataset.i, 10), 1);
      renderExtrasForEdit(stagedExtras);
    });
  });
}

async function deleteBag(id) {
  if (!await confirmAction('Delete this bag? This cannot be undone.', 'Delete')) return;
  let removed = null, removedIdx = -1;
  try {
    await apiMutateAndPublish(() => {
      removedIdx = bags.findIndex(b => b.id === id);
      removed = removedIdx === -1 ? null : bags[removedIdx];
      bags = bags.filter(b => b.id !== id);
    });
    renderAll();
    showToast('Bag deleted.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
}

async function toggleSold(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  if (bag.sold) {
    try {
      await apiMutateAndPublish(() => {
        const b = bags.find(x => x.id === id);
        if (b) { b.sold = false; delete b.soldTo; }
      });
      renderAll();
      showToast('Marked as available.');
    } catch(err) { showToast('Sync failed: ' + err.message); }
    return;
  }
  // If she's multi-selected bags and taps Sell on one of them, she means the
  // batch — route to the bulk "sell to one customer" flow instead of single.
  if (bulkSelected.size >= 2 && bulkSelected.has(id)) { bulkSell(); return; }
  openBuyerModal(bag);
}

// ==================== BUYER CAPTURE MODAL ====================
const buyerModal = document.getElementById('buyerModal');
const buyerName = document.getElementById('buyerName');
const buyerPhone = document.getElementById('buyerPhone');
const buyerNotes = document.getElementById('buyerNotes');
let pendingBag = null;

function openBuyerModal(bag) {
  pendingBag = bag;
  buyerName.value = ''; buyerPhone.value = ''; buyerNotes.value = '';
  const bcs = document.getElementById('buyerCustSearch'); if (bcs) bcs.value = '';
  const bcr = document.getElementById('buyerCustResults'); if (bcr) { bcr.style.display = 'none'; bcr.innerHTML = ''; }
  document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  // Reset amount-paid input (Owed feature) — default to paid in full
  const paid = document.getElementById('buyerPaid');
  if (paid) { paid.value = ''; paid.placeholder = 'Paid in full'; }
  document.getElementById('buyerPaidHint')?.style.setProperty('display', 'none');
  document.getElementById('buyerPaidNone')?.classList.remove('active');
  const bagPrice = Number(bag.salePrice && bag.salePrice < bag.price ? bag.salePrice : bag.price) || 0;
  // Pre-fill the editable selling-price field — owner can override it for bargaining.
  const priceInput = document.getElementById('buyerPrice');
  if (priceInput) priceInput.value = bagPrice || '';
  document.getElementById('buyerModalTitle').textContent = `Mark as sold: ${bag.name}` + (bagPrice ? ` · ${fmtKsh(bagPrice)}` : '');
  buyerModal.style.display = 'flex';
  buyerName.focus();
}
function closeBuyerModal() { buyerModal.style.display = 'none'; pendingBag = null; }

async function commitSold(withBuyer) {
  if (!pendingBag) return;
  const targetId = pendingBag.id;
  const payMethod = document.querySelector('#saleModalPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  let buyerInfo = null;
  if (withBuyer) {
    const name = buyerName.value.trim();
    const phone = buyerPhone.value.trim().replace(/[^0-9+]/g, '');
    const notes = buyerNotes.value.trim();
    if (!name && !phone) { showToast('Add a name or phone, or hit Skip.'); return; }
    buyerInfo = { name, phone, notes };
  }
  closeBuyerModal();
  try {
    let soldBag = null;
    await apiMutateAndPublish(() => {
      const b = bags.find(x => x.id === targetId);
      if (!b) throw new Error('Bag no longer exists — refresh admin');
      b.sold = true;
      // Selling price: prefer the override the owner typed into the modal (for
      // bargaining). Fall back to the catalog's sale-price-or-regular-price.
      const catalogPrice = (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0);
      const priceRaw = (document.getElementById('buyerPrice')?.value || '').trim();
      const overridden = priceRaw !== '' && !isNaN(parseInt(priceRaw, 10));
      const paid = overridden ? Math.max(0, parseInt(priceRaw, 10)) : catalogPrice;
      // Owed feature: capture the cash actually taken at sale time. Blank = paid
      // in full (don't write amountPaid so historical sales stay paid-in-full).
      const paidRaw = (document.getElementById('buyerPaid')?.value || '').trim();
      const soldTo = withBuyer
        ? { ...buyerInfo, soldAt: new Date().toISOString(), salePrice: paid, paymentMethod: payMethod }
        : { soldAt: new Date().toISOString(), salePrice: paid, paymentMethod: payMethod };
      if (paidRaw !== '') {
        soldTo.amountPaid = Math.min(paid, Math.max(0, parseInt(paidRaw, 10) || 0));
      }
      b.soldTo = soldTo;
      delete b.salePrice; // no longer "on sale" once sold
      soldBag = b;
    });
    renderAll();
    showToast(withBuyer ? 'SOLD. Buyer saved.' : 'Marked as SOLD.');
    if (withBuyer && soldBag?.soldTo?.phone) { sendBuyerToGHL(soldBag); if (loyaltyUnlocked) openSaleThanks(soldBag); }
    if (soldBag) {
      lastPosSale = { name: soldBag.name, size: soldBag.size || '', qty: 1, amount: Number(soldBag.soldTo.salePrice || soldBag.price || 0), paymentMethod: payMethod, buyerName: soldBag.soldTo.name || '', buyerPhone: soldBag.soldTo.phone || '', soldAt: soldBag.soldTo.soldAt };
      showPosReceipt(lastPosSale);
      document.getElementById('posDash')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch(err) {
    showToast('Sync failed: ' + err.message);
  }
}

const GHL_RECAPTCHA_KEY = '6LeDBFwpAAAAAJe8ux9-imrqZ2ueRsEtdiWoDDpX';
async function getCaptchaToken() {
  if (!window.grecaptcha?.enterprise) return '';
  return new Promise(resolve => {
    grecaptcha.enterprise.ready(async () => {
      try {
        const token = await grecaptcha.enterprise.execute(GHL_RECAPTCHA_KEY, { action: 'submit' });
        resolve(token);
      } catch { resolve(''); }
    });
  });
}
async function sendBuyerToGHL(bag) {
  try {
    const captchaV3 = await getCaptchaToken();
    const r = await fetch(`${API_BASE}/api/buyer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bag.soldTo.name, phone: bag.soldTo.phone, notes: bag.soldTo.notes,
        bag_name: bag.name, bag_price: bag.price, captchaV3,
      }),
    });
    const result = await r.json().catch(() => ({}));
    console.log('GHL submit:', result);
  } catch(err) { console.warn('GHL submit failed (non-blocking):', err); }
}

document.getElementById('buyerSaveBtn').addEventListener('click', () => commitSold(true));
document.getElementById('buyerSkipBtn').addEventListener('click', () => commitSold(false));
document.getElementById('buyerCancelBtn').addEventListener('click', closeBuyerModal);
buyerModal.addEventListener('click', e => { if (e.target === buyerModal) closeBuyerModal(); });

// ==================== SALES DASHBOARD ====================
function renderStats() {
  const now = Date.now();
  const DAY = 86400000;
  const buckets = { today: 0, week: 0, month: 0, all: 0 };
  const counts  = { today: 0, week: 0, month: 0, all: 0 };
  let profitAll = 0, costKnown = 0; // profit only counts sold bags with a recorded buying price
  for (const b of bags) {
    if (!isSold(b)) continue;
    const price = salePrice(b);
    buckets.all += price; counts.all++;
    if (b.cost) { profitAll += price - b.cost; costKnown++; }
    const at = soldAt(b) ? new Date(soldAt(b)).getTime() : null;
    if (!at) continue;
    const age = now - at;
    if (age < DAY)      { buckets.today += price; counts.today++; }
    if (age < 7 * DAY)  { buckets.week  += price; counts.week++; }
    if (age < 30 * DAY) { buckets.month += price; counts.month++; }
  }
  const total = bags.length;
  const sellThrough = total ? Math.round((counts.all / total) * 100) : 0;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('statTodayRev', fmtKsh(buckets.today));   set('statTodayCount', counts.today);
  set('statWeekRev',  fmtKsh(buckets.week));    set('statWeekCount',  counts.week);
  set('statMonthRev', fmtKsh(buckets.month));   set('statMonthCount', counts.month);
  set('statAllRev',   fmtKsh(buckets.all));     set('statAllCount',   counts.all);
  set('statSellThrough', sellThrough + '%');
  // Profit subline — only show once at least one sold bag has a buying price recorded
  const profitSub = document.getElementById('statAllProfitSub');
  if (profitSub) {
    if (costKnown > 0) {
      set('statAllProfit', fmtKsh(profitAll));
      set('statAllProfitNote', costKnown < counts.all ? `· from ${costKnown}/${counts.all} with cost` : '');
      profitSub.style.display = '';
    } else {
      profitSub.style.display = 'none';
    }
  }
  // Net profit after operating expenses (ad spend etc.). Only shown once the
  // owner has logged any expense — otherwise it's just a duplicate of profit.
  const netSub = document.getElementById('statAllNetSub');
  if (netSub) {
    const exp = expensesTotal();
    if (exp > 0) {
      set('statAllExpenses', fmtKsh(exp));
      set('statAllNetProfit', fmtKsh(profitAll - exp));
      netSub.style.display = '';
    } else {
      netSub.style.display = 'none';
    }
  }

  // Top categories
  const byCat = {};
  bags.forEach(b => { if (isSold(b) && b.category) byCat[b.category] = (byCat[b.category] || 0) + 1; });
  const cats = Object.entries(byCat).sort((a,b) => b[1] - a[1]).slice(0, 6);
  const max = cats.length ? cats[0][1] : 1;
  const tc = document.getElementById('topCats');
  if (tc) tc.innerHTML = cats.length
    ? cats.map(([n, c]) => `
      <div>
        <div class="cat-bar-row"><span class="cat-bar-name">${escapeHtml(n)}</span><span class="cat-bar-meta">${c} sold</span></div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(c/max)*100}%"></div></div>
      </div>`).join('')
    : '<p style="font-size:13px;color:#999;">No sales recorded yet. Mark a bag as sold to see category breakdown here.</p>';

  // Recent sales (last 8 with a soldAt)
  const recent = bags.filter(b => isSold(b) && soldAt(b))
    .map(b => ({ b, t: new Date(soldAt(b)).getTime() }))
    .sort((a, b) => b.t - a.t).slice(0, 8);
  const rs = document.getElementById('recentSales');
  if (rs) rs.innerHTML = recent.length
    ? recent.map(({ b }) => `
      <div class="recent-row">
        <img src="${b.image}" alt="">
        <div style="flex:1;min-width:0;">
          <div class="recent-name">${escapeHtml(b.name)}${saleBalance(b) > 0 ? ` <span class="owed-tag">owes ${fmtKsh(saleBalance(b))}</span>` : ''}</div>
          <div class="recent-meta">${fmtKsh(salePrice(b))} · ${relTime(soldAt(b))}${b.soldTo?.name ? ' · ' + escapeHtml(b.soldTo.name) : ''}</div>
        </div>
      </div>`).join('')
    : '<p style="font-size:13px;color:#999;">No timestamped sales yet. Older bags marked sold before the buyer modal existed don\'t have a soldAt date.</p>';
}

// ==================== INVENTORY DASHBOARD ====================
let invFilter = 'all';
let invShowAll = false;
const INV_PAGE_SIZE = 15;

function renderInventory() {
  const total = bags.length;
  const sold = bags.filter(isSold).length;
  const available = total - sold;
  const totalRev = bags.reduce((s, b) => s + (isSold(b) ? salePrice(b) : 0), 0);
  const avgPrice = sold ? Math.round(totalRev / sold) : 0;
  const weekStart = startOfWeek(new Date()).getTime();
  const soldThisWeek = bags.filter(b => isSold(b) && soldAt(b) && new Date(soldAt(b)).getTime() >= weekStart).length;

  document.getElementById('invKpiGrid').innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Bags in catalogue</div><div class="inv-kpi-val">${total}</div><div class="inv-kpi-sub">${available} available</div></div>
    <div class="inv-kpi success"><div class="inv-kpi-label">Sold</div><div class="inv-kpi-val">${sold}</div><div class="inv-kpi-sub">${total ? Math.round((sold/total)*100) : 0}% sold-through</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Total revenue</div><div class="inv-kpi-val">${fmtKsh(totalRev)}</div><div class="inv-kpi-sub">Across all sales</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Avg sale price</div><div class="inv-kpi-val">${fmtKsh(avgPrice)}</div><div class="inv-kpi-sub">${soldThisWeek} sold this week</div></div>
  `;

  const fb = document.getElementById('invFilterBar');
  if (fb) {
    const pills = [
      { k: 'all', l: 'All', n: total },
      { k: 'available', l: 'Available', n: available },
      { k: 'sold', l: 'Sold', n: sold },
    ];
    fb.innerHTML = pills.map(p => `<button class="pill ${invFilter === p.k ? 'active' : ''}" data-k="${p.k}">${p.l} <small>(${p.n})</small></button>`).join('');
    fb.querySelectorAll('.pill').forEach(b => b.addEventListener('click', () => { invFilter = b.dataset.k; invShowAll = false; renderInventory(); }));
  }

  let rows = bags.slice();
  if (invFilter === 'available') rows = rows.filter(b => !isSold(b));
  if (invFilter === 'sold') rows = rows.filter(isSold);
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const shown = invShowAll ? rows : rows.slice(0, INV_PAGE_SIZE);
  const more = rows.length - shown.length;
  const invBody = document.getElementById('invTableBody');
  if (invBody) invBody.innerHTML = shown.map(b => `
    <tr>
      <td><img src="${b.image}" class="item-img" alt=""></td>
      <td><div style="font-weight:600;line-height:1.3;">${escapeHtml(b.name)}</div><div style="font-size:11px;color:#999;">${escapeHtml(b.id)}</div></td>
      <td>${escapeHtml(b.category || '—')}</td>
      <td>${fmtKsh(b.price)}${b.cost ? `<div style="font-size:11px;color:#2e7d32;">cost ${fmtKsh(b.cost)} · ${isSold(b) ? 'profit' : 'margin'} ${fmtKsh((Number(b.soldTo?.salePrice ?? (b.salePrice && b.salePrice < b.price ? b.salePrice : b.price)) || 0) - b.cost)}</div>` : ''}</td>
      <td>${isSold(b) ? '<span class="stock-pill zero">SOLD</span>' : '<span class="stock-pill ok">Available</span>'}</td>
      <td style="font-size:12px;color:#666;">${relTime(b.createdAt)}</td>
      <td><button class="restock-btn" onclick="editBag('${b.id}')">Edit</button></td>
    </tr>
  `).join('');

  const btn = document.getElementById('invShowMore');
  if (btn) {
    if (more > 0) { btn.style.display = 'block'; btn.textContent = 'Show all ' + rows.length; btn.onclick = () => { invShowAll = true; renderInventory(); }; }
    else if (invShowAll && rows.length > INV_PAGE_SIZE) { btn.style.display = 'block'; btn.textContent = 'Show fewer'; btn.onclick = () => { invShowAll = false; renderInventory(); }; }
    else { btn.style.display = 'none'; }
  }
}

// ==================== WHATSAPP MARKETING ====================
let broadcastItemIds = new Set();
let broadcastDisabled = new Set();

function renderBroadcast() {
  // Recipients = unique phones from bag.soldTo
  const buyersByPhone = new Map();
  bags.forEach(b => {
    const s = b.soldTo;
    if (!s || !s.phone) return;
    const prev = buyersByPhone.get(s.phone);
    if (!prev || new Date(s.soldAt || 0) > new Date(prev.soldAt || 0)) {
      buyersByPhone.set(s.phone, { name: s.name || 'Buyer', phone: s.phone, lastBag: b.name, soldAt: s.soldAt });
    }
  });
  const recipients = Array.from(buyersByPhone.values())
    .sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0));

  const rc = document.getElementById('broadcastRecipients');
  rc.innerHTML = recipients.length
    ? recipients.map(r => `
      <label class="broadcast-recipient ${broadcastDisabled.has(r.phone) ? '' : 'on'}">
        <input type="checkbox" data-phone="${escapeHtml(r.phone)}" ${broadcastDisabled.has(r.phone) ? '' : 'checked'}>
        <span class="broadcast-recipient-name">${escapeHtml((r.name || 'Friend').split(' ')[0])}</span>
        <span class="broadcast-recipient-phone">${escapeHtml(r.phone)}</span>
        <span class="broadcast-recipient-meta">last bought: ${escapeHtml(r.lastBag)} · ${relTime(r.soldAt)}</span>
      </label>`).join('')
    : '<p style="grid-column:1/-1;font-size:13px;color:#999;padding:14px;">No buyer phones yet. Capture them in the Mark-as-sold modal and they\'ll appear here.</p>';
  rc.querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', () => {
      const p = cb.dataset.phone;
      if (cb.checked) broadcastDisabled.delete(p); else broadcastDisabled.add(p);
      cb.closest('.broadcast-recipient').classList.toggle('on', cb.checked);
      updateBroadcastPreview();
    });
  });

  const search = document.getElementById('broadcastItemSearch');
  const picker = document.getElementById('broadcastItemPicker');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { picker.innerHTML = ''; picker.style.display = 'none'; return; }
    const hits = bags.filter(b => !isSold(b) && b.name.toLowerCase().includes(q)).slice(0, 8);
    picker.style.display = hits.length ? 'block' : 'none';
    picker.innerHTML = hits.map(b => `
      <div class="set-pick-row" data-id="${b.id}">
        <img src="${b.image}" alt="">
        <div><div class="set-pick-name">${escapeHtml(b.name)}</div><div class="set-pick-meta">${fmtKsh(b.price)}</div></div>
      </div>`).join('');
    picker.querySelectorAll('.set-pick-row').forEach(row => row.addEventListener('click', () => {
      broadcastItemIds.add(row.dataset.id);
      search.value = ''; picker.style.display = 'none';
      renderBroadcastSelected(); updateBroadcastPreview();
    }));
  };
  renderBroadcastSelected();
  updateBroadcastPreview();
}
function renderBroadcastSelected() {
  const sel = document.getElementById('broadcastSelectedItems');
  const items = Array.from(broadcastItemIds).map(id => bags.find(b => b.id === id)).filter(Boolean);
  sel.innerHTML = items.length
    ? items.map(b => `
      <div class="set-selected-item">
        <img src="${b.image}" alt="">
        <span>${escapeHtml(b.name)}</span>
        <button data-id="${b.id}" class="set-selected-rm" title="Remove">&times;</button>
      </div>`).join('')
    : '<span style="font-size:12px;color:#999;">No bags added yet — use the search below.</span>';
  sel.querySelectorAll('.set-selected-rm').forEach(btn => btn.addEventListener('click', () => {
    broadcastItemIds.delete(btn.dataset.id);
    renderBroadcastSelected(); updateBroadcastPreview();
  }));
}
function buildBroadcastMessage(firstName) {
  const subject = document.getElementById('broadcastSubject').value.trim();
  const items = Array.from(broadcastItemIds).map(id => bags.find(b => b.id === id)).filter(Boolean);
  // Per-item links use the worker's /share/<id> page (not the IG post) so the
  // first one renders a WhatsApp preview card AND traffic lands on the shop, not
  // Instagram. The shop browse link goes last: nessa.co.ke is a CF zone that
  // 403s the WA crawler, so it can't be the first/previewed link anyway.
  const SHARE_BASE = 'https://thriftlux-api.stawisystems.workers.dev/share/';
  let msg = `Hi ${firstName}! `;
  if (subject) msg += subject + '\n\n';
  if (items.length) {
    msg += 'New drops you might love:\n';
    items.forEach(b => { msg += `\n• ${b.name} · ${fmtKsh(b.price)}\n  ${SHARE_BASE}${encodeURIComponent(b.id)}`; });
    msg += '\n\n';
  }
  msg += `Browse the full shop: ${SHOP_URL}

ThriftLux 💛`;
  return msg;
}
function updateBroadcastPreview() {
  document.getElementById('broadcastPreview').value = buildBroadcastMessage('{First name}');
}
document.getElementById('broadcastSubject').addEventListener('input', updateBroadcastPreview);
document.getElementById('broadcastCopyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(buildBroadcastMessage('there')).then(() => showToast('Copied. Paste into a WA broadcast list.'));
});
// Build the deselected-aware, deduped recipient list from sales history.
function broadcastRecipients() {
  const buyers = [];
  bags.forEach(b => {
    const s = b.soldTo;
    if (s && s.phone && !broadcastDisabled.has(s.phone)) {
      buyers.push({ name: (s.name || 'Friend').split(' ')[0], phone: s.phone });
    }
  });
  // Manually-added clients with a phone are recipients too. ThriftLux bags have no
  // categories/sizes to segment by, so they just join the single list (deduped by phone).
  if (Array.isArray(clients)) {
    clients.forEach(c => {
      if (!c || !c.phone) return;
      if (String(c.phone).replace(/[^0-9]/g, '').length < 9) return;
      if (broadcastDisabled.has(c.phone)) return;
      buyers.push({ name: (c.name || 'Friend').split(' ')[0], phone: c.phone });
    });
  }
  const seen = new Set();
  return buyers.filter(b => seen.has(b.phone) ? false : (seen.add(b.phone), true));
}

// On phones the multi-window approach fails: only the first wa.me link fires before
// the browser is backgrounded by the WhatsApp app, and you can only be in one chat
// at a time. So mobile gets a one-at-a-time stepper; desktop keeps the multi-tab open.
const BC_PROG_KEY = 'thriftlux_bcprog';
let bcQueue = [];   // [{ phone, name }]
let bcIdx = 0;
function saveBcProgress() { try { localStorage.setItem(BC_PROG_KEY, JSON.stringify({ q: bcQueue, i: bcIdx })); } catch (_) {} }
function clearBcProgress() { try { localStorage.removeItem(BC_PROG_KEY); } catch (_) {} bcQueue = []; bcIdx = 0; }

function renderBroadcastStepper() {
  const el = document.getElementById('broadcastStepper');
  if (!el) return;
  if (!bcQueue.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  if (bcIdx >= bcQueue.length) {
    el.style.display = 'block';
    el.innerHTML = `<div class="bc-step-done">✓ Done — stepped through all ${bcQueue.length} buyer${bcQueue.length === 1 ? '' : 's'}. <button class="btn-admin" id="bcStepClose" type="button">Close</button></div>`;
    document.getElementById('bcStepClose').addEventListener('click', () => { clearBcProgress(); renderBroadcastStepper(); });
    return;
  }
  const r = bcQueue[bcIdx];
  const href = `https://wa.me/${waPhone(r.phone)}?text=${encodeURIComponent(buildBroadcastMessage(r.name))}`;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="bc-step-head">Sending ${bcIdx + 1} of ${bcQueue.length}</div>
    <div class="bc-step-name">${escapeHtml(r.name || 'Unknown buyer')} · +${escapeHtml(r.phone)}</div>
    <div class="bc-step-actions">
      <a class="btn-admin gold" id="bcStepOpen" href="${href}" target="_blank" rel="noopener">Open WhatsApp &amp; send →</a>
      <button class="btn-admin" id="bcStepNext" type="button">Sent ✓ · Next ▸</button>
      <button class="btn-admin" id="bcStepSkip" type="button">Skip</button>
      <button class="btn-admin danger" id="bcStepStop" type="button">Stop</button>
    </div>
    <div class="bc-step-hint">Tap <strong>Open WhatsApp</strong>, press send inside WhatsApp, come back here and tap <strong>Sent ✓ · Next</strong>. Your place is saved if you get interrupted.</div>`;
  document.getElementById('bcStepNext').addEventListener('click', () => { bcIdx++; saveBcProgress(); renderBroadcastStepper(); });
  document.getElementById('bcStepSkip').addEventListener('click', () => { bcIdx++; saveBcProgress(); renderBroadcastStepper(); });
  document.getElementById('bcStepStop').addEventListener('click', () => { clearBcProgress(); renderBroadcastStepper(); showToast('Sending stopped.'); });
}

function restoreBcProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(BC_PROG_KEY) || 'null');
    if (p && Array.isArray(p.q) && p.q.length && p.i < p.q.length) { bcQueue = p.q; bcIdx = p.i; renderBroadcastStepper(); }
    else clearBcProgress();
  } catch (_) {}
}

const BC_IS_MOBILE = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

document.getElementById('broadcastStartBtn').addEventListener('click', async () => {
  const recipients = broadcastRecipients();
  if (!recipients.length) { document.getElementById('broadcastStatus').textContent = 'No recipients selected.'; return; }
  if (BC_IS_MOBILE) {
    if (!await confirmAction(`Send to ${recipients.length} buyer${recipients.length === 1 ? '' : 's'}, one at a time. For each: tap Open WhatsApp, send, come back, tap Next. OK?`, 'Start')) return;
    bcQueue = recipients.map(r => ({ phone: r.phone, name: r.name }));
    bcIdx = 0;
    saveBcProgress();
    renderBroadcastStepper();
    document.getElementById('broadcastStepper').scrollIntoView({ behavior: 'auto', block: 'center' });
    return;
  }
  if (!await confirmAction(`Open ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}, one per buyer. Send each one manually. OK?`)) return;
  let i = 0;
  function next() {
    if (i >= recipients.length) {
      document.getElementById('broadcastStatus').textContent = `✓ Opened ${recipients.length} WhatsApp window${recipients.length === 1 ? '' : 's'}.`;
      return;
    }
    const r = recipients[i++];
    window.open(`https://wa.me/${waPhone(r.phone)}?text=${encodeURIComponent(buildBroadcastMessage(r.name))}`, '_blank');
    document.getElementById('broadcastStatus').textContent = `Opening ${i} of ${recipients.length}…`;
    setTimeout(next, 700);
  }
  next();
});
restoreBcProgress();


// ==================== LOYALTY PROGRAM ====================
// Customers are derived from sold bags grouped by soldTo.phone — there's no
// separate customer store. Earned stamps/points are a pure function of sales,
// so only redemptions are persisted (in settings.loyalty.redemptions). That
// keeps sales the single source of truth; available = earned - redeemed.
const DEFAULT_LOYALTY = { enabled: true, mode: 'stamps', threshold: 10, pointsPerKsh: 0.01, rewardLabel: 'a free bag' };
let loyaltyQuery = '';

function loyaltyConf() {
  const l = settings.loyalty || {};
  return {
    enabled: l.enabled !== false,
    mode: l.mode === 'spend' ? 'spend' : 'stamps',
    threshold: Number(l.threshold) > 0 ? Number(l.threshold) : DEFAULT_LOYALTY.threshold,
    pointsPerKsh: Number(l.pointsPerKsh) > 0 ? Number(l.pointsPerKsh) : DEFAULT_LOYALTY.pointsPerKsh,
    rewardLabel: (l.rewardLabel || '').trim() || DEFAULT_LOYALTY.rewardLabel,
    redemptions: Array.isArray(l.redemptions) ? l.redemptions : [],
  };
}
const phoneKey = p => String(p == null ? '' : p).replace(/[^0-9]/g, '');
// Build a WhatsApp-ready number from a locally-typed one. Owners type Kenyan
// numbers without the country code (0712…, or 712…); wa.me needs 2547…. So:
// strip non-digits, then 0XXXXXXXXX -> 254XXXXXXXXX and bare 7…/1… -> 254…;
// anything already starting 254 (or +254) passes through. Owners never need +254.
function waPhone(p) {
  let d = String(p == null ? '' : p).replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (d.startsWith('7') || d.startsWith('1')) d = '254' + d;
  return d;
}

function customerLedger() {
  const map = new Map();
  for (const b of bags) {
    const s = b.soldTo;
    if (!s || !s.phone) continue;
    const phone = phoneKey(s.phone);
    if (phone.length < 9) continue;
    let c = map.get(phone);
    if (!c) { c = { phone, name: s.name || '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
    c.purchases.push({ bagName: b.name, price: salePrice(b), at: s.soldAt });
    c.spend += salePrice(b);
    const at = s.soldAt ? new Date(s.soldAt).getTime() : 0;
    if (at >= c.lastAt) { c.lastAt = at; if (s.name) c.name = s.name; }
  }
  // Overlay manually-added clients (may have zero purchases yet).
  for (const mc of (clients || [])) {
    if (!mc || !mc.phone) continue;
    const phone = phoneKey(mc.phone);
    if (phone.length < 9) continue;
    let c = map.get(phone);
    if (!c) { c = { phone, name: '', purchases: [], spend: 0, lastAt: 0 }; map.set(phone, c); }
    c.manualId = mc.id;
    if (mc.note) c.note = mc.note;
    if (!c.name && mc.name) c.name = mc.name;
    if (mc.createdAt) c.addedAt = mc.createdAt;
  }
  return [...map.values()];
}

// ====== CLIENTS (free CRM roster) ======
// Ungated view of who has bought, so the owner can see and re-contact buyers.
// Reuses customerLedger() (deduped by phone). Loyalty adds points/rewards on
// top of the same ledger and stays the paid upsell.
let clientsQuery = '';
let clientsSort = 'recent';
function renderClients() {
  const listEl = document.getElementById('clientsList');
  if (!listEl) return;
  const ledger = customerLedger();
  const owedMap = owedByPhone();
  const totalSpend = ledger.reduce((s, c) => s + c.spend, 0);
  const repeat = ledger.filter(c => c.purchases.length >= 2).length;
  const avg = ledger.length ? Math.round(totalSpend / ledger.length) : 0;

  const nav = document.getElementById('navClientsCount'); if (nav) nav.textContent = ledger.length || '';

  const kpi = document.getElementById('clientsKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Clients</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${repeat} repeat buyer${repeat === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi success"><div class="inv-kpi-label">Total spent</div><div class="inv-kpi-val">${fmtKsh(totalSpend)}</div><div class="inv-kpi-sub">across all clients</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Avg per client</div><div class="inv-kpi-val">${fmtKsh(avg)}</div><div class="inv-kpi-sub">lifetime value</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Repeat rate</div><div class="inv-kpi-val">${ledger.length ? Math.round(repeat / ledger.length * 100) : 0}%</div><div class="inv-kpi-sub">bought 2+ times</div></div>
  `;

  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients yet. When you mark a bag sold and save the buyer\'s name and phone, they show up here so you can message them again.</p>';
    return;
  }
  const q = clientsQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) =>
      clientsSort === 'spend' ? b.spend - a.spend :
      clientsSort === 'purchases' ? b.purchases.length - a.purchases.length :
      b.lastAt - a.lastAt);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No clients match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const items = c.purchases.slice()
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(p => `<span class="client-item">${escapeHtml(p.bagName)} · ${fmtKsh(p.price)}</span>`).join('');
    const has = c.purchases.length;
    const when = has ? `last ${relTime(new Date(c.lastAt).toISOString())}`
                     : (c.addedAt ? `added ${relTime(c.addedAt)}` : 'no purchases yet');
    const manualTag = c.manualId ? '<span class="client-tag">Added manually</span>' : '';
    const noteLine = c.note ? `<div class="client-note">${escapeHtml(c.note)}</div>` : '';
    // Remove is only for a manually-added contact that has NOT bought anything
    // (e.g. added by mistake). Once a client has any purchase they're real sales
    // history — no one-tap remove. Their sales would have to be undone in Sales.
    const removeBtn = (c.manualId && !has) ? `<button class="btn-admin danger" onclick="removeClient('${c.manualId}')">Remove</button>` : '';
    return `
      <div class="client-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(c.name || 'Unnamed buyer')}${manualTag}</div>
          <div class="client-row-sub">${escapeHtml(c.phone)} · ${has} purchase${has === 1 ? '' : 's'} · ${fmtKsh(c.spend)} spent · ${when}${owedMap[c.phone] > 0 ? ` · <span class="owed-amount">owes ${fmtKsh(owedMap[c.phone])}</span>` : ''}</div>
          ${noteLine}
          <div class="client-items">${items}</div>
        </div>
        <div class="client-row-actions">
          <button class="btn-admin gold" onclick="clientMessage('${c.phone}')">WhatsApp</button>
          <button class="btn-admin" onclick="openEditClient('${c.phone}')">Edit</button>
          ${removeBtn}
        </div>
      </div>`;
  }).join('');
}
window.clientMessage = phone => {
  const c = customerLedger().find(x => x.phone === phone);
  const first = (c && c.name ? c.name : 'there').split(' ')[0];
  const msg = `Hi ${first}! Thanks for shopping with ThriftLux. We've got fresh pieces in. Browse what just landed here: ${SHOP_URL}

ThriftLux 💛`;
  window.open(`https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};
document.getElementById('clientsSearch')?.addEventListener('input', e => { clientsQuery = e.target.value.trim(); renderClients(); });
document.getElementById('clientsSort')?.addEventListener('change', e => { clientsSort = e.target.value; renderClients(); });
// "NEW" badge on the Clients nav link — kept permanently visible (no auto-dismiss).

// ----- Manual add / remove client (server-synced via clients[]) -----
// "Item bought" autocomplete: type → tappable AVAILABLE bags → pick to mark it
// sold to this client (thrift = one-of-one, so this is the mark-sold path).
let acItemId = '';
function acRenderResults(q) {
  const box = document.getElementById('addClientItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = bags.filter(b => !b.sold && (b.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(b => `<button type="button" class="client-item-opt" data-id="${b.id}">${escapeHtml(b.name)}<span>${fmtKsh(b.price)}</span></button>`).join('')
    : '<div class="client-item-empty">No available items match.</div>';
  box.style.display = '';
}
function acSelectItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  acItemId = id;
  document.getElementById('addClientItemSearch').value = bag.name;
  document.getElementById('addClientItemResults').style.display = 'none';
  document.getElementById('addClientPrice').value = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : bag.price;
  document.getElementById('addClientChosen').innerHTML = `Marking <strong>${escapeHtml(bag.name)}</strong> sold to this client · <button type="button" id="addClientClearItem">clear</button>`;
  document.getElementById('addClientChosen').style.display = '';
  document.getElementById('addClientSaleFields').style.display = '';
}
function acClearItem() {
  acItemId = '';
  document.getElementById('addClientItemSearch').value = '';
  document.getElementById('addClientItemResults').style.display = 'none';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
}
// When set, the client modal is editing an existing customer (by their original
// phone) rather than adding a new one. Cleared on every open/close.
let editingClientPhone = null;
function _clientModalMode(edit) {
  const t = document.getElementById('addClientTitle'); if (t) t.textContent = edit ? 'Edit customer details' : 'Add a client';
  const bagField = document.getElementById('addClientBagField'); if (bagField) bagField.style.display = edit ? 'none' : '';
  document.getElementById('addClientSaleFields').style.display = 'none';
  const save = document.getElementById('addClientSaveBtn'); if (save) save.textContent = edit ? 'Save changes' : 'Save client';
}
function openAddClient() {
  editingClientPhone = null;
  document.getElementById('addClientName').value = '';
  document.getElementById('addClientPhone').value = '';
  document.getElementById('addClientNote').value = '';
  acClearItem();
  _clientModalMode(false);
  document.getElementById('addClientModal').style.display = 'flex';
  document.getElementById('addClientName').focus();
}
// Edit an existing customer's details (name, phone, note). Updates the client
// record AND re-labels this customer's sales (soldTo name/phone) so the Owed,
// Clients and Sales views all stay consistent. Per-sale notes are left intact.
window.openEditClient = (phone) => {
  const c = customerLedger().find(x => x.phone === phone);
  if (!c) { showToast('Customer not found.'); return; }
  editingClientPhone = c.phone;
  document.getElementById('addClientName').value = c.name || '';
  document.getElementById('addClientPhone').value = c.phone || '';
  document.getElementById('addClientNote').value = c.note || '';
  acClearItem();
  _clientModalMode(true);
  document.getElementById('addClientModal').style.display = 'flex';
  document.getElementById('addClientName').focus();
};
function closeAddClient() { document.getElementById('addClientModal').style.display = 'none'; editingClientPhone = null; }
document.getElementById('clientsAddBtn')?.addEventListener('click', openAddClient);
document.getElementById('addClientCancelBtn')?.addEventListener('click', closeAddClient);
document.getElementById('addClientModal')?.addEventListener('click', e => { if (e.target.id === 'addClientModal') closeAddClient(); });
document.getElementById('addClientItemSearch')?.addEventListener('input', e => {
  acItemId = '';
  document.getElementById('addClientChosen').style.display = 'none';
  document.getElementById('addClientSaleFields').style.display = 'none';
  acRenderResults(e.target.value.trim());
});
document.getElementById('addClientItemResults')?.addEventListener('click', e => {
  const opt = e.target.closest('.client-item-opt');
  if (opt) acSelectItem(opt.dataset.id);
});
document.getElementById('addClientChosen')?.addEventListener('click', e => {
  if (e.target.id === 'addClientClearItem') acClearItem();
});
document.getElementById('addClientSaveBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('addClientName').value.trim();
  const phone = document.getElementById('addClientPhone').value.trim().replace(/[^0-9+]/g, '');
  const note = document.getElementById('addClientNote').value.trim();
  if (!name) { showToast('Enter a name.'); return; }
  if (phone.replace(/[^0-9]/g, '').length < 9) { showToast('Enter a valid phone number.'); return; }
  const btn = document.getElementById('addClientSaveBtn');
  // ----- Edit mode: update an existing customer's details -----
  if (editingClientPhone) {
    const oldKey = phoneKey(editingClientPhone);
    btn.disabled = true;
    try {
      await apiMutateAndPublish(() => {
        if (!Array.isArray(clients)) clients = [];
        const rec = clients.find(c => phoneKey(c.phone) === oldKey);
        if (rec) { rec.name = name; rec.phone = phone; rec.note = note; }
        else clients.push({ id: 'c_' + Date.now(), name, phone, note, createdAt: new Date().toISOString() });
        // Re-label this customer's sales so Owed/Sales/Clients stay in sync.
        // Identity only (name + phone) — leave each sale's own note untouched.
        for (const b of bags) {
          if (b.soldTo && phoneKey(b.soldTo.phone) === oldKey) { b.soldTo.name = name; b.soldTo.phone = phone; }
        }
      });
      closeAddClient();
      renderAll();
      showToast('Customer details updated.');
    } catch (e) { showToast('Save failed: ' + e.message); }
    finally { btn.disabled = false; }
    return;
  }
  // ----- Add mode -----
  const itemId = acItemId;
  const paid = itemId ? (parseInt(document.getElementById('addClientPrice').value, 10) || 0) : 0;
  btn.disabled = true;
  try {
    await apiMutateAndPublish(() => {
      if (!Array.isArray(clients)) clients = [];
      const norm = phoneKey(phone);
      const existing = clients.find(c => phoneKey(c.phone) === norm);
      if (existing) { existing.name = name; existing.note = note; }
      else clients.push({ id: 'c_' + Date.now(), name, phone, note, createdAt: new Date().toISOString() });
      if (itemId) {
        const bag = bags.find(b => b.id === itemId);
        if (!bag) throw new Error('Item no longer exists — refresh admin');
        if (bag.sold) throw new Error('That item is already sold');
        bag.sold = true;
        bag.soldTo = { name, phone, notes: note, soldAt: new Date().toISOString(), salePrice: paid || bag.price };
        delete bag.salePrice;
      }
    });
    closeAddClient();
    renderAll();
    showToast(itemId ? 'Client saved + bag marked sold.' : 'Client saved.');
  } catch (e) { showToast('Save failed: ' + e.message); }
  finally { btn.disabled = false; }
});
window.removeClient = async (id) => {
  if (!await confirmAction('Remove this client from your list? Their past sales (if any) stay in your records.', 'Remove')) return;
  try {
    await apiMutateAndPublish(() => { clients = (clients || []).filter(c => c.id !== id); });
    renderClients();
    showToast('Client removed.');
  } catch (e) { showToast('Remove failed: ' + e.message); }
};

function loyaltyStatus(c, conf) {
  const earned = conf.mode === 'spend' ? Math.floor(c.spend * conf.pointsPerKsh) : c.purchases.length;
  const redeemed = conf.redemptions
    .filter(r => phoneKey(r.phone) === c.phone)
    .reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
  const available = Math.max(0, earned - redeemed);
  return {
    earned, redeemed, available,
    ready: Math.floor(available / conf.threshold),
    progress: available % conf.threshold,
    threshold: conf.threshold,
    unit: conf.mode === 'spend' ? 'points' : 'stamps',
  };
}

function loyaltyMessage(c, conf, st) {
  const first = (c.name || 'there').split(' ')[0];
  let msg = `Hi ${first}! `;
  if (st.ready >= 1) {
    msg += `Good news, you've earned ${conf.rewardLabel} on your ThriftLux loyalty card. Claim it on your next visit 💛`;
  } else if (conf.mode === 'spend') {
    msg += `You're at ${st.progress} of ${conf.threshold} points on your ThriftLux loyalty card. A little more and you unlock ${conf.rewardLabel} 💛`;
  } else {
    const remaining = conf.threshold - st.progress;
    msg += `You've collected ${st.progress} of ${conf.threshold} stamps with ThriftLux. ${remaining} more and ${conf.rewardLabel} is yours 💛`;
  }
  return msg + `\nThriftLux 💛`;
}

function syncLoyaltyModeUI(mode) {
  const ppk = document.getElementById('loyaltyPpkField');
  const lbl = document.getElementById('loyaltyThresholdLabel');
  if (ppk) ppk.style.display = mode === 'spend' ? '' : 'none';
  if (lbl) lbl.textContent = mode === 'spend' ? 'Points needed for a reward' : 'Stamps needed for a reward';
}

function renderLoyalty() {
  // Paid-feature gate: show the teaser until billing flips loyalty_unlocked.
  const locked = !loyaltyUnlocked;
  const lockedEl = document.getElementById('loyaltyLocked');
  const unlockedEl = document.getElementById('loyaltyUnlocked');
  if (lockedEl) lockedEl.style.display = locked ? '' : 'none';
  if (unlockedEl) unlockedEl.style.display = locked ? 'none' : '';
  const navLock = document.getElementById('navLoyaltyCount');
  if (locked) {
    if (navLock) navLock.textContent = '🔒';
    // Build the unlock-request message from this shop's own settings so the
    // agency can tell exactly who/which site is asking (the static href is a
    // generic fallback; this overwrites it per shop).
    const cta = document.getElementById('loyaltyUnlockCta');
    if (cta) {
      const biz = (settings.businessName || 'my shop').trim();
      const owner = (settings.ownerName || '').trim();
      const who = owner ? `${biz} (${owner})` : biz;
      const site = location.host + location.pathname.replace(/\/admin(\.html)?$/i, '/');
      const text = `Hi, I'd like to unlock the Loyalty Program (Ksh 5,000 one-time) for ${who}. Site: ${site}`;
      cta.href = `https://wa.me/254720615606?text=${encodeURIComponent(text)}`;
    }
    return;
  }

  const conf = loyaltyConf();
  // Populate config inputs (skip any the owner is actively editing).
  const setVal = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
  const enabledEl = document.getElementById('loyaltyEnabled');
  if (enabledEl && document.activeElement !== enabledEl) enabledEl.checked = conf.enabled;
  const modeEl = document.getElementById('loyaltyMode');
  if (modeEl && document.activeElement !== modeEl) modeEl.value = conf.mode;
  setVal('loyaltyThreshold', conf.threshold);
  setVal('loyaltyPpk', conf.pointsPerKsh);
  setVal('loyaltyReward', conf.rewardLabel);
  syncLoyaltyModeUI(modeEl ? modeEl.value : conf.mode);

  const withStatus = customerLedger().map(c => ({ c, st: loyaltyStatus(c, conf) }));
  const total = withStatus.length;
  const repeat = withStatus.filter(x => x.c.purchases.length >= 2).length;
  const readyCount = withStatus.filter(x => x.st.ready >= 1).length;

  const nav = document.getElementById('navLoyaltyCount'); if (nav) nav.textContent = total || '';

  const kpi = document.getElementById('loyaltyKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Customers</div><div class="inv-kpi-val">${total}</div><div class="inv-kpi-sub">${repeat} repeat buyer${repeat === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi success"><div class="inv-kpi-label">Rewards ready</div><div class="inv-kpi-val">${readyCount}</div><div class="inv-kpi-sub">can claim now</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Redeemed</div><div class="inv-kpi-val">${conf.redemptions.length}</div><div class="inv-kpi-sub">rewards given all-time</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Reward</div><div class="inv-kpi-val" style="font-size:15px;line-height:1.35;">${escapeHtml(conf.rewardLabel)}</div><div class="inv-kpi-sub">${conf.threshold} ${conf.mode === 'spend' ? 'points' : 'stamps'} each</div></div>
  `;

  const list = document.getElementById('loyaltyList');
  if (!list) return;
  if (!total) {
    list.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No customers yet. Save a buyer\'s name and phone when you mark a bag sold and they\'ll appear here.</p>';
    return;
  }
  const q = loyaltyQuery.toLowerCase();
  const rows = withStatus
    .filter(({ c }) => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) => (b.st.ready - a.st.ready) || (b.c.lastAt - a.c.lastAt));
  if (!rows.length) {
    list.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No customers match your search.</p>';
    return;
  }
  list.innerHTML = rows.map(({ c, st }) => {
    const ready = st.ready >= 1;
    const pct = ready ? 100 : Math.min(100, Math.round((st.progress / conf.threshold) * 100));
    const badge = ready ? `<span class="loyalty-ready-badge">Reward ready${st.ready > 1 ? ' ×' + st.ready : ''}</span>` : '';
    const progLine = ready
      ? `<span>Can claim ${escapeHtml(conf.rewardLabel)}</span><span>${st.available} ${st.unit}</span>`
      : `<span>${st.progress} / ${conf.threshold} ${st.unit}</span><span>${conf.threshold - st.progress} to go</span>`;
    return `
      <div class="loyalty-row ${ready ? 'ready' : ''}">
        <div class="loyalty-row-main">
          <div class="loyalty-row-name">${escapeHtml(c.name || 'Unnamed buyer')}${badge}</div>
          <div class="loyalty-row-sub">${escapeHtml(c.phone)} · ${c.purchases.length} purchase${c.purchases.length === 1 ? '' : 's'} · ${fmtKsh(c.spend)} spent · last ${relTime(new Date(c.lastAt).toISOString())}</div>
          <div class="loyalty-row-progress">
            <div class="loyalty-prog-meta">${progLine}</div>
            <div class="loyalty-bar-track"><div class="loyalty-bar-fill" style="width:${pct}%"></div></div>
          </div>
        </div>
        <div class="loyalty-row-actions">
          <button class="btn-admin" onclick="loyaltyNudge('${c.phone}')">WhatsApp</button>
          ${ready ? `<button class="btn-admin gold" onclick="loyaltyRedeem('${c.phone}')">Redeem</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function saveLoyaltyConfig() {
  const mode = document.getElementById('loyaltyMode').value === 'spend' ? 'spend' : 'stamps';
  const threshold = parseInt(document.getElementById('loyaltyThreshold').value, 10);
  const ppk = parseFloat(document.getElementById('loyaltyPpk').value);
  const reward = document.getElementById('loyaltyReward').value.trim();
  const enabled = document.getElementById('loyaltyEnabled').checked;
  if (!(threshold > 0)) { showToast('Reward threshold must be a positive whole number.'); return; }
  try {
    await apiMutateAndPublish(() => {
      const prev = settings.loyalty || {};
      settings.loyalty = {
        enabled, mode, threshold,
        pointsPerKsh: ppk > 0 ? ppk : DEFAULT_LOYALTY.pointsPerKsh,
        rewardLabel: reward || DEFAULT_LOYALTY.rewardLabel,
        redemptions: Array.isArray(prev.redemptions) ? prev.redemptions : [],
      };
    });
    renderLoyalty();
    showToast('Loyalty settings saved.');
  } catch (err) { showToast('Sync failed: ' + err.message); }
}

window.loyaltyNudge = (phone) => {
  const conf = loyaltyConf();
  const c = customerLedger().find(x => x.phone === phone);
  if (!c) return;
  window.open(`https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(loyaltyMessage(c, conf, loyaltyStatus(c, conf)))}`, '_blank');
};

window.loyaltyRedeem = async (phone) => {
  const conf = loyaltyConf();
  const c = customerLedger().find(x => x.phone === phone);
  if (!c) return;
  const st = loyaltyStatus(c, conf);
  if (st.ready < 1) { showToast('Not enough ' + st.unit + ' to redeem yet.'); return; }
  if (!await confirmAction(`Redeem ${conf.rewardLabel} for ${c.name || phone}? This uses ${conf.threshold} ${st.unit}.`, 'Redeem')) return;
  try {
    await apiMutateAndPublish(() => {
      if (!settings.loyalty || typeof settings.loyalty !== 'object') settings.loyalty = {};
      if (!Array.isArray(settings.loyalty.redemptions)) settings.loyalty.redemptions = [];
      settings.loyalty.redemptions.push({
        phone, name: c.name || '', at: new Date().toISOString(),
        mode: conf.mode, cost: conf.threshold, rewardLabel: conf.rewardLabel,
      });
    });
    renderLoyalty();
    showToast('Reward redeemed for ' + (c.name || phone) + '.');
  } catch (err) { showToast('Sync failed: ' + err.message); }
};

document.getElementById('loyaltySaveBtn')?.addEventListener('click', saveLoyaltyConfig);
document.getElementById('loyaltyMode')?.addEventListener('change', e => syncLoyaltyModeUI(e.target.value));
(() => {
  const ls = document.getElementById('loyaltySearch');
  if (!ls) return;
  let t;
  ls.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { loyaltyQuery = ls.value.trim(); renderLoyalty(); }, 160); });
})();
document.getElementById('loyaltyMsgReadyBtn')?.addEventListener('click', () => {
  const conf = loyaltyConf();
  const ready = customerLedger().map(c => ({ c, st: loyaltyStatus(c, conf) })).filter(x => x.st.ready >= 1);
  if (!ready.length) { showToast('No customers have a reward ready.'); return; }
  showToast(`Opening ${ready.length} WhatsApp tab${ready.length === 1 ? '' : 's'}…`);
  ready.forEach(({ c }, i) => setTimeout(() => {
    window.open(`https://wa.me/${waPhone(c.phone)}?text=${encodeURIComponent(loyaltyMessage(c, conf, loyaltyStatus(c, conf)))}`, '_blank');
  }, i * 700));
});

// ---- Post-sale thank-you (offered right after a sale with buyer details) ----
let pendingThanks = null;
const saleThanksModal = document.getElementById('saleThanksModal');

function thankYouMessage(bag, c, conf, st) {
  const first = (c.name || 'there').split(' ')[0];
  let msg = `Hi ${first}! Thank you for shopping with ThriftLux 💛`;
  if (bag?.name) msg += ` Enjoy your ${bag.name}.`;
  if (conf.enabled) {
    if (st.ready >= 1) {
      msg += `\n\nGreat news, you've now earned ${conf.rewardLabel}! Claim it on your next visit.`;
    } else if (conf.mode === 'spend') {
      msg += `\n\nYou now have ${st.available} points on your ThriftLux loyalty card. A little more and you unlock ${conf.rewardLabel}.`;
    } else {
      const remaining = conf.threshold - st.progress;
      msg += `\n\nYou now have ${st.available} stamp${st.available === 1 ? '' : 's'} on your loyalty card. ${remaining} more and ${conf.rewardLabel} is yours.`;
    }
  }
  return msg + `\nThriftLux 💛`;
}

function openSaleThanks(bag) {
  const phone = phoneKey(bag.soldTo?.phone);
  if (phone.length < 9) return;
  const conf = loyaltyConf();
  const c = customerLedger().find(x => x.phone === phone) || { phone, name: bag.soldTo.name || '', purchases: [], spend: 0 };
  const st = loyaltyStatus(c, conf);
  pendingThanks = { bag, c, conf, st };
  const first = escapeHtml((c.name || 'the buyer').split(' ')[0]);
  let summary;
  if (!conf.enabled) {
    summary = 'Loyalty is currently off — the message will just be a thank-you.';
  } else if (st.ready >= 1) {
    summary = `${first} has now earned <strong>${escapeHtml(conf.rewardLabel)}</strong> (${st.available} ${st.unit}).`;
  } else {
    summary = `${first} now has <strong>${st.available} ${st.unit}</strong> — ${conf.threshold - st.progress} more to ${escapeHtml(conf.rewardLabel)}.`;
  }
  document.getElementById('saleThanksMsg').innerHTML =
    `Send ${first} a quick thank-you and their loyalty update?<br><br>${summary}`;
  if (saleThanksModal) saleThanksModal.style.display = 'flex';
}
function closeSaleThanks() { if (saleThanksModal) saleThanksModal.style.display = 'none'; pendingThanks = null; }

document.getElementById('saleThanksSendBtn')?.addEventListener('click', () => {
  if (!pendingThanks) return;
  const { bag, c, conf, st } = pendingThanks;
  window.open(`https://wa.me/${waPhone(c.phone)}?text=${encodeURIComponent(thankYouMessage(bag, c, conf, st))}`, '_blank');
  closeSaleThanks();
});
document.getElementById('saleThanksDoneBtn')?.addEventListener('click', closeSaleThanks);
saleThanksModal?.addEventListener('click', e => { if (e.target === saleThanksModal) closeSaleThanks(); });

// ==================== BULK ACTIONS ====================
window.toggleBulk = id => { if (bulkSelected.has(id)) bulkSelected.delete(id); else bulkSelected.add(id); refreshBulkBar(); renderList(); };
function refreshBulkBar() {
  document.getElementById('bulkCount').textContent = bulkSelected.size;
  document.getElementById('bulkActions').style.display = bulkSelected.size ? 'flex' : 'none';
}
window.bulkSelectAll = () => { bags.forEach(b => bulkSelected.add(b.id)); refreshBulkBar(); renderList(); };
window.bulkClear = () => { bulkSelected.clear(); refreshBulkBar(); renderList(); };
window.bulkDelete = async () => {
  if (!bulkSelected.size) return;
  if (!await confirmAction(`Delete ${bulkSelected.size} bags? This cannot be undone.`, 'Delete')) return;
  const ids = new Set(bulkSelected);
  let removed = [];
  try {
    await apiMutateAndPublish(() => {
      removed = [];
      bags.forEach((b, i) => { if (ids.has(b.id)) removed.push({ item: b, index: i }); });
      bags = bags.filter(b => !ids.has(b.id));
    });
    bulkSelected.clear();
    renderAll();    showToast('Deleted.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
};
window.bulkMarkSold = async () => {
  const ids = new Set(bulkSelected);
  try {
    await apiMutateAndPublish(() => {
      bags.forEach(b => { if (ids.has(b.id) && !b.sold) {
        const paid = (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0);
        b.sold = true; b.soldTo = { salePrice: paid, soldAt: new Date().toISOString() }; delete b.salePrice;
      } });
    });
    renderAll(); showToast('Marked as sold.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
};
window.bulkMarkAvailable = async () => {
  const ids = new Set(bulkSelected);
  try {
    await apiMutateAndPublish(() => {
      bags.forEach(b => { if (ids.has(b.id) && b.sold) { b.sold = false; delete b.soldTo; } });
    });
    renderAll(); showToast('Marked as available.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
};
window.bulkSetCategory = () => {
  document.getElementById('bulkCatCount').textContent = bulkSelected.size;
  document.getElementById('bulkCatModal').style.display = 'flex';
};
document.getElementById('bulkCatCancelBtn').addEventListener('click', () => { document.getElementById('bulkCatModal').style.display = 'none'; });
document.getElementById('bulkCatSaveBtn').addEventListener('click', async () => {
  const cat = document.getElementById('bulkCatSelect').value;
  if (!cat) { showToast('Pick a category.'); return; }
  const ids = new Set(bulkSelected);
  document.getElementById('bulkCatModal').style.display = 'none';
  try {
    await apiMutateAndPublish(() => {
      bags.forEach(b => { if (ids.has(b.id)) b.category = cat; });
    });
    renderAll(); showToast('Categories updated.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
});

// ---- Bulk SELL to one customer (type details once) ----
// Thrift model: each selected available bag becomes its own sale, all sharing
// the same buyer + payment method. An optional part-payment for the whole lot
// is allocated across the bags in order (oldest-first), so the Owed ledger works.
function bulkSellableSelected() { return bags.filter(b => bulkSelected.has(b.id) && !b.sold); }
function bagCatalogPrice(b) { return (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0); }
let bulkSellTotalAmt = 0;
window.bulkSell = () => {
  const list = bulkSellableSelected();
  if (!list.length) { showToast('Select at least one available bag to sell.'); return; }
  bulkSellTotalAmt = list.reduce((s, b) => s + bagCatalogPrice(b), 0);
  document.getElementById('bulkSellTitle').textContent = `Sell ${list.length} bag${list.length === 1 ? '' : 's'} to one customer`;
  document.getElementById('bulkSellItems').innerHTML = list.map(b => {
    const p = bagCatalogPrice(b);
    return `<span class="client-item">${escapeHtml(b.name)}${p ? ' · ' + fmtKsh(p) : ''}</span>`;
  }).join('');
  document.getElementById('bulkSellTotal').textContent = `Total: ${fmtKsh(bulkSellTotalAmt)} · ${list.length} bag${list.length === 1 ? '' : 's'}`;
  document.getElementById('bulkSellName').value = '';
  document.getElementById('bulkSellPhone').value = '';
  document.getElementById('bulkSellNotes').value = '';
  const paid = document.getElementById('bulkSellPaid');
  paid.value = ''; paid.placeholder = 'Paid in full';
  document.getElementById('bulkSellPaidHint').style.display = 'none';
  document.getElementById('bulkSellPaidNone').classList.remove('active');
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  const cs = document.getElementById('bulkSellCustSearch');
  if (cs) cs.value = '';
  const cr = document.getElementById('bulkSellCustResults');
  if (cr) { cr.style.display = 'none'; cr.innerHTML = ''; }
  document.getElementById('bulkSellModal').style.display = 'flex';
};
function closeBulkSell() { document.getElementById('bulkSellModal').style.display = 'none'; }
function updateBulkSellHint() {
  const raw = (document.getElementById('bulkSellPaid').value || '').trim();
  document.getElementById('bulkSellPaidNone').classList.toggle('active', raw === '0');
  const hint = document.getElementById('bulkSellPaidHint');
  if (raw === '') { hint.style.display = 'none'; return; }
  const bal = bulkSellTotalAmt - Math.min(bulkSellTotalAmt, Math.max(0, parseInt(raw, 10) || 0));
  hint.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hint.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
async function commitBulkSold(withBuyer) {
  const initial = bulkSellableSelected();
  if (!initial.length) { closeBulkSell(); return; }
  const ids = new Set(initial.map(b => b.id));
  const payMethod = document.querySelector('#bulkSellPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  let buyerInfo = null;
  if (withBuyer) {
    const name = document.getElementById('bulkSellName').value.trim();
    const phone = document.getElementById('bulkSellPhone').value.trim().replace(/[^0-9+]/g, '');
    const notes = document.getElementById('bulkSellNotes').value.trim();
    if (!name && !phone) { showToast('Add a name or phone, or hit Skip.'); return; }
    buyerInfo = { name, phone, notes };
  }
  const paidRaw = (document.getElementById('bulkSellPaid').value || '').trim();
  const hasPartial = paidRaw !== '';
  let remaining = hasPartial ? Math.max(0, parseInt(paidRaw, 10) || 0) : Infinity;
  closeBulkSell();
  const soldAt = new Date().toISOString();
  let soldList = [];
  try {
    await apiMutateAndPublish(() => {
      remaining = hasPartial ? Math.max(0, parseInt(paidRaw, 10) || 0) : Infinity; // reset per attempt
      soldList = [];
      const ordered = bags.filter(b => ids.has(b.id) && !b.sold); // re-resolve against fresh data
      for (const b of ordered) {
        const price = bagCatalogPrice(b);
        const soldTo = withBuyer
          ? { ...buyerInfo, soldAt, salePrice: price, paymentMethod: payMethod }
          : { soldAt, salePrice: price, paymentMethod: payMethod };
        if (hasPartial) {
          const pay = Math.min(remaining, price);
          if (pay < price) soldTo.amountPaid = pay; // omit when fully paid → stays paid-in-full
          remaining = Math.max(0, remaining - pay);
        }
        b.sold = true; b.soldTo = soldTo; delete b.salePrice;
        soldList.push(b);
      }
    });
    const total = soldList.reduce((s, b) => s + (Number(b.soldTo.salePrice) || 0), 0);
    bulkSelected.clear(); refreshBulkBar(); renderAll();
    const who = withBuyer && buyerInfo.name ? ' to ' + buyerInfo.name : '';
    const owed = hasPartial ? Math.max(0, total - Math.max(0, parseInt(paidRaw, 10) || 0)) : 0;
    showToast(`Sold ${soldList.length} bag${soldList.length === 1 ? '' : 's'}${who} · ${fmtKsh(total)}${owed > 0 ? ` · ${fmtKsh(owed)} owed` : ''}`);
    if (withBuyer && buyerInfo.phone) sendBuyerToGHLBundle(buyerInfo, soldList, total);
  } catch (err) { showToast('Sync failed: ' + err.message); }
}
async function sendBuyerToGHLBundle(buyer, list, total) {
  try {
    const captchaV3 = await getCaptchaToken();
    await fetch(`${API_BASE}/api/buyer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: buyer.name, phone: buyer.phone, notes: buyer.notes,
        bag_name: `${list.length} bags: ${list.map(b => b.name).join(', ')}`.slice(0, 300),
        bag_price: total, captchaV3,
      }),
    });
  } catch (err) { console.warn('GHL bundle submit failed (non-blocking):', err); }
}
document.getElementById('bulkSellSaveBtn')?.addEventListener('click', () => commitBulkSold(true));
document.getElementById('bulkSellSkipBtn')?.addEventListener('click', () => commitBulkSold(false));
document.getElementById('bulkSellCancelBtn')?.addEventListener('click', closeBulkSell);
document.getElementById('bulkSellModal')?.addEventListener('click', e => { if (e.target.id === 'bulkSellModal') closeBulkSell(); });
document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('#bulkSellPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b === btn));
}));
document.getElementById('bulkSellPaid')?.addEventListener('input', updateBulkSellHint);
document.getElementById('bulkSellPaidNone')?.addEventListener('click', () => {
  document.getElementById('bulkSellPaid').value = '0';
  updateBulkSellHint();
});
// Existing-customer picker: search the saved-customer ledger, tap to fill
// name+phone. Shared by the bulk-sell and single-sell modals.
function wireCustomerPicker({ searchId, resultsId, nameId, phoneId }) {
  const search = document.getElementById(searchId);
  const box = document.getElementById(resultsId);
  if (!search || !box) return;
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    if (!term) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const digits = term.replace(/[^0-9+]/g, '');
    const matches = customerLedger()
      .filter(c => (c.name || '').toLowerCase().includes(term) || (digits && (c.phone || '').includes(digits)))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 8);
    box.innerHTML = matches.length
      ? matches.map(c => {
          const meta = `${escapeHtml(c.phone || '')}${c.purchases.length ? ` · ${c.purchases.length} bought` : ''}`;
          return `<button type="button" class="client-item-opt" data-name="${escapeHtml(c.name || '')}" data-phone="${escapeHtml(c.phone || '')}">${escapeHtml(c.name || '(no name)')}<span>${meta}</span></button>`;
        }).join('')
      : '<div class="client-item-empty">No saved customer matches. Type the details below to add a new one.</div>';
    box.style.display = '';
  });
  box.addEventListener('click', e => {
    const opt = e.target.closest('.client-item-opt');
    if (!opt) return;
    document.getElementById(nameId).value = opt.dataset.name || '';
    document.getElementById(phoneId).value = opt.dataset.phone || '';
    search.value = opt.dataset.name || opt.dataset.phone || '';
    box.style.display = 'none';
    showToast('Customer selected — edit if needed.');
  });
}
wireCustomerPicker({ searchId: 'bulkSellCustSearch', resultsId: 'bulkSellCustResults', nameId: 'bulkSellName', phoneId: 'bulkSellPhone' });
wireCustomerPicker({ searchId: 'buyerCustSearch', resultsId: 'buyerCustResults', nameId: 'buyerName', phoneId: 'buyerPhone' });

// ---- Bulk sale ----
// Round to the nearest 50 KSh so sale prices look clean (e.g. 2450 -> 2450,
// 2333 -> 2350). Nairobi pricing is always in 50/100 increments.
function roundTo50(n) { return Math.max(50, Math.round(n / 50) * 50); }

window.bulkPutOnSale = () => {
  if (!bulkSelected.size) return;
  document.getElementById('bulkSaleCount').textContent = bulkSelected.size;
  document.getElementById('bulkSalePct').value = '';
  document.getElementById('bulkSaleFixed').value = '';
  setSaleMode('pct');
  document.getElementById('bulkSaleModal').style.display = 'flex';
};
function setSaleMode(mode) {
  document.querySelectorAll('.sale-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.saleMode === mode));
  document.getElementById('bulkSalePctField').style.display = mode === 'pct' ? '' : 'none';
  document.getElementById('bulkSaleFixedField').style.display = mode === 'fixed' ? '' : 'none';
}
document.querySelectorAll('.sale-mode-btn').forEach(btn =>
  btn.addEventListener('click', () => setSaleMode(btn.dataset.saleMode)));
document.getElementById('bulkSaleCancelBtn').addEventListener('click', () => {
  document.getElementById('bulkSaleModal').style.display = 'none';
});
document.getElementById('bulkSaleSaveBtn').addEventListener('click', async () => {
  const mode = document.querySelector('.sale-mode-btn.active')?.dataset.saleMode || 'pct';
  const ids = new Set(bulkSelected);
  // Validate input up-front (before the fresh fetch) so we can bail early.
  let pct = null, fixed = null;
  if (mode === 'pct') {
    pct = parseInt(document.getElementById('bulkSalePct').value, 10);
    if (!pct || pct < 1 || pct > 90) { showToast('Enter a percent between 1 and 90.'); return; }
  } else {
    fixed = parseInt(document.getElementById('bulkSaleFixed').value, 10);
    if (!fixed || fixed <= 0) { showToast('Enter a valid sale price.'); return; }
  }
  document.getElementById('bulkSaleModal').style.display = 'none';
  let applied = 0, skipped = 0;
  try {
    await apiMutateAndPublish(() => {
      applied = 0; skipped = 0;
      bags.forEach(b => {
        if (!ids.has(b.id) || b.sold) return;
        const sp = mode === 'pct' ? roundTo50(Number(b.price) * (1 - pct / 100)) : fixed;
        if (sp < Number(b.price)) { b.salePrice = sp; applied++; } else { skipped++; }
      });
      if (!applied) throw new Error('No bags updated — sale price was not below their price.');
    });
    renderAll();
    showToast(`On sale: ${applied} bag${applied === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}.`);
  } catch(err) { showToast(err.message.startsWith('No bags') ? err.message : 'Sync failed: ' + err.message); }
});

// ---- Boost to top ----
// Sets boostedAt on the selected bags; the public site floats boosted (unsold)
// bags to the top of the default Featured order. Most recently boosted first.
window.bulkBoost = async () => {
  if (!bulkSelected.size) return;
  const ids = new Set(bulkSelected);
  let n = 0;
  try {
    await apiMutateAndPublish(() => {
      n = 0;
      bags.forEach(b => { if (ids.has(b.id) && !b.sold) { b.boostedAt = new Date().toISOString(); n++; } });
      if (!n) throw new Error('No bags boosted — sold bags cannot be boosted.');
    });
    bulkSelected.clear(); refreshBulkBar();
    renderAll();
    showToast(`Boosted ${n} bag${n === 1 ? '' : 's'} to the top of the shop.`);
  } catch(err) { showToast(err.message.startsWith('No bags') ? err.message : 'Sync failed: ' + err.message); }
};

window.bulkRemoveBoost = async () => {
  if (!bulkSelected.size) return;
  const ids = new Set(bulkSelected);
  let n = 0;
  try {
    await apiMutateAndPublish(() => {
      n = 0;
      bags.forEach(b => { if (ids.has(b.id) && b.boostedAt) { delete b.boostedAt; n++; } });
      if (!n) throw new Error('None of the selected bags were boosted.');
    });
    bulkSelected.clear(); refreshBulkBar();
    renderAll();
    showToast(`Removed boost from ${n} bag${n === 1 ? '' : 's'}.`);
  } catch(err) { showToast(err.message.startsWith('None') ? err.message : 'Sync failed: ' + err.message); }
};

window.bulkRemoveSale = async () => {
  if (!bulkSelected.size) return;
  const ids = new Set(bulkSelected);
  let n = 0;
  try {
    await apiMutateAndPublish(() => {
      n = 0;
      bags.forEach(b => { if (ids.has(b.id) && b.salePrice != null) { delete b.salePrice; n++; } });
      if (!n) throw new Error('None of the selected bags were on sale.');
    });
    renderAll();
    showToast(`Removed sale from ${n} bag${n === 1 ? '' : 's'}.`);
  } catch(err) { showToast(err.message.startsWith('None') ? err.message : 'Sync failed: ' + err.message); }
};

// ==================== BAG LIST ====================
let adminSearchQuery = '';

function renderList() {
  syncCustomCategories();
  const list = document.getElementById('adminList');
  document.getElementById('bagCount').textContent = bags.length;
  const nav = document.getElementById('navItemCount'); if (nav) nav.textContent = bags.length;

  const q = adminSearchQuery.trim().toLowerCase();
  const filtered = q
    ? bags.filter(b => (b.name || '').toLowerCase().includes(q) || (b.category || '').toLowerCase().includes(q))
    : bags;

  const meta = document.getElementById('adminSearchMeta');
  if (meta) {
    meta.textContent = q
      ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
      : '';
  }

  list.innerHTML = filtered.map(b => {
    const addedIso = itemAddedAt(b);
    const buyer = b.soldTo?.name
      ? `<div class="admin-card-buyer">Sold to ${escapeHtml(b.soldTo.name)}${b.soldTo.phone ? ' · ' + escapeHtml(b.soldTo.phone) : ''}</div>`
      : '';
    return `
    <div class="admin-card ${bulkSelected.has(b.id) ? 'bulk-selected' : ''}">
      <label class="bulk-check"><input type="checkbox" ${bulkSelected.has(b.id) ? 'checked' : ''} onclick="event.stopPropagation();toggleBulk('${b.id}')"></label>
      <img src="${b.image}" alt="${escapeHtml(b.name)}">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(b.name)}</div>
        <div class="admin-card-price">${
          (!b.sold && b.salePrice > 0 && b.salePrice < b.price)
            ? `<s style="color:#999;font-weight:400;">${fmtKsh(b.price)}</s> <span style="color:#c0392b;font-weight:700;">${fmtKsh(b.salePrice)}</span> <span style="color:#c0392b;font-weight:700;">· SALE</span>`
            : fmtKsh(b.price)
        } ${b.sold ? '· <span style="color:#b00020">SOLD</span>' : ''}${(!b.sold && b.boostedAt) ? ' · <span style="color:#8a6d3b;font-weight:700;">⬆ BOOSTED</span>' : ''}</div>
        <div class="admin-card-stock">${escapeHtml(b.category || 'Uncategorised')}</div>
        ${addedIso ? `<div class="admin-card-added" title="Added ${new Date(addedIso).toLocaleString('en-KE')}">Added ${relTime(addedIso)}</div>` : ''}
        ${buyer}
        <div class="admin-card-actions">
          <button onclick="editBag('${b.id}')">Edit</button>
          <button class="sold-toggle ${b.sold ? 'on' : ''}" onclick="toggleSold('${b.id}')">${b.sold ? 'Unsell' : 'Sell'}</button>
          <button class="danger" onclick="deleteBag('${b.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');

  if (filtered.length === 0 && q) {
    list.innerHTML = `<p style="grid-column:1/-1;padding:24px;text-align:center;color:var(--ink-faint);font-size:14px;">No bags match "${escapeHtml(adminSearchQuery)}".</p>`;
  }
}

// Wire up search input — debounced 160ms, filters by name + category
(function() {
  const input = document.getElementById('adminSearchInput');
  if (!input) return;
  let timer;
  input.addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      adminSearchQuery = e.target.value;
      renderList();
    }, 160);
  });
})();

// ==================== INSIGHTS (per-browser localStorage) ====================
const INSIGHTS_KEY = 'thriftlux_analytics';
function getInsights() {
  try { return JSON.parse(localStorage.getItem(INSIGHTS_KEY) || '{}'); } catch { return {}; }
}
// Pull the shop-wide aggregate from the worker. Falls back to this device's
// localStorage only if the worker is unreachable (offline / down).
async function fetchInsights() {
  try {
    const res = await fetch(`${API_BASE}/api/insights`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}
async function renderInsights() {
  const a = (await fetchInsights()) || getInsights();
  const views = a.itemViews || {};
  const enqs = a.itemEnquiries || {};
  const igClicks = a.itemIgClicks || {};
  const wishlist = a.itemWishlist || {};
  const searchNoResults = a.searchNoResults || {};

  // KPI labels = actions, never visitors. Preserves the per-device truth.
  const sum = m => Object.values(m).reduce((s, n) => s + (n || 0), 0);
  document.getElementById('insightsKpiGrid').innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Item views</div><div class="inv-kpi-val">${sum(views)}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Enquiries</div><div class="inv-kpi-val">${sum(enqs)}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Saved</div><div class="inv-kpi-val">${sum(wishlist)}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">IG clicks</div><div class="inv-kpi-val">${sum(igClicks)}</div></div>
  `;

  function topList(map, limit = 6) {
    const rows = Object.entries(map)
      .map(([id, n]) => ({ b: bags.find(b => b.id === id), n }))
      .filter(r => r.b)
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
    return rows.length
      ? rows.map(({ b, n }) => `
          <div class="recent-row">
            <img src="${b.image}" alt="">
            <div style="flex:1;min-width:0;"><div class="recent-name">${escapeHtml(b.name)}</div><div class="recent-meta">${n} ${n === 1 ? 'time' : 'times'}</div></div>
          </div>`).join('')
      : '<p class="insights-empty">No data yet.</p>';
  }
  document.getElementById('insightsTopViews').innerHTML = topList(views);
  document.getElementById('insightsTopEnquiries').innerHTML = topList(enqs);

  // ⭐ The killer feature: searches that returned nothing = unmet demand
  const gaps = Object.entries(searchNoResults).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const pillsEl = document.getElementById('searchGapsPills');
  if (gaps.length) {
    pillsEl.innerHTML = gaps.map(([q, n]) =>
      `<span class="search-gap-pill">${escapeHtml(q)}<span class="count">${n}</span></span>`
    ).join('');
  } else {
    pillsEl.innerHTML = '<p class="insights-empty" style="margin:0;">No empty searches yet. Once visitors search for something the catalogue doesn\'t have, it shows up here as a sourcing hint.</p>';
  }
}
const insightsResetBtn = document.getElementById('insightsResetBtn');
if (insightsResetBtn) {
  insightsResetBtn.addEventListener('click', async () => {
    if (accountSuspended) { showToast(SUSPENDED_MSG); return; }
    if (!await confirmAction('Reset Insights for the whole shop? This clears the site-wide totals from every device and cannot be undone.', 'Reset')) return;
    try {
      await fetch(`${API_BASE}/api/insights-reset`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    } catch {}
    localStorage.removeItem(INSIGHTS_KEY);
    await renderInsights();
    showToast('Insights reset for the whole shop.');
  });
}

// ==================== EXPENSES ====================
// Operating expenses (IG ad spend, packaging, transport, etc.) — the owner's
// private books, never shown on the public store. Two kinds:
//   one-off    — a single dated amount.
//   recurring  — an amount per daily/weekly/monthly period that auto-accrues
//                from its start date (an estimate; real ad deductions vary).
// Net profit on the Sales Overview = gross profit − total accrued expenses.
const EXPENSES_ENABLED = true; // 3k Shop Records tier; flip false on a locked build
const EXPENSE_CATEGORIES = ['Instagram ads', 'Other ads', 'Packaging', 'Transport / Delivery', 'Stock buying', 'Rent', 'Airtime / Data', 'Other'];
const EXP_DAY_MS = 86400000;
let expEditId = null;     // id being edited, or null when adding
let expConfirmDel = null; // id awaiting delete confirmation

const todayISO = () => new Date().toISOString().slice(0, 10);

// Charge-periods a recurring expense has accrued from start up to `asOf`
// (inclusive of the current period).
function expRecurringPeriods(exp, asOf) {
  const start = Date.parse(exp.startDate);
  if (!Number.isFinite(start)) return 0;
  let end = asOf;
  if (exp.endDate) { const e = Date.parse(exp.endDate); if (Number.isFinite(e)) end = Math.min(end, e); }
  if (end < start) return 0;
  const days = Math.floor((end - start) / EXP_DAY_MS); // 0 on the start day
  if (exp.cadence === 'weekly') return Math.floor(days / 7) + 1;
  if (exp.cadence === 'monthly') {
    const a = new Date(start), b = new Date(end);
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  }
  return days + 1; // daily
}

// Accrued total for one expense up to `asOf` (default now).
function expenseAccrued(exp, asOf = Date.now()) {
  const amt = Number(exp.amount) || 0;
  if (exp.type === 'recurring') return amt * expRecurringPeriods(exp, asOf);
  return amt; // one-off
}

// Total accrued expenses across all entries up to `asOf`.
function expensesTotal(asOf = Date.now()) {
  return (expenses || []).reduce((s, e) => s + expenseAccrued(e, asOf), 0);
}

// Spend that fell within [from, to] — for the "this month" KPI.
function expensesBetween(from, to) {
  let sum = 0;
  for (const e of (expenses || [])) {
    if (e.type === 'recurring') {
      sum += expenseAccrued(e, to) - expenseAccrued(e, from);
    } else {
      const d = Date.parse(e.date);
      if (Number.isFinite(d) && d >= from && d <= to) sum += Number(e.amount) || 0;
    }
  }
  return Math.max(0, Math.round(sum));
}

// Custom categories the owner has already used (anything not in the presets).
// Sweeping the expenses means a custom category persists as a choice forever
// once it's been used once — same idea as the product category dropdown.
function expUsedCategories() {
  const used = new Set();
  (expenses || []).forEach(e => { if (e.category && !EXPENSE_CATEGORIES.includes(e.category)) used.add(e.category); });
  return [...used].sort((a, b) => a.localeCompare(b));
}

// Rebuild the category <select>: presets, then a "Your categories" group of
// custom ones, then the "+ Add new category…" escape hatch. `selected` is
// pre-chosen (and injected if it's a custom value not otherwise listed).
function buildExpCategorySelect(selected) {
  const sel = document.getElementById('expCategory');
  if (!sel) return;
  const custom = expUsedCategories();
  if (selected && !EXPENSE_CATEGORIES.includes(selected) && !custom.includes(selected)) custom.push(selected);
  let html = EXPENSE_CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (custom.length) html += `<optgroup label="Your categories">${custom.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</optgroup>`;
  html += `<option value="__new__">+ Add new category…</option>`;
  sel.innerHTML = html;
  sel.value = (selected && [...sel.options].some(o => o.value === selected)) ? selected : EXPENSE_CATEGORIES[0];
  toggleExpNewCategory();
}

// Show the free-text box only when "+ Add new category…" is picked.
function toggleExpNewCategory() {
  const sel = document.getElementById('expCategory');
  const box = document.getElementById('expCategoryNew');
  if (!sel || !box) return;
  if (sel.value === '__new__') { box.style.display = ''; box.focus(); }
  else { box.style.display = 'none'; box.value = ''; }
}

// Resolve the chosen category, honouring the "+ Add new…" free-text path.
function getExpCategory() {
  const sel = document.getElementById('expCategory');
  if (!sel) return 'Other';
  if (sel.value === '__new__') return document.getElementById('expCategoryNew').value.trim() || 'Other';
  return sel.value || 'Other';
}

function expCadenceWord(c) { return c === 'weekly' ? 'week' : c === 'monthly' ? 'month' : 'day'; }

function expDescribe(e) {
  if (e.type === 'recurring') {
    const since = e.startDate ? fmtDate(e.startDate) : '';
    const status = e.active === false ? ' · stopped' : '';
    return `${fmtKsh(e.amount)}/${expCadenceWord(e.cadence)} · since ${since}${status}`;
  }
  return `${fmtKsh(e.amount)} · ${e.date ? fmtDate(e.date) : ''}`;
}

function renderExpenses() {
  if (!EXPENSES_ENABLED) return;
  const grid = document.getElementById('expKpiGrid');
  const list = document.getElementById('expList');
  if (!grid || !list) return;

  const now = Date.now();
  const monthStart = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const monthSpend = expensesBetween(monthStart, now);
  const allSpend = Math.round(expensesTotal(now));
  const activeRecurring = (expenses || []).filter(e => e.type === 'recurring' && e.active !== false).length;

  grid.innerHTML = `
    <div class="inv-kpi"><div class="inv-kpi-label">Spent this month</div><div class="inv-kpi-val">${fmtKsh(monthSpend)}</div><div class="inv-kpi-sub">on ads, packaging, etc.</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Spent all-time</div><div class="inv-kpi-val">${fmtKsh(allSpend)}</div><div class="inv-kpi-sub">total recorded</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Recurring running</div><div class="inv-kpi-val">${activeRecurring}</div><div class="inv-kpi-sub">auto-adding spend</div></div>`;

  const set = (expenses || []).slice().sort((a, b) => (Date.parse(b.date || b.startDate || b.createdAt) || 0) - (Date.parse(a.date || a.startDate || a.createdAt) || 0));
  if (!set.length) {
    list.innerHTML = `<p style="font-size:13px;color:#8a857f;padding:8px 2px;">No expenses logged yet. Add your Instagram ad spend, packaging, transport — anything you spend on the shop — to see your real profit.</p>`;
    return;
  }
  list.innerHTML = set.map(e => {
    const accrued = e.type === 'recurring' ? `<span style="color:#8a857f;font-size:12px;"> · ${fmtKsh(Math.round(expenseAccrued(e)))} so far</span>` : '';
    const confirming = expConfirmDel === e.id;
    const actions = confirming
      ? `<button class="btn-admin danger" data-exp-del="${e.id}" type="button">Delete</button><button class="btn-admin" data-exp-delcancel="1" type="button">Cancel</button>`
      : `<button class="btn-admin" data-exp-edit="${e.id}" type="button">Edit</button><button class="btn-admin" data-exp-askdel="${e.id}" type="button">Remove</button>`;
    return `<div class="client-row">
      <div class="client-row-main">
        <div class="client-row-name">${escapeHtml(e.label || 'Expense')}</div>
        <div class="client-row-sub">${escapeHtml(e.category || 'Other')} · ${expDescribe(e)}${accrued}</div>
        ${e.note ? `<div class="client-note">${escapeHtml(e.note)}</div>` : ''}
      </div>
      <div class="client-row-actions">${actions}</div>
    </div>`;
  }).join('');
}

// Show/hide the one-off vs recurring field blocks based on the selected type.
function expSyncTypeFields() {
  const type = document.querySelector('#expTypeToggle .pos-pay-btn.active')?.dataset.exptype || 'oneoff';
  const oneoff = document.getElementById('expOneoffFields');
  const recur = document.getElementById('expRecurringFields');
  if (oneoff) oneoff.style.display = type === 'oneoff' ? '' : 'none';
  if (recur) recur.style.display = type === 'recurring' ? '' : 'none';
}

function expResetForm() {
  expEditId = null;
  const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  v('expLabel', ''); v('expAmount', ''); v('expNote', '');
  buildExpCategorySelect();
  document.querySelectorAll('#expTypeToggle .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.exptype === 'oneoff'));
  v('expDate', todayISO());
  const cad = document.getElementById('expCadence'); if (cad) cad.value = 'daily';
  v('expStartDate', todayISO());
  const act = document.getElementById('expActive'); if (act) act.checked = true;
  const sv = document.getElementById('expSaveBtn'); if (sv) sv.textContent = 'Save expense';
  expSyncTypeFields();
}

function editExpense(id) {
  const e = (expenses || []).find(x => x.id === id);
  if (!e) return;
  expEditId = id;
  const v = (eid, val) => { const el = document.getElementById(eid); if (el) el.value = val; };
  v('expLabel', e.label || ''); v('expAmount', e.amount || ''); v('expNote', e.note || '');
  buildExpCategorySelect(e.category);
  document.querySelectorAll('#expTypeToggle .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.exptype === (e.type || 'oneoff')));
  v('expDate', e.date || todayISO());
  const cad = document.getElementById('expCadence'); if (cad) cad.value = e.cadence || 'daily';
  v('expStartDate', e.startDate || todayISO());
  const act = document.getElementById('expActive'); if (act) act.checked = e.active !== false;
  const sv = document.getElementById('expSaveBtn'); if (sv) sv.textContent = 'Update expense';
  expSyncTypeFields();
  const form = document.getElementById('expFormWrap'); if (form && form.tagName === 'DETAILS') form.open = true;
  document.getElementById('expLabel')?.focus();
}

async function saveExpense() {
  if (!EXPENSES_ENABLED) return;
  const label = document.getElementById('expLabel').value.trim();
  const amount = Math.round(Number(document.getElementById('expAmount').value) || 0);
  const category = getExpCategory();
  const type = document.querySelector('#expTypeToggle .pos-pay-btn.active')?.dataset.exptype || 'oneoff';
  const note = document.getElementById('expNote').value.trim();
  if (!label) { showToast('Give the expense a name.'); return; }
  if (!(amount > 0)) { showToast('Enter an amount more than 0.'); return; }

  const exp = { id: expEditId || `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, label, amount, category, type, note };
  if (type === 'recurring') {
    exp.cadence = document.getElementById('expCadence').value || 'daily';
    exp.startDate = document.getElementById('expStartDate').value || todayISO();
    exp.active = document.getElementById('expActive').checked;
    // When stopped, freeze accrual at today's date so it doesn't keep growing.
    if (!exp.active) exp.endDate = (expenses.find(x => x.id === exp.id)?.endDate) || todayISO();
  } else {
    exp.date = document.getElementById('expDate').value || todayISO();
  }
  const editing = !!expEditId;
  if (!editing) exp.createdAt = new Date().toISOString();

  const btn = document.getElementById('expSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await apiMutateAndPublish(() => {
      const i = expenses.findIndex(x => x.id === exp.id);
      if (i >= 0) expenses[i] = { ...expenses[i], ...exp };
      else expenses.push(exp);
    });
    expResetForm();
    renderAll();
    showToast(editing ? 'Expense updated.' : 'Expense added.');
    const wrap = document.getElementById('expFormWrap'); if (wrap && wrap.tagName === 'DETAILS') wrap.open = false;
  } catch (e) {
    showToast(e.message || 'Could not save.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = editing ? 'Update expense' : 'Save expense'; }
  }
}

async function deleteExpense(id) {
  try {
    await apiMutateAndPublish(() => { expenses = expenses.filter(x => x.id !== id); });
    expConfirmDel = null;
    if (expEditId === id) expResetForm();
    renderAll();
    showToast('Expense removed.');
  } catch (e) {
    showToast(e.message || 'Could not remove.');
  }
}

function initExpenses() {
  if (!EXPENSES_ENABLED) {
    document.getElementById('expensesDash')?.style.setProperty('display', 'none');
    document.querySelector('.admin-nav a[href="#expensesDash"]')?.style.setProperty('display', 'none');
    return;
  }
  // Populate the category select (presets + any custom ones already used).
  buildExpCategorySelect();
  document.getElementById('expCategory')?.addEventListener('change', toggleExpNewCategory);
  document.getElementById('expDate') && (document.getElementById('expDate').value = todayISO());
  document.getElementById('expStartDate') && (document.getElementById('expStartDate').value = todayISO());
  // Type toggle.
  document.getElementById('expTypeToggle')?.addEventListener('click', (ev) => {
    const b = ev.target.closest('.pos-pay-btn'); if (!b) return;
    document.querySelectorAll('#expTypeToggle .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
    expSyncTypeFields();
  });
  document.getElementById('expSaveBtn')?.addEventListener('click', saveExpense);
  document.getElementById('expCancelBtn')?.addEventListener('click', () => { expResetForm(); const w = document.getElementById('expFormWrap'); if (w && w.tagName === 'DETAILS') w.open = false; });
  // List actions (delegated).
  document.getElementById('expList')?.addEventListener('click', (ev) => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.dataset.expEdit) { editExpense(t.dataset.expEdit); }
    else if (t.dataset.expAskdel) { expConfirmDel = t.dataset.expAskdel; renderExpenses(); }
    else if (t.dataset.expDelcancel) { expConfirmDel = null; renderExpenses(); }
    else if (t.dataset.expDel) { deleteExpense(t.dataset.expDel); }
  });
  expSyncTypeFields();
}

function renderAll() {
  renderStats();
  renderInventory();
  renderBroadcast();
  renderClients();
  renderOwed();
  renderExpenses();
  renderLoyalty();
  renderInsights();
  renderList();
  renderPosToday();
}

// ====== OWED dashboard + pay-debt + reminder ======
function owedByPhone() {
  const m = {};
  for (const bag of bags) {
    if (!bag.sold || !bag.soldTo) continue;
    const bal = saleBalance(bag);
    if (bal <= 0) continue;
    const phone = String(bag.soldTo.phone || '').replace(/[^0-9]/g, '');
    if (phone.length < 9) continue;
    m[phone] = (m[phone] || 0) + bal;
  }
  return m;
}
function owedLedger() {
  const map = new Map();
  for (const bag of bags) {
    if (!bag.sold || !bag.soldTo) continue;
    const bal = saleBalance(bag);
    if (bal <= 0) continue;
    const phone = String(bag.soldTo.phone || '').replace(/[^0-9]/g, '');
    const hasPhone = phone.length >= 9;
    const key = hasPhone ? phone : ('__nophone__' + bag.id);
    let c = map.get(key);
    if (!c) { c = { phone: hasPhone ? phone : '', name: bag.soldTo.name || '', owed: 0, lines: [] }; map.set(key, c); }
    c.owed += bal;
    c.lines.push({
      bagId: bag.id, soldAt: bag.soldTo.soldAt, bagName: bag.name,
      total: saleTotal(bag), balance: bal, at: bag.soldTo.soldAt, notes: bag.soldTo.notes || ''
    });
    if (bag.soldTo.name && !c.name) c.name = bag.soldTo.name;
  }
  return [...map.values()];
}

let owedQuery = '';
function renderOwed() {
  const listEl = document.getElementById('owedList');
  if (!listEl) return;
  const ledger = owedLedger();
  const totalOwed = ledger.reduce((s, c) => s + c.owed, 0);
  const withPhone = ledger.filter(c => c.phone);
  let oldest = null;
  ledger.forEach(c => c.lines.forEach(l => { const t = new Date(l.at || 0).getTime(); if (t && (oldest === null || t < oldest)) oldest = t; }));

  const nav = document.getElementById('navOwedCount'); if (nav) nav.textContent = ledger.length || '';
  const navLink = document.getElementById('owedNavLink'); if (navLink) navLink.classList.toggle('admin-nav-owed-on', totalOwed > 0);

  const kpi = document.getElementById('owedKpiGrid');
  if (kpi) kpi.innerHTML = `
    <div class="inv-kpi danger"><div class="inv-kpi-label">Total owed to you</div><div class="inv-kpi-val">${fmtKsh(totalOwed)}</div><div class="inv-kpi-sub">across ${ledger.length} customer${ledger.length === 1 ? '' : 's'}</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Customers owing</div><div class="inv-kpi-val">${ledger.length}</div><div class="inv-kpi-sub">${withPhone.length} with a phone saved</div></div>
    <div class="inv-kpi"><div class="inv-kpi-label">Oldest balance</div><div class="inv-kpi-val">${oldest ? relTime(new Date(oldest).toISOString()) : '—'}</div><div class="inv-kpi-sub">${oldest ? 'taken ' + fmtDate(new Date(oldest).toISOString()) : 'since the bag was taken'}</div></div>
  `;

  if (!ledger.length) {
    listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No one owes you right now. When you mark a bag sold and the customer pays less than the price, the balance shows up here so you can chase it.</p>';
    return;
  }
  const q = owedQuery.toLowerCase();
  const rows = ledger
    .filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.phone.includes(q))
    .sort((a, b) => b.owed - a.owed);
  if (!rows.length) { listEl.innerHTML = '<p style="font-size:13px;color:#999;padding:14px;">No customers match your search.</p>'; return; }
  listEl.innerHTML = rows.map(c => {
    const items = c.lines.slice().sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .map(l => `<span class="owed-line">${escapeHtml(l.bagName)} · owes ${fmtKsh(l.balance)} of ${fmtKsh(l.total)} · taken ${fmtDate(l.at)} (${relTime(l.at)})${l.notes ? ` · <em>${escapeHtml(l.notes)}</em>` : ''}</span>`).join('');
    const noPhone = !c.phone;
    const title = noPhone ? 'Buyer not saved' : (c.name || 'Unnamed customer');
    const sub = noPhone
      ? `${c.lines.length} bag${c.lines.length === 1 ? '' : 's'} on credit · no phone saved`
      : `${escapeHtml(c.phone)} · ${c.lines.length} bag${c.lines.length === 1 ? '' : 's'} on credit`;
    const noteLine = noPhone ? '<div class="client-note">Add this customer\'s phone (Edit the bag in All bags) so you can track and collect it.</div>' : '';
    const actions = noPhone ? '' : `
          <button class="btn-admin gold" onclick="openPayDebt('${c.phone}')">Record payment</button>
          <button class="btn-admin" onclick="remindDebt('${c.phone}')">Remind</button>`;
    return `
      <div class="client-row owed-row">
        <div class="client-row-main">
          <div class="client-row-name">${escapeHtml(title)} <span class="owed-amount">owes ${fmtKsh(c.owed)}</span></div>
          <div class="client-row-sub">${sub}</div>
          ${noteLine}
          <div class="owed-lines">${items}</div>
          <div class="owed-total">Total owing: <span class="owed-amount">${fmtKsh(c.owed)}</span></div>
        </div>
        <div class="client-row-actions">${actions}</div>
      </div>`;
  }).join('');
}
document.getElementById('owedSearch')?.addEventListener('input', e => { owedQuery = e.target.value.trim(); renderOwed(); });

let payingPhone = '';
function openPayDebt(phone) {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  payingPhone = phone;
  document.getElementById('payDebtName').textContent = c.name || c.phone;
  document.getElementById('payDebtOwed').textContent = fmtKsh(c.owed);
  document.getElementById('payDebtAmount').value = c.owed;
  document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
  document.getElementById('payDebtModal').style.display = 'flex';
  document.getElementById('payDebtAmount').focus();
}
window.openPayDebt = openPayDebt;
function closePayDebt() { document.getElementById('payDebtModal').style.display = 'none'; payingPhone = ''; }
document.getElementById('payDebtCancelBtn')?.addEventListener('click', closePayDebt);
document.getElementById('payDebtModal')?.addEventListener('click', e => { if (e.target.id === 'payDebtModal') closePayDebt(); });
document.getElementById('payDebtPay')?.addEventListener('click', e => {
  const b = e.target.closest('.pos-pay-btn'); if (!b) return;
  document.querySelectorAll('#payDebtPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b));
});
document.getElementById('payDebtSaveBtn')?.addEventListener('click', async () => {
  const phone = payingPhone;
  const amount = parseInt(document.getElementById('payDebtAmount').value, 10);
  const method = document.querySelector('#payDebtPay .pos-pay-btn.active')?.dataset.pay || 'mpesa';
  if (!phone) return;
  if (isNaN(amount) || amount <= 0) { showToast('Enter how much they paid.'); return; }
  closePayDebt();
  const at = new Date().toISOString();
  try {
    let applied = 0;
    await apiMutateAndPublish(() => {
      // Apply oldest balance first
      const lines = [];
      for (const bag of bags) {
        if (!bag.sold || !bag.soldTo) continue;
        if (String(bag.soldTo.phone || '').replace(/[^0-9]/g, '') !== phone) continue;
        if (saleBalance(bag) > 0) lines.push(bag);
      }
      lines.sort((a, b) => new Date(a.soldTo.soldAt || 0) - new Date(b.soldTo.soldAt || 0));
      let remaining = amount;
      for (const bag of lines) {
        if (remaining <= 0) break;
        const pay = Math.min(saleBalance(bag), remaining);
        if (pay <= 0) continue;
        if (!bag.soldTo.payments) bag.soldTo.payments = [];
        bag.soldTo.payments.push({ amount: pay, at, method });
        remaining -= pay; applied += pay;
      }
    });
    renderOwed(); renderClients(); renderStats();
    showToast(applied > 0 ? `Payment of ${fmtKsh(applied)} recorded.` : 'That balance is already cleared.');
  } catch (e) { showToast('Error: ' + e.message); }
});

window.remindDebt = phone => {
  const c = owedLedger().find(x => x.phone === phone);
  if (!c) return;
  const first = (c.name || 'there').split(' ')[0];
  const n = c.lines.length;
  const list = c.lines.map((l, i) => `${i + 1}. *${l.bagName}*\n    Taken ${fmtDate(l.at)} · balance ${fmtKsh(l.balance)}`).join('\n');
  const intro = n === 1
    ? `A friendly reminder about your balance on the bag you took from ThriftLux:`
    : `A friendly reminder about the ${n} bags you took from ThriftLux that still have a balance:`;
  const msg = `Hi ${first}, hope you're doing well.\n\n${intro}\n\n${list}\n\n*Total still owing: ${fmtKsh(c.owed)}*\nYou can pay via M-Pesa whenever you're ready. Thank you!`;
  // Phone is already normalized to digits; wa.me needs no '+'.
  window.open(`https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(msg)}`, '_blank');
};

// Paid-input live-balance hint (used by buyerPaid + posPaid)
function paidHint(priceEl, paidEl, hintEl) {
  const total = (parseInt(priceEl?.value, 10) || 0);
  const raw = (paidEl?.value || '').trim();
  if (!hintEl) return;
  if (raw === '') { hintEl.style.display = 'none'; return; }
  const bal = total - Math.min(total, Math.max(0, parseInt(raw, 10) || 0));
  hintEl.style.display = bal > 0 ? '' : 'none';
  if (bal > 0) hintEl.textContent = `Balance owing: ${fmtKsh(bal)}`;
}
function syncPaid(priceId, paidId, hintId, btnId) {
  const paidEl = document.getElementById(paidId);
  paidHint(document.getElementById(priceId), paidEl, document.getElementById(hintId));
  const btn = document.getElementById(btnId);
  if (btn && paidEl) btn.classList.toggle('active', (paidEl.value || '').trim() === '0');
}
['buyerPaid'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid(null, 'buyerPaid', 'buyerPaidHint', 'buyerPaidNone')));
document.getElementById('buyerPaidNone')?.addEventListener('click', () => {
  document.getElementById('buyerPaid').value = '0';
  syncPaid(null, 'buyerPaid', 'buyerPaidHint', 'buyerPaidNone');
});
['posPaid', 'posPrice'].forEach(id => document.getElementById(id)?.addEventListener('input',
  () => syncPaid('posPrice', 'posPaid', 'posPaidHint', 'posPaidNone')));
document.getElementById('posPaidNone')?.addEventListener('click', () => {
  document.getElementById('posPaid').value = '0';
  syncPaid('posPrice', 'posPaid', 'posPaidHint', 'posPaidNone');
});

// ====== INSTAGRAM BULK SYNC ======
// "Check for new posts" widget. Pulls fresh IG posts, runs them through the
// worker's vision + text AI classifier, and shows a preview list. Owner ticks
// the bags they want and clicks "Add selected bags" to commit. Dedup contract:
// posts whose shortcode is already in the catalog never appear in the preview.
const IG_USER_ID = '27867036937';
const BAG_CATEGORIES = ['Crossbody', 'Shoulder', 'Tote', 'Top Handle', 'Hobo', 'Bucket', 'Baguette', 'Clutch', 'Sling', 'Belt Bag'];
let igSyncCandidates = [];

const igSyncCheckBtn = document.getElementById('igSyncCheckBtn');
const igSyncCommitBtn = document.getElementById('igSyncCommitBtn');
const igSyncCancelBtn = document.getElementById('igSyncCancelBtn');
const igSyncStatus = document.getElementById('igSyncStatus');
const igSyncListEl = document.getElementById('igSyncList');
const igSyncCommitRow = document.getElementById('igSyncCommitRow');

igSyncCheckBtn?.addEventListener('click', checkForNewIgPosts);
igSyncCancelBtn?.addEventListener('click', resetIgSync);
igSyncCommitBtn?.addEventListener('click', commitIgSync);

async function checkForNewIgPosts() {
  if (accountSuspended) { igSyncStatus.textContent = SUSPENDED_MSG; return; }
  igSyncCheckBtn.disabled = true;
  igSyncStatus.textContent = 'Checking Instagram…';
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/api/ig-discover?user_id=${IG_USER_ID}&limit=20`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    igSyncCandidates = data.items || [];
    if (!igSyncCandidates.length) {
      igSyncStatus.textContent = '✓ Catalog is up to date. No new posts on Instagram.';
      igSyncCheckBtn.disabled = false;
      return;
    }
    igSyncStatus.textContent = `Found ${igSyncCandidates.length} new post${igSyncCandidates.length === 1 ? '' : 's'}. Review below, then add.`;
    renderIgSyncList();
    igSyncCommitRow.style.display = 'flex';
  } catch (err) {
    igSyncStatus.textContent = '✗ ' + err.message;
  } finally {
    igSyncCheckBtn.disabled = false;
  }
}

function renderIgSyncList() {
  igSyncListEl.innerHTML = igSyncCandidates.map((it, i) => {
    const s = it.suggested || {};
    const stockText = Object.entries(s.stock || {}).map(([k, v]) => `${k}×${v}`).join(' · ') || 'One Size';
    const captionShort = (it.caption || '').replace(/\s+/g, ' ').slice(0, 120);
    const catOpts = BAG_CATEGORIES.map(c => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c}</option>`).join('');
    return `
      <div class="ig-sync-row" data-idx="${i}">
        <label class="ig-sync-check">
          <input type="checkbox" data-ig-pick="${i}" checked>
        </label>
        <img src="${escapeHtml(it.imageUrl)}" alt="" referrerpolicy="no-referrer">
        <div class="ig-sync-body">
          <div class="ig-sync-row-1">
            <input type="text" class="ig-sync-name" data-ig-name="${i}" value="${escapeHtml(s.name || '')}" placeholder="Name">
            <select class="ig-sync-cat" data-ig-cat="${i}">${catOpts}</select>
          </div>
          <div class="ig-sync-row-2">
            <span class="ig-sync-size">${escapeHtml(stockText)}</span>
            <input type="number" min="0" class="ig-sync-price" data-ig-price="${i}" value="${s.price > 0 ? s.price : ''}" placeholder="Ksh (blank = on request)" style="width:170px;max-width:48%;padding:4px 8px;border:1px solid var(--border,#ccc);border-radius:6px;font-size:13px;">
            <a href="${escapeHtml(it.postUrl)}" target="_blank" rel="noopener" class="ig-sync-postlink">view on IG ↗</a>
          </div>
          <div class="ig-sync-caption">${escapeHtml(captionShort)}</div>
        </div>
      </div>`;
  }).join('');
}

function resetIgSync() {
  igSyncCandidates = [];
  igSyncListEl.innerHTML = '';
  igSyncCommitRow.style.display = 'none';
  igSyncStatus.textContent = '';
}

async function commitIgSync() {
  if (accountSuspended) { igSyncStatus.textContent = SUSPENDED_MSG; return; }
  const picks = [];
  igSyncCandidates.forEach((it, i) => {
    const cb = igSyncListEl.querySelector(`[data-ig-pick="${i}"]`);
    if (!cb || !cb.checked) return;
    const nameEl = igSyncListEl.querySelector(`[data-ig-name="${i}"]`);
    const catEl = igSyncListEl.querySelector(`[data-ig-cat="${i}"]`);
    const priceEl = igSyncListEl.querySelector(`[data-ig-price="${i}"]`);
    const priceRaw = (priceEl?.value || '').trim();
    picks.push({
      shortcode: it.shortcode,
      name: (nameEl?.value || it.suggested?.name || '').trim() || 'Pre-loved Bag',
      category: catEl?.value || it.suggested?.category || 'Shoulder',
      stock: it.suggested?.stock || { 'One Size': 1 },
      price: priceRaw === '' ? 0 : (parseInt(priceRaw, 10) || 0),
      description: it.suggested?.description || '',
      imageUrls: it.imageUrls || [it.imageUrl],
      takenAt: it.takenAt,
    });
  });
  if (!picks.length) { showToast('Tick at least one bag to add.'); return; }
  igSyncCommitBtn.disabled = true;
  igSyncCommitBtn.textContent = `Adding ${picks.length}…`;
  try {
    const res = await fetch(`${API_BASE}/api/ig-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ items: picks }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`Added ${data.added} bag${data.added === 1 ? '' : 's'} from Instagram.`);
    igSyncStatus.textContent = `✓ Added ${data.added}. ${data.errors?.length ? `(${data.errors.length} failures)` : ''}`;
    resetIgSync();
    await loadData();
    renderAll();
  } catch (err) {
    showToast('Error: ' + err.message);
    igSyncStatus.textContent = '✗ ' + err.message;
  } finally {
    igSyncCommitBtn.disabled = false;
    igSyncCommitBtn.textContent = 'Add selected bags';
  }
}

window.editBag = editBag;
window.deleteBag = deleteBag;
window.toggleSold = toggleSold;

async function init() {
  const catSel = document.getElementById('categoryInput');
  if (catSel) catSel.addEventListener('change', toggleNewCategoryInput);
  showToast('Loading bags…');
  await loadData();
  renderSuspendedBanner();
  initExpenses();
  renderAll();
  initNavScrollSpy();
  initAutoRefresh();
}

// Keep an always-open admin tab from showing stale data: when the tab regains
// focus, pull the latest catalogue and re-render. Sales/owed entered on another
// device then appear here without a manual reload. Skipped whenever the owner is
// mid-action (typing in a field, editing an item, or a modal is open) so it can
// never wipe in-progress input. This is a VIEW refresh only — saves are already
// protected by the rev check in apiMutateAndPublish.
let _autoRefreshing = false;
function adminIsBusy() {
  if (editingId) return true;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  // any modal currently shown (modals toggle inline display)
  return Array.from(document.querySelectorAll('[id*="Modal"]'))
    .some(el => el.style && el.style.display && el.style.display !== 'none');
}
async function autoRefresh() {
  if (_autoRefreshing || accountSuspended || adminIsBusy()) return;
  _autoRefreshing = true;
  try {
    const before = dataRev;
    await loadData();
    if (dataRev !== before) { renderAll(); } // only re-render if data actually changed
  } catch (_) { /* offline / transient — ignore, try again on next focus */ }
  finally { _autoRefreshing = false; }
}
function initAutoRefresh() {
  window.addEventListener('focus', autoRefresh);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoRefresh(); });
}

/* ===== Nav scrollspy — highlight the section currently in view ===== */
function initNavScrollSpy() {
  const nav = document.getElementById('adminNav');
  if (!nav) return;
  const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
    .map(a => ({ a, section: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter(x => x.section);
  if (!items.length) return;

  let ticking = false;
  function update() {
    ticking = false;
    const probe = nav.offsetHeight + 24; // line just below the sticky nav
    let current = items[0];
    for (const item of items) {
      if (item.section.getBoundingClientRect().top - probe <= 0) current = item;
    }
    // near the bottom of the page → activate the last section
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      current = items[items.length - 1];
    }
    items.forEach(({ a }) => a.classList.toggle('active', a === current.a));
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();
}

// ====== POS — SELL IN STORE (counter checkout) + RECEIPTS ======
// Thrift one-of-one model: a sale MARKS the bag sold (sold:true + soldTo{...}),
// no size/qty. Reuses commitSold's mechanics + the existing sales engine.
let posItemId = '';
let posPayMethod = 'mpesa';
let lastPosSale = null;
function posWaPhone(p) { return waPhone(p); }
function posRenderResults(q) {
  const box = document.getElementById('posItemResults');
  const query = (q || '').toLowerCase();
  if (!query) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = bags.filter(b => !b.sold && (b.name || '').toLowerCase().includes(query)).slice(0, 12);
  box.innerHTML = matches.length
    ? matches.map(b => `<button type="button" class="client-item-opt" data-id="${b.id}">${escapeHtml(b.name)}<span>${fmtKsh(b.price)}</span></button>`).join('')
    : '<div class="client-item-empty">No available items match.</div>';
  box.style.display = '';
}
function posSelectItem(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag || bag.sold) return;
  posItemId = id;
  document.getElementById('posItemSearch').value = bag.name;
  document.getElementById('posItemResults').style.display = 'none';
  document.getElementById('posPrice').value = (bag.salePrice > 0 && bag.salePrice < bag.price) ? bag.salePrice : (bag.price || '');
  document.getElementById('posChosen').innerHTML = `Selling <strong>${escapeHtml(bag.name)}</strong> · <button type="button" id="posClearItem">change</button>`;
  document.getElementById('posChosen').style.display = '';
  document.getElementById('posSaleFields').style.display = '';
  document.getElementById('posReceiptPanel').style.display = 'none';
}
function posReset() {
  posItemId = ''; posPayMethod = 'mpesa';
  ['posItemSearch', 'posBuyerName', 'posBuyerPhone', 'posBuyerNote'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
  document.getElementById('posItemResults').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posReceiptPanel').style.display = 'none';
  document.getElementById('posCustomerFields').style.display = '';
  document.querySelectorAll('#posPay .pos-pay-btn').forEach(b => b.classList.toggle('active', b.dataset.pay === 'mpesa'));
}
function posReceiptText(s) {
  return [`*ThriftLux* receipt`, `${s.name}`, `Total: ${fmtKsh(s.amount)}. Paid by ${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}.`, `Thank you for shopping with us!`].join('\n');
}
function showPosReceipt(s) {
  document.getElementById('posSaleFields').style.display = 'none';
  document.getElementById('posChosen').style.display = 'none';
  document.getElementById('posItemSearch').value = '';
  const pay = s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash';
  document.getElementById('posReceiptSummary').innerHTML = `<strong>${escapeHtml(s.name)}</strong><br>${fmtKsh(s.amount)} · paid by ${pay}`;
  const wa = document.getElementById('posWaReceiptBtn');
  if (s.buyerPhone && s.buyerPhone.replace(/[^0-9]/g, '').length >= 9) { wa.href = `https://wa.me/${posWaPhone(s.buyerPhone)}?text=${encodeURIComponent(posReceiptText(s))}`; wa.style.display = ''; }
  else { wa.style.display = 'none'; }
  const imgBtn = document.getElementById('posImgReceiptBtn'); // Shop Manager (5k)+ only
  if (imgBtn) imgBtn.style.display = RECEIPT_IMAGE_ENABLED ? '' : 'none';
  document.getElementById('posReceiptPanel').style.display = '';
}
function posPrintReceipt() {
  if (!lastPosSale) return;
  const s = lastPosSale, d = new Date(s.soldAt);
  document.getElementById('posReceiptPrint').innerHTML = `
    <div class="rcpt">
      <div class="rcpt-head">ThriftLux</div>
      <div class="rcpt-sub">0705 044 940</div>
      <hr>
      <div class="rcpt-row"><span>${escapeHtml(s.name)}</span><span>${fmtKsh(s.amount)}</span></div>
      <hr>
      <div class="rcpt-row rcpt-total"><span>TOTAL</span><span>${fmtKsh(s.amount)}</span></div>
      <div class="rcpt-row"><span>Paid by</span><span>${s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash'}</span></div>
      <div class="rcpt-date">${d.toLocaleString('en-GB')}</div>
      <div class="rcpt-foot">Thank you for shopping with us!</div>
    </div>`;
  window.print();
}

// --- Image receipt (canvas PNG) — Shop Manager (5k)+ feature ---------------
// Pure canvas (no library) so it works inside the WhatsApp / IG in-app browser.
// Logo is same-origin (images/logo.jpg) so the canvas never taints on export.
const RECEIPT_IMAGE_ENABLED = true;
const RCPT_BRAND = { name: 'ThriftLux', gold: '#c9a961', goldDeep: '#a88847', ink: '#0d0d0d', inkSoft: '#4a4540', faint: '#8a857f', line: '#ece6dc', addr: ['0705 044 940'], url: 'nessa.co.ke/thriftlux', sizePrefix: '' };
let _receiptLogo = null;
function loadReceiptLogo() {
  if (_receiptLogo !== null) return Promise.resolve(_receiptLogo || null);
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { _receiptLogo = img; res(img); };
    img.onerror = () => { _receiptLogo = false; res(null); };
    img.src = 'images/logo.jpg';
  });
}
function buildReceiptCanvas(s, logoImg, B) {
  const SCALE = 3, W = 620, M = 44;
  const qty = Number(s.qty) || 1;
  const total = (Number(s.amount) || 0) * qty;
  const hasBal = s.balance > 0;
  const detail = [];
  if (s.size) detail.push((B.sizePrefix || '') + s.size);
  if (s.size || qty > 1) detail.push(`${qty} × ${fmtKsh(s.amount)}`);
  const subLine = detail.join(' · ');
  const seg = { top: 34, logo: logoImg ? 132 : 88, caption: 30, addr: B.addr.length > 1 ? 46 : 30, div1: 26,
    item: subLine ? 64 : 44, div2: 26, total: 52, cust: s.buyerName ? 34 : 0, paid: 34, bal: hasBal ? 70 : 0, date: 38, foot: 60, bottom: 30 };
  const H = Object.values(seg).reduce((a, b) => a + b, 0);
  const c = document.createElement('canvas');
  c.width = W * SCALE; c.height = H * SCALE;
  const x = c.getContext('2d'); x.scale(SCALE, SCALE);
  const trunc = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  x.fillStyle = '#fffdf8'; x.fillRect(0, 0, W, H);
  x.fillStyle = B.gold; x.fillRect(0, 0, W, 6);
  let y = seg.top;
  x.textAlign = 'center';
  if (logoImg) {
    const lw = 150, lh = Math.min(lw * (logoImg.height / logoImg.width || 1), 118);
    x.drawImage(logoImg, (W - lw) / 2, y, lw, lh);
  } else { x.fillStyle = B.ink; x.font = '600 32px Georgia, serif'; x.fillText(B.name, W / 2, y + 38); }
  y += seg.logo;
  x.fillStyle = B.goldDeep; x.font = '600 15px Arial'; x.fillText('S A L E   R E C E I P T', W / 2, y); y += seg.caption;
  x.fillStyle = B.faint; x.font = '13px Arial'; B.addr.forEach((line, i) => x.fillText(line, W / 2, y + i * 18)); y += seg.addr;
  const div = () => { x.strokeStyle = B.line; x.lineWidth = 1; x.beginPath(); x.moveTo(M, y); x.lineTo(W - M, y); x.stroke(); };
  div(); y += seg.div1;
  x.textAlign = 'left'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(trunc(s.name, 32), M, y + 6);
  if (subLine) {
    x.fillStyle = B.faint; x.font = '14px Arial'; x.fillText(subLine, M, y + 30);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(fmtKsh(total), W - M, y + 30);
  } else { x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 18px Arial'; x.fillText(fmtKsh(total), W - M, y + 6); }
  y += seg.item;
  x.textAlign = 'left'; div(); y += seg.div2;
  x.fillStyle = B.ink; x.font = '700 22px Arial'; x.fillText('TOTAL', M, y + 8);
  x.textAlign = 'right'; x.fillStyle = B.goldDeep; x.font = '700 24px Arial'; x.fillText(fmtKsh(total), W - M, y + 8); y += seg.total;
  if (s.buyerName) {
    x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Customer', M, y);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(trunc(s.buyerName, 26), W - M, y); y += seg.cust;
  }
  x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Paid by', M, y);
  x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(s.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash', W - M, y); y += seg.paid;
  if (hasBal) {
    x.textAlign = 'left'; x.fillStyle = B.inkSoft; x.font = '15px Arial'; x.fillText('Paid now', M, y);
    x.textAlign = 'right'; x.fillStyle = B.ink; x.font = '600 15px Arial'; x.fillText(fmtKsh(s.paid), W - M, y); y += 34;
    x.textAlign = 'left'; x.fillStyle = '#b00020'; x.font = '700 16px Arial'; x.fillText('BALANCE OWING', M, y);
    x.textAlign = 'right'; x.fillText(fmtKsh(s.balance), W - M, y); y += 36;
  }
  x.textAlign = 'center'; x.fillStyle = B.faint; x.font = '13px Arial';
  x.fillText(new Date(s.soldAt || Date.now()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), W / 2, y); y += seg.date;
  x.fillStyle = B.goldDeep; x.font = 'italic 16px Georgia, serif'; x.fillText('Thank you for shopping with us', W / 2, y);
  x.fillStyle = B.gold; x.font = '600 13px Arial'; x.fillText(B.url, W / 2, y + 24);
  return c;
}
async function posShareReceiptImage() {
  if (!lastPosSale) return;
  const btn = document.getElementById('posImgReceiptBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const logo = await loadReceiptLogo();
    const canvas = buildReceiptCanvas(lastPosSale, logo, RCPT_BRAND);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('render failed');
    const fname = `${RCPT_BRAND.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-receipt-${(lastPosSale.name || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 28)}.png`;
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: RCPT_BRAND.name + ' receipt', text: posReceiptText(lastPosSale) });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('Receipt image saved to your phone — attach it in WhatsApp.');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showToast('Could not make the receipt image: ' + (e.message || e));
  } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
function renderPosToday() {
  const el = document.getElementById('posTodaySplit'); if (!el) return;
  const todayStart = startOfDay(new Date());
  let cashT = 0, mpesaT = 0, soldToday = 0;
  bags.forEach(b => {
    if (b.sold && b.soldTo && b.soldTo.soldAt && new Date(b.soldTo.soldAt) >= todayStart) {
      const amt = Number(b.soldTo.salePrice != null ? b.soldTo.salePrice : (b.price || 0));
      soldToday += 1;
      if (b.soldTo.paymentMethod === 'mpesa') mpesaT += amt; else cashT += amt;
    }
  });
  el.innerHTML = `<span class="pos-today-label">Today's takings</span>`
    + `<span class="pos-chip cash">💵 Cash ${fmtKsh(cashT)}</span>`
    + `<span class="pos-chip mpesa">📱 M-Pesa ${fmtKsh(mpesaT)}</span>`
    + `<span class="pos-chip total">${soldToday} sold</span>`;
}
async function recordPosSale() {
  const targetId = posItemId;
  if (!targetId) { showToast('Pick an item first.'); return; }
  const cur = bags.find(b => b.id === targetId);
  if (!cur) { showToast('Item not found — refresh.'); return; }
  if (cur.sold) { showToast('That item is already sold.'); return; }
  const priceRaw = parseInt(document.getElementById('posPrice').value, 10);
  const name = document.getElementById('posBuyerName').value.trim();
  const phone = document.getElementById('posBuyerPhone').value.trim().replace(/[^0-9+]/g, '');
  const note = (document.getElementById('posBuyerNote')?.value || '').trim();
  const soldAt = new Date().toISOString();
  const btn = document.getElementById('posRecordBtn'); btn.disabled = true;
  try {
    let soldName = '', amount = 0;
    await apiMutateAndPublish(() => {
      const b = bags.find(x => x.id === targetId);
      if (!b) throw new Error('Item no longer exists — refresh admin');
      if (b.sold) throw new Error('Already sold — refresh admin');
      amount = isNaN(priceRaw) ? (Number(b.price) || 0) : priceRaw;
      b.sold = true;
      // Owed feature: capture cash taken now (blank = paid in full)
      const posPaidRaw = (document.getElementById('posPaid')?.value || '').trim();
      const soldTo = { name, phone, notes: note, soldAt, salePrice: amount, paymentMethod: posPayMethod };
      if (posPaidRaw !== '') {
        soldTo.amountPaid = Math.min(amount, Math.max(0, parseInt(posPaidRaw, 10) || 0));
      }
      b.soldTo = soldTo;
      delete b.salePrice;
      soldName = b.name;
      if (phone.replace(/[^0-9]/g, '').length >= 9) {
        if (!Array.isArray(clients)) clients = [];
        const norm = phone.replace(/[^0-9]/g, '');
        const existing = clients.find(c => String(c.phone).replace(/[^0-9]/g, '') === norm);
        if (existing) { if (name) existing.name = name; }
        else clients.push({ id: 'c_' + Date.now(), name: name || '', phone, note, createdAt: soldAt });
      }
    });
    lastPosSale = { name: soldName, amount, paymentMethod: posPayMethod, buyerName: name, buyerPhone: phone, soldAt };
    renderAll();
    showPosReceipt(lastPosSale);
    showToast(`Sold · ${fmtKsh(amount)}`);
  } catch (e) { showToast('Error: ' + e.message); }
  finally { btn.disabled = false; }
}
document.getElementById('posItemSearch')?.addEventListener('input', e => { posItemId = ''; document.getElementById('posSaleFields').style.display = 'none'; document.getElementById('posChosen').style.display = 'none'; posRenderResults(e.target.value.trim()); });
document.getElementById('posItemResults')?.addEventListener('click', e => { const opt = e.target.closest('.client-item-opt'); if (opt) posSelectItem(opt.dataset.id); });
document.getElementById('posChosen')?.addEventListener('click', e => { if (e.target.id === 'posClearItem') posReset(); });
document.getElementById('posPay')?.addEventListener('click', e => { const b = e.target.closest('.pos-pay-btn'); if (!b) return; posPayMethod = b.dataset.pay; document.querySelectorAll('#posPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b)); });
document.getElementById('saleModalPay')?.addEventListener('click', e => { const b = e.target.closest('.pos-pay-btn'); if (!b) return; document.querySelectorAll('#saleModalPay .pos-pay-btn').forEach(x => x.classList.toggle('active', x === b)); });
document.getElementById('posAddCustomerToggle')?.addEventListener('click', () => { const f = document.getElementById('posCustomerFields'); f.style.display = f.style.display === 'none' ? '' : 'none'; });
document.getElementById('posRecordBtn')?.addEventListener('click', recordPosSale);
document.getElementById('posCancelBtn')?.addEventListener('click', posReset);
document.getElementById('posNewSaleBtn')?.addEventListener('click', posReset);
document.getElementById('posPrintReceiptBtn')?.addEventListener('click', posPrintReceipt);
document.getElementById('posImgReceiptBtn')?.addEventListener('click', posShareReceiptImage);

// ===== Mobile-safe collapsible toggles =====
// Drive each <details> from JS (preventDefault + flip .open). A <summary> with
// display:flex silently breaks native <details> toggling in Safari / mobile
// WebKit — JS ownership sidesteps it entirely. See CATALOG-STANDARDS.md.
(function () {
  const manualEntry = document.getElementById('manualEntry');
  const manualSummary = document.getElementById('manualEntryDivider');
  if (manualSummary) manualSummary.addEventListener('click', (e) => { e.preventDefault(); if (manualEntry) manualEntry.open = !manualEntry.open; });
  document.querySelector('.admin-nav a[href="#addForm"]')?.addEventListener('click', () => { if (manualEntry) manualEntry.open = true; });

  const broadcastCollapse = document.getElementById('broadcastCollapse');
  const broadcastSummary = broadcastCollapse?.querySelector('summary.dash-summary');
  if (broadcastSummary) broadcastSummary.addEventListener('click', (e) => { e.preventDefault(); broadcastCollapse.open = !broadcastCollapse.open; });
  document.querySelector('.admin-nav a[href="#broadcastDash"]')?.addEventListener('click', () => { if (broadcastCollapse) broadcastCollapse.open = true; });
})();

checkAuth();
