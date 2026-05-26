// ThriftLux Admin
// Thrift store: each bag is one-of-one. No stock grid, no restock modal, no
// "Only N left" — sold/available toggle only. See AUDIT.md.
const ADMIN_PASSWORD = 'thriftlux2026';
const API_BASE = 'https://thriftlux-api.stawisystems.workers.dev';
const ADMIN_TOKEN = atob('TGRCVjlCUEJzNTBrWXBzQjdNWUs1eDlUR1ZNNlh3bE5VUEMzTVRzN3BpUQ==');

let bags = [];
let settings = {};
let accountSuspended = false;
let loyaltyUnlocked = false;
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
function login() {
  if (loginPassword.value === ADMIN_PASSWORD) {
    sessionStorage.setItem('thriftlux_auth', '1');
    loginError.style.display = 'none';
    checkAuth();
  } else {
    loginError.style.display = 'block';
  }
}
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('thriftlux_auth');
  location.reload();
});

// ==================== API ====================
async function apiUploadImage(base64, ext) {
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
async function publishBags() {
  const res = await fetch(`${API_BASE}/api/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ bags, settings }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save failed: ${res.status}`);
  }
}

// Every admin write MUST go through this. It refetches live KV, applies the
// caller's mutation against the FRESH list, then publishes — so a stale admin
// tab (or a concurrent direct-API edit) can't silently wipe other changes.
// That stale-overwrite was the bug that deleted Venessa's bags once before.
// Mutators close over module-level `bags` and MUST look up bags by id inside
// the callback — any reference captured before the fetch is stale.
async function apiMutateAndPublish(mutate) {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load fresh data: ${res.status}`);
  const json = await res.json();
  bags = Array.isArray(json.bags) ? json.bags : [];
  settings = json.settings || {};
  loyaltyUnlocked = !!json.loyaltyUnlocked;
  backfill();
  await mutate();
  await publishBags();
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
  const json = await res.json();
  bags = json.bags || [];
  settings = json.settings || {};
  accountSuspended = !!json.suspended;
  loyaltyUnlocked = !!json.loyaltyUnlocked;
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
  b.innerHTML = 'Your store is currently offline because payment is overdue. Please contact Essence Automations to restore it. <a href="https://wa.me/254720615606" style="color:#fff;text-decoration:underline;">Message us</a>';
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
// ====== TRASH (device-local restore bin) ======
// Deleted bags are stashed in localStorage so they can be restored. Kept off the
// server so the public catalogue never sees them; image blobs stay in KV, so a
// restored bag's image URL still resolves. Stored per device only.
const TRASH_KEY = 'thriftlux_trash';
const TRASH_CAP = 50;

function getTrash() {
  try { return JSON.parse(localStorage.getItem(TRASH_KEY) || '[]'); } catch { return []; }
}
function setTrash(arr) { localStorage.setItem(TRASH_KEY, JSON.stringify(arr.slice(0, TRASH_CAP))); }
function trashPush(items) {
  // items: [{ item, index }] — index = position in bags at delete time, for in-place restore
  const now = new Date().toISOString();
  const entries = items.filter(x => x && x.item).map(({ item, index }) => ({ item, index, deletedAt: now }));
  setTrash([...entries, ...getTrash()]);
}

function trashTimeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); return `${d} day${d === 1 ? '' : 's'} ago`;
}

function renderTrash() {
  const list = document.getElementById('trashList');
  if (!list) return;
  const trash = getTrash();
  const countEl = document.getElementById('trashCount');
  const navCount = document.getElementById('navTrashCount');
  if (countEl) countEl.textContent = trash.length;
  if (navCount) navCount.textContent = trash.length;
  const emptyBtn = document.getElementById('emptyTrashBtn');
  if (emptyBtn) emptyBtn.style.display = trash.length ? '' : 'none';
  if (!trash.length) {
    list.innerHTML = '<p style="color:var(--ink-faint);font-size:13px;padding:10px 2px;">Trash is empty. Deleted bags land here so you can restore them. Stored on this device only.</p>';
    return;
  }
  list.innerHTML = trash.map(({ item, deletedAt }) => `
    <div class="admin-card">
      <img src="${item.image}" alt="${escapeHtml(item.name)}">
      <div class="admin-card-body">
        <div class="admin-card-name">${escapeHtml(item.name)}</div>
        <div class="admin-card-stock">${escapeHtml(item.category || 'Uncategorised')} · deleted ${trashTimeAgo(deletedAt)}</div>
        <div class="admin-card-actions">
          <button onclick="restoreItem('${item.id}')">Restore</button>
          <button class="danger" onclick="deleteForever('${item.id}')">Delete forever</button>
        </div>
      </div>
    </div>`).join('');
}

async function restoreItem(id) {
  const trash = getTrash();
  const idx = trash.findIndex(t => t.item && t.item.id === id);
  if (idx === -1) return;
  if (bags.some(b => b.id === id)) {
    trash.splice(idx, 1); setTrash(trash); renderTrash();
    showToast('Already in the catalogue — cleared from Trash.');
    return;
  }
  const entry = trash[idx];
  try {
    await apiMutateAndPublish(() => {
      if (bags.some(b => b.id === id)) return; // already back in catalogue
      const at = Math.min(typeof entry.index === 'number' ? entry.index : bags.length, bags.length);
      bags.splice(at, 0, entry.item);
    });
    trash.splice(idx, 1); setTrash(trash);
    renderAll();
    renderTrash();
    showToast('Bag restored to the catalogue.');
  } catch (err) {
    showToast('Restore failed: ' + err.message);
  }
}

async function deleteForever(id) {
  if (!await confirmAction('Permanently remove this from Trash? It cannot be restored after this.', 'Delete forever')) return;
  setTrash(getTrash().filter(t => !(t.item && t.item.id === id)));
  renderTrash();
  showToast('Removed from Trash.');
}

async function emptyTrash() {
  const n = getTrash().length;
  if (!n) return;
  if (!await confirmAction(`Empty Trash? ${n} bag${n === 1 ? '' : 's'} will be gone for good.`, 'Empty trash')) return;
  setTrash([]);
  renderTrash();
  showToast('Trash emptied.');
}
window.restoreItem = restoreItem;
window.deleteForever = deleteForever;
window.emptyTrash = emptyTrash;

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
function readFileAsStaged(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result;
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, ext, dataUrl });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

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
  return { name, price, description: clean, sold };
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
      const ext = (blob.type.split('/')[1] || 'jpg').toLowerCase();
      const r2 = new FileReader();
      stagedImage = await new Promise(resolve => {
        r2.onload = () => resolve({ base64: r2.result.split(',')[1], ext, dataUrl: r2.result });
        r2.readAsDataURL(blob);
      });
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
  descInput.value = generateDescription(name, categoryInput.value);
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
  const category = categoryInput.value;
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

function resetForm() {
  editingId = null;
  editingIdField.value = '';
  nameInput.value = ''; descInput.value = ''; priceInput.value = '';
  salePriceInput.value = '';
  reelInput.value = ''; categoryInput.value = '';
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
}

function editBag(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  editingId = id;
  editingIdField.value = id;
  nameInput.value = bag.name; descInput.value = bag.description || '';
  priceInput.value = bag.price; reelInput.value = bag.reel || bag.instagramUrl || '';
  salePriceInput.value = bag.salePrice || '';
  categoryInput.value = bag.category || '';
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
  if (!await confirmAction('Delete this bag? You can restore it from Trash below.', 'Delete')) return;
  let removed = null, removedIdx = -1;
  try {
    await apiMutateAndPublish(() => {
      removedIdx = bags.findIndex(b => b.id === id);
      removed = removedIdx === -1 ? null : bags[removedIdx];
      bags = bags.filter(b => b.id !== id);
    });
    if (removed) trashPush([{ item: removed, index: removedIdx }]);
    renderAll();
    renderTrash();
    showToast('Bag deleted — restore it from Trash.');
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
  document.getElementById('buyerModalTitle').textContent = `Mark as sold: ${bag.name}`;
  buyerModal.style.display = 'flex';
  buyerName.focus();
}
function closeBuyerModal() { buyerModal.style.display = 'none'; pendingBag = null; }

async function commitSold(withBuyer) {
  if (!pendingBag) return;
  const targetId = pendingBag.id;
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
      // Record what it actually sold for: the sale price if it was on sale, else the regular price.
      const paid = (b.salePrice > 0 && b.salePrice < b.price) ? b.salePrice : (Number(b.price) || 0);
      b.soldTo = withBuyer
        ? { ...buyerInfo, soldAt: new Date().toISOString(), salePrice: paid }
        : { soldAt: new Date().toISOString(), salePrice: paid };
      delete b.salePrice; // no longer "on sale" once sold
      soldBag = b;
    });
    renderAll();
    showToast(withBuyer ? 'SOLD. Buyer saved.' : 'Marked as SOLD.');
    if (withBuyer && soldBag?.soldTo?.phone) { sendBuyerToGHL(soldBag); if (loyaltyUnlocked) openSaleThanks(soldBag); }
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
  for (const b of bags) {
    if (!isSold(b)) continue;
    const price = salePrice(b);
    buckets.all += price; counts.all++;
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
          <div class="recent-name">${escapeHtml(b.name)}</div>
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
      <td>${fmtKsh(b.price)}</td>
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
  let msg = `Hi ${firstName}! `;
  if (subject) msg += subject + '\n\n';
  if (items.length) {
    msg += 'New drops you might love:\n';
    items.forEach(b => { msg += `\n• ${b.name} — ${fmtKsh(b.price)}${b.instagramUrl ? '\n  ' + b.instagramUrl : ''}`; });
    msg += '\n\n';
  }
  msg += 'Reply here if anything catches your eye 💛\n— Venessa, ThriftLux';
  return msg;
}
function updateBroadcastPreview() {
  document.getElementById('broadcastPreview').value = buildBroadcastMessage('{First name}');
}
document.getElementById('broadcastSubject').addEventListener('input', updateBroadcastPreview);
document.getElementById('broadcastCopyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(buildBroadcastMessage('there')).then(() => showToast('Copied. Paste into a WA broadcast list.'));
});
document.getElementById('broadcastStartBtn').addEventListener('click', () => {
  const buyers = [];
  bags.forEach(b => {
    const s = b.soldTo;
    if (s && s.phone && !broadcastDisabled.has(s.phone)) {
      buyers.push({ name: (s.name || 'Friend').split(' ')[0], phone: s.phone });
    }
  });
  const seen = new Set();
  const dedup = buyers.filter(b => seen.has(b.phone) ? false : (seen.add(b.phone), true));
  if (!dedup.length) { document.getElementById('broadcastStatus').textContent = 'No recipients selected.'; return; }
  document.getElementById('broadcastStatus').textContent = `Opening ${dedup.length} WhatsApp tabs (700ms apart)…`;
  dedup.forEach((b, i) => {
    setTimeout(() => {
      const url = `https://wa.me/${b.phone}?text=${encodeURIComponent(buildBroadcastMessage(b.name))}`;
      window.open(url, '_blank');
    }, i * 700);
  });
});


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
  return [...map.values()];
}

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
  return msg + `\n— Venessa, ThriftLux`;
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
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(loyaltyMessage(c, conf, loyaltyStatus(c, conf)))}`, '_blank');
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
    window.open(`https://wa.me/${c.phone}?text=${encodeURIComponent(loyaltyMessage(c, conf, loyaltyStatus(c, conf)))}`, '_blank');
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
  return msg + `\n— Venessa, ThriftLux`;
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
  window.open(`https://wa.me/${c.phone}?text=${encodeURIComponent(thankYouMessage(bag, c, conf, st))}`, '_blank');
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
  if (!await confirmAction(`Delete ${bulkSelected.size} bags? You can restore them from Trash below.`, 'Delete')) return;
  const ids = new Set(bulkSelected);
  let removed = [];
  try {
    await apiMutateAndPublish(() => {
      removed = [];
      bags.forEach((b, i) => { if (ids.has(b.id)) removed.push({ item: b, index: i }); });
      bags = bags.filter(b => !ids.has(b.id));
    });
    trashPush(removed);
    bulkSelected.clear();
    renderAll(); renderTrash();
    showToast('Deleted — restore from Trash.');
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
        } ${b.sold ? '· <span style="color:#b00020">SOLD</span>' : ''}</div>
        <div class="admin-card-stock">${escapeHtml(b.category || 'Uncategorised')}</div>
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
function renderInsights() {
  const a = getInsights();
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
      : '<p class="insights-empty">No data yet on this device.</p>';
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
    pillsEl.innerHTML = '<p class="insights-empty" style="margin:0;">No empty searches recorded on this device. Once visitors search for something the catalogue doesn\'t have, it shows up here as a sourcing hint.</p>';
  }
}
const insightsResetBtn = document.getElementById('insightsResetBtn');
if (insightsResetBtn) {
  insightsResetBtn.addEventListener('click', async () => {
    if (!await confirmAction('Clear insights on this device only? Other devices keep their data.')) return;
    localStorage.removeItem(INSIGHTS_KEY);
    renderInsights();
    showToast('Insights reset on this device.');
  });
}

function renderAll() {
  renderStats();
  renderInventory();
  renderBroadcast();
  renderLoyalty();
  renderInsights();
  renderList();
}

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
  const picks = [];
  igSyncCandidates.forEach((it, i) => {
    const cb = igSyncListEl.querySelector(`[data-ig-pick="${i}"]`);
    if (!cb || !cb.checked) return;
    const nameEl = igSyncListEl.querySelector(`[data-ig-name="${i}"]`);
    const catEl = igSyncListEl.querySelector(`[data-ig-cat="${i}"]`);
    picks.push({
      shortcode: it.shortcode,
      name: (nameEl?.value || it.suggested?.name || '').trim() || 'Pre-loved Bag',
      category: catEl?.value || it.suggested?.category || 'Shoulder',
      stock: it.suggested?.stock || { 'One Size': 1 },
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
  showToast('Loading bags…');
  await loadData();
  renderSuspendedBanner();
  renderAll();
  renderTrash();
}
checkAuth();
