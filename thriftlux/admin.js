// ThriftLux Admin
// Thrift store: each bag is one-of-one. No stock grid, no restock modal, no
// "Only N left" — sold/available toggle only. See AUDIT.md.
const ADMIN_PASSWORD = 'thriftlux2026';
const API_BASE = 'https://thriftlux-api.stawisystems.workers.dev';
const ADMIN_TOKEN = atob('TGRCVjlCUEJzNTBrWXBzQjdNWUs1eDlUR1ZNNlh3bE5VUEMzTVRzN3BpUQ==');

let bags = [];
let settings = {};
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

// Every admin save MUST go through this helper. It refetches the live KV state,
// applies the caller's mutation on top, then publishes. Without it, two tabs
// (or any direct API call alongside admin) silently overwrite each other —
// "last bulk-publish wins" with no concurrency check. The mutator runs against
// the FRESH list, never `bags`. It can throw to abort (e.g. dedupe guard).
async function apiMutateAndPublish(mutator) {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load fresh data: ${res.status}`);
  const fresh = await res.json();
  const nextBags = Array.isArray(fresh.bags) ? fresh.bags : [];
  const nextSettings = fresh.settings || {};

  mutator(nextBags, nextSettings);

  const pubRes = await fetch(`${API_BASE}/api/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ bags: nextBags, settings: nextSettings }),
  });
  if (!pubRes.ok) {
    const err = await pubRes.json().catch(() => ({}));
    throw new Error(err.error || `Save failed: ${pubRes.status}`);
  }

  bags = nextBags;
  settings = nextSettings;
  backfill();
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
  const json = await res.json();
  bags = json.bags || [];
  settings = json.settings || {};
  backfill();
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

// Extract the shortcode from an IG URL (reel/p/tv all use the same slug shape).
function igShortcode(url) {
  const m = (url || '').match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function findBagByShortcode(code) {
  if (!code) return null;
  return bags.find(b => {
    const r = (b.reel || b.instagramUrl || '');
    return r.includes('/' + code);
  }) || null;
}

// IG quick-add — uses the worker's /api/ig-fetch when available. Fails politely otherwise.
// If the pasted post already exists in the catalogue (same shortcode), switch into
// edit mode for that bag rather than creating a duplicate. The new photo overlays
// the existing one on save; other fields stay as the admin already set them.
document.getElementById('igQuickBtn').addEventListener('click', async () => {
  const url = document.getElementById('igQuickInput').value.trim();
  const status = document.getElementById('igQuickStatus');
  if (!url) { status.className = 'ig-quick-status err'; status.textContent = 'Paste an Instagram URL first.'; return; }
  status.className = 'ig-quick-status'; status.textContent = 'Fetching…';
  const existing = findBagByShortcode(igShortcode(url));
  try {
    const r = await fetch(`${API_BASE}/api/ig-fetch?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error('endpoint not deployed yet');
    const data = await r.json();

    // Stage the new image (we always want it, whether new bag or update).
    // CORS-critical: IG CDN doesn't send Access-Control-Allow-Origin, so we
    // MUST download the image through the Worker's /api/ig-proxy, never via
    // data.imageUrl directly (which would throw "Failed to fetch" in browser).
    let newStaged = null;
    if (data.imageUrl) {
      const proxied = `${API_BASE}/api/ig-proxy?url=${encodeURIComponent(data.imageUrl)}`;
      const imgRes = await fetch(proxied);
      if (!imgRes.ok) throw new Error(`ig-proxy ${imgRes.status}`);
      const blob = await imgRes.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').toLowerCase();
      const r2 = new FileReader();
      newStaged = await new Promise(resolve => {
        r2.onload = () => resolve({ base64: r2.result.split(',')[1], ext, dataUrl: r2.result });
        r2.readAsDataURL(blob);
      });
    }

    if (existing) {
      // Update-in-place path: switch into edit mode for the existing bag.
      // editBag() fills the form with existing values and hides the IG panel,
      // so we overlay the staged photo afterwards. Status moves to toast since
      // the panel itself is now hidden.
      editBag(existing.id);
      if (newStaged) {
        stagedImage = newStaged;
        imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:200px;border-radius:8px;">`;
      }
      showToast(`Existing bag found — editing "${existing.name}". Save to apply the new photo.`);
      return;
    }

    // New-bag path: existing behaviour.
    if (newStaged) {
      stagedImage = newStaged;
      imagePreview.innerHTML = `<img src="${stagedImage.dataUrl}" style="max-width:200px;border-radius:8px;">`;
    }
    if (data.caption) {
      const firstLine = data.caption.split('\n')[0].trim();
      const m = firstLine.match(/^(.*?)\s*@(\d+)\s*\/?=?/);
      if (m) { nameInput.value = m[1].trim(); priceInput.value = m[2]; }
      else { nameInput.value = firstLine; }
      descInput.value = data.caption.replace(/#\w+/g, '').trim();
      if (/SOLD/i.test(data.caption)) soldInput.checked = true;
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
      await apiMutateAndPublish((bagsList) => {
        const bag = bagsList.find(b => b.id === editingId);
        if (!bag) throw new Error('Bag no longer exists — refresh admin');
        bag.name = name; bag.description = desc; bag.price = price;
        bag.category = category; bag.reel = reel; bag.instagramUrl = reel || bag.instagramUrl;
        if (imagePath) bag.image = imagePath;
        if (extraPaths.length) bag.images = extraPaths;
        bag.sold = sold;
        if (!sold) delete bag.soldTo;
      });
      showToast('Bag updated and live!');
    } else {
      if (!stagedImage) { showToast('Add a bag image.'); setSaving(false); return; }
      await apiMutateAndPublish((bagsList) => {
        // Dedupe guard runs against FRESH data so it catches dupes that landed
        // since admin was opened (e.g. via another tab or a direct API call).
        const code = igShortcode(reel);
        if (code) {
          const dup = bagsList.find(b => (b.reel || b.instagramUrl || '').includes('/' + code));
          if (dup) throw new Error(`Already in catalogue as "${dup.name}". Click Edit on that bag instead.`);
        }
        const id = 'bag_' + Date.now();
        bagsList.unshift({
          id, name, description: desc, category, price,
          reel, instagramUrl: reel, sold,
          image: imagePath,
          images: extraPaths,
          createdAt: new Date().toISOString(),
        });
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
  categoryInput.value = bag.category || '';
  soldInput.checked = !!bag.sold;
  stagedImage = null;
  // Edit mode: label the existing cover so it's obvious which picker replaces it.
  // Without this, admins occasionally drop the new photo into the "Additional images"
  // field below and the cover never updates.
  imagePreview.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:var(--brand,#b8860b);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.4px;">Current cover photo</div>
    <img src="${bag.image}" style="max-width:200px;border-radius:8px;display:block;">
    <div style="font-size:12px;color:#666;margin-top:6px;">To replace it, use the <strong>Main image</strong> file picker directly above. The <em>Additional images</em> field below is for extra angles only.</div>
  `;
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
  if (!confirm('Delete this bag? This cannot be undone.')) return;
  try {
    await apiMutateAndPublish((bagsList) => {
      const i = bagsList.findIndex(b => b.id === id);
      if (i !== -1) bagsList.splice(i, 1);
    });
    renderAll();
    showToast('Bag deleted and live.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
}

async function toggleSold(id) {
  const bag = bags.find(b => b.id === id);
  if (!bag) return;
  if (bag.sold) {
    try {
      await apiMutateAndPublish((bagsList) => {
        const b = bagsList.find(x => x.id === id);
        if (!b) throw new Error('Bag no longer exists — refresh admin');
        b.sold = false;
        delete b.soldTo;
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
    let appliedBag = null;
    await apiMutateAndPublish((bagsList) => {
      const b = bagsList.find(x => x.id === targetId);
      if (!b) throw new Error('Bag no longer exists — refresh admin');
      b.sold = true;
      const salePrice = Number(b.price) || 0;
      b.soldTo = withBuyer
        ? { ...buyerInfo, soldAt: new Date().toISOString(), salePrice }
        : { soldAt: new Date().toISOString(), salePrice };
      appliedBag = b;
    });
    renderAll();
    showToast(withBuyer ? 'SOLD. Buyer saved.' : 'Marked as SOLD.');
    if (withBuyer && appliedBag?.soldTo?.phone) sendBuyerToGHL(appliedBag);
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
  const pills = [
    { k: 'all', l: 'All', n: total },
    { k: 'available', l: 'Available', n: available },
    { k: 'sold', l: 'Sold', n: sold },
  ];
  fb.innerHTML = pills.map(p => `<button class="pill ${invFilter === p.k ? 'active' : ''}" data-k="${p.k}">${p.l} <small>(${p.n})</small></button>`).join('');
  fb.querySelectorAll('.pill').forEach(b => b.addEventListener('click', () => { invFilter = b.dataset.k; invShowAll = false; renderInventory(); }));

  let rows = bags.slice();
  if (invFilter === 'available') rows = rows.filter(b => !isSold(b));
  if (invFilter === 'sold') rows = rows.filter(isSold);
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const shown = invShowAll ? rows : rows.slice(0, INV_PAGE_SIZE);
  const more = rows.length - shown.length;
  document.getElementById('invTableBody').innerHTML = shown.map(b => `
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
  if (more > 0) { btn.style.display = 'block'; btn.textContent = 'Show all ' + rows.length; btn.onclick = () => { invShowAll = true; renderInventory(); }; }
  else if (invShowAll && rows.length > INV_PAGE_SIZE) { btn.style.display = 'block'; btn.textContent = 'Show fewer'; btn.onclick = () => { invShowAll = false; renderInventory(); }; }
  else { btn.style.display = 'none'; }
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
  if (!confirm(`Delete ${bulkSelected.size} bags? Cannot be undone.`)) return;
  const targetIds = new Set(bulkSelected);
  try {
    await apiMutateAndPublish((bagsList) => {
      for (let i = bagsList.length - 1; i >= 0; i--) {
        if (targetIds.has(bagsList[i].id)) bagsList.splice(i, 1);
      }
    });
    bulkSelected.clear();
    renderAll();
    showToast('Deleted.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
};
window.bulkMarkSold = async () => {
  const targetIds = new Set(bulkSelected);
  try {
    await apiMutateAndPublish((bagsList) => {
      bagsList.forEach(b => { if (targetIds.has(b.id) && !b.sold) { b.sold = true; b.soldTo = { salePrice: Number(b.price) || 0, soldAt: new Date().toISOString() }; } });
    });
    renderAll();
    showToast('Marked as sold.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
};
window.bulkMarkAvailable = async () => {
  const targetIds = new Set(bulkSelected);
  try {
    await apiMutateAndPublish((bagsList) => {
      bagsList.forEach(b => { if (targetIds.has(b.id) && b.sold) { b.sold = false; delete b.soldTo; } });
    });
    renderAll();
    showToast('Marked as available.');
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
  const targetIds = new Set(bulkSelected);
  document.getElementById('bulkCatModal').style.display = 'none';
  try {
    await apiMutateAndPublish((bagsList) => {
      bagsList.forEach(b => { if (targetIds.has(b.id)) b.category = cat; });
    });
    renderAll();
    showToast('Categories updated.');
  } catch(err) { showToast('Sync failed: ' + err.message); }
});

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
        <div class="admin-card-price">${fmtKsh(b.price)} ${b.sold ? '· <span style="color:#b00020">SOLD</span>' : ''}</div>
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
  insightsResetBtn.addEventListener('click', () => {
    if (!confirm('Clear insights on this device only? Other devices keep their data.')) return;
    localStorage.removeItem(INSIGHTS_KEY);
    renderInsights();
    showToast('Insights reset on this device.');
  });
}

function renderAll() {
  renderStats();
  renderInventory();
  renderBroadcast();
  renderInsights();
  renderList();
}

window.editBag = editBag;
window.deleteBag = deleteBag;
window.toggleSold = toggleSold;

async function init() {
  showToast('Loading bags…');
  await loadData();
  renderAll();
}
checkAuth();
