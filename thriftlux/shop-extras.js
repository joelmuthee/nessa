/* shop-extras.js — four owner tools shared by the catalog admins.
 *
 * MASTER COPY lives in "Website Designs/shop-extras/shop-extras.js". Each shop
 * carries a copy in its own root because every shop deploys its folder on its
 * own. Edit the master, copy it out, bump ?v= in each admin.html.
 *
 * 1. Send to customer  — one tap opens WhatsApp with the item written out.
 * 2. Asked for         — log what customers wanted and the shop didn't have.
 * 3. Slow stock        — what hasn't sold in N days, and the money in it.
 * 4. Photo check       — photos too small or broken, worst first.
 *
 * Reads the admin's own globals (bags, demand, escapeHtml, fmtKsh,
 * apiMutateAndPublish, showToast) and a per-shop config set in admin.html:
 *   window.SHOP_EXTRAS = { kind: 'stock' | 'thrift', siteUrl: 'https://...', edit: 'editItem' }
 * 'stock' shops hold quantities per size in bag.stock; 'thrift' shops hold one
 * piece per record with a bag.sold flag.
 *
 * The Asked-for log is saved as the top-level `demand` key. The worker strips
 * it from the public API, the same way it strips expenses and clients.
 */
(function () {
  const CFG = window.SHOP_EXTRAS || { kind: 'stock' };
  const THRIFT = CFG.kind === 'thrift';
  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;

  // ---------- shared helpers ----------
  // admin.js declares these with top-level \`let\`, which is shared between
  // classic scripts but never becomes a property of window. Use the bare names.
  function allBags() { return (typeof bags !== 'undefined' && Array.isArray(bags)) ? bags : []; }
  function setDemand(list) { demand = list; }
  const LETTERS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL'];
  function sizeRank(sz) {
    const s = String(sz).trim().toUpperCase();
    const li = LETTERS.indexOf(s);
    if (li !== -1) return [0, li];
    const n = parseFloat(s.replace(/^[A-Z]+\s*/, ''));
    return isNaN(n) ? [2, 0] : [1, n];
  }
  function sortSizes(list) {
    return list.sort((a, b) => {
      const ra = sizeRank(a), rb = sizeRank(b);
      return (ra[0] - rb[0]) || (ra[1] - rb[1]) || String(a).localeCompare(String(b));
    });
  }
  function units(b) {
    if (THRIFT) return b.sold ? 0 : 1;
    return Object.values(b.stock || {}).reduce((s, q) => s + (Number(q) || 0), 0);
  }
  function available(b) { return units(b) > 0; }
  function inStockSizes(b) {
    if (THRIFT) return [];
    return sortSizes(Object.entries(b.stock || {}).filter(([, q]) => Number(q) > 0).map(([s]) => s));
  }
  function effPrice(b) {
    const p = Number(b.price) || 0, s = Number(b.salePrice) || 0;
    return (s > 0 && s < p) ? s : p;
  }
  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.origin).href; } catch (_) { return String(u); }
  }
  function lastActivity(b) {
    // Latest sale, else when it was added. Anything that has never sold and
    // carries no date is "unknown" rather than pretending to be brand new.
    let t = 0;
    (b.sales || []).forEach(r => { const x = Date.parse(r.soldAt || r.date || ''); if (x > t) t = x; });
    if (!t) t = Date.parse(b.createdAt || '') || 0;
    return t;
  }
  function editFn() { return window[CFG.edit || 'editItem'] || window.editItem || window.editBag; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); else alert(m); }
  function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function ksh(n) { return (typeof fmtKsh === 'function') ? fmtKsh(n) : 'Ksh ' + Number(n || 0).toLocaleString('en-KE'); }
  function thumb(b) {
    return b.image
      ? `<img class="sx-thumb" src="${esc(b.image)}" alt="" loading="lazy">`
      : '<span class="sx-thumb sx-thumb-none"></span>';
  }
  function findBag(id) { return allBags().find(b => String(b.id) === String(id)); }

  // ---------- 1. Send to customer ----------
  // Opens WhatsApp's chat picker with the item written out; the owner picks
  // the customer. Photo goes as a link: wa.me cannot attach an image.
  window.sendToCustomer = function (id) {
    const b = findBag(id);
    if (!b) return;
    if (!available(b)) { toast(THRIFT ? 'This one is already sold.' : 'This item is out of stock right now.'); return; }
    const lines = [b.name || 'Item'];
    const p = Number(b.price) || 0, e = effPrice(b);
    lines.push(e < p ? `Ksh ${e.toLocaleString('en-KE')} (was Ksh ${p.toLocaleString('en-KE')})` : `Ksh ${p.toLocaleString('en-KE')}`);
    if (!THRIFT) {
      const s = inStockSizes(b).filter(x => String(x).toLowerCase() !== 'one size');
      if (s.length) lines.push('Sizes available: ' + s.join(', '));
    } else {
      lines.push('Still available');
    }
    if (b.image) lines.push('Photo: ' + absUrl(b.image));
    if (CFG.siteUrl) lines.push('See more: ' + CFG.siteUrl);
    window.open('https://wa.me/?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
  };

  // ---------- 2. Asked for, didn't have ----------
  function demandList() { return (typeof demand !== 'undefined' && Array.isArray(demand)) ? demand : []; }
  function renderAsked() {
    const box = $('askedBody');
    if (!box) return;
    const dl = $('askedItemList');
    if (dl) dl.innerHTML = [...new Set(allBags().map(b => b.name).filter(Boolean))].sort().map(n => `<option value="${esc(n)}">`).join('');
    const since = Date.now() - 30 * DAY;
    const groups = {};
    demandList().forEach(d => {
      const key = (String(d.item || '').trim().toLowerCase()) + '|' + String(d.size || '').trim().toLowerCase();
      const g = groups[key] || (groups[key] = { item: d.item, size: d.size, count: 0, recent: 0, last: 0, ids: [] });
      g.count += 1; g.ids.push(d.id);
      const t = Date.parse(d.at || '') || 0;
      if (t >= since) g.recent += 1;
      if (t > g.last) g.last = t;
    });
    const rows = Object.values(groups).sort((a, b) => (b.recent - a.recent) || (b.count - a.count) || (b.last - a.last));
    if (!rows.length) {
      box.innerHTML = `<p class="sx-empty">Nothing logged yet. When a customer asks for something you don't have${THRIFT ? '' : ' (or a size you have run out of)'}, add it above. After a few weeks this shows you what to buy next.</p>`;
      return;
    }
    box.innerHTML = `<div class="sx-note">Most asked for in the last 30 days first.</div>` + rows.map(g => `
      <div class="sx-row">
        <div class="sx-main">
          <div class="sx-name">${esc(g.item || '(no name)')}${g.size ? ` <span class="stock-cell low">${esc(g.size)}</span>` : ''}</div>
          <div class="sx-sub">Asked ${g.count} time${g.count === 1 ? '' : 's'}${g.recent !== g.count ? ` · ${g.recent} in the last 30 days` : ''} · last ${g.last ? new Date(g.last).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) : 'unknown'}</div>
        </div>
        <button class="btn-admin sx-small" type="button" data-asked-clear="${esc(g.ids.join(','))}">Got it in</button>
      </div>`).join('');
    box.querySelectorAll('[data-asked-clear]').forEach(btn => btn.addEventListener('click', async () => {
      const ids = new Set(btn.dataset.askedClear.split(','));
      btn.disabled = true;
      try {
        await apiMutateAndPublish(() => { setDemand(demandList().filter(d => !ids.has(String(d.id)))); });
        toast('Cleared from the list.');
      } catch (e) { toast(e.message || 'Could not save.'); }
      renderAsked();
    }));
  }
  async function logAsked() {
    const item = ($('askedItem')?.value || '').trim();
    const size = ($('askedSize')?.value || '').trim();
    if (!item) { toast('Type what the customer asked for.'); return; }
    const entry = { id: 'dm_' + Date.now() + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), item, size };
    const btn = $('askedAddBtn'); if (btn) btn.disabled = true;
    try {
      await apiMutateAndPublish(() => { setDemand(demandList().concat([entry])); });
      if ($('askedItem')) $('askedItem').value = '';
      if ($('askedSize')) $('askedSize').value = '';
      toast('Logged.');
    } catch (e) { toast(e.message || 'Could not save.'); }
    if (btn) btn.disabled = false;
    renderAsked();
  }

  // ---------- 3. Slow stock ----------
  function renderSlow() {
    const box = $('slowBody');
    if (!box) return;
    const days = Number($('slowDays')?.value) || 60;
    const cutoff = Date.now() - days * DAY;
    const inStock = allBags().filter(b => available(b)).map(b => {
      const t = lastActivity(b);
      return { b, t, idle: t ? Math.floor((Date.now() - t) / DAY) : null, u: units(b) };
    });
    // An item with no sale and no date could be new or ancient. Listing it as
    // "slowest" would be a guess, so it gets its own group and stays out of the
    // money totals.
    const list = inStock.filter(x => x.t && x.t < cutoff).sort((a, b) => b.idle - a.idle);
    const undated = inStock.filter(x => !x.t);
    let atCost = 0, costKnown = 0, atPrice = 0, totalUnits = 0;
    list.forEach(x => {
      totalUnits += x.u;
      atPrice += x.u * effPrice(x.b);
      if (Number(x.b.cost) > 0) { atCost += x.u * Number(x.b.cost); costKnown += 1; }
    });
    const row = (x, sub) => `
      <div class="sx-row">
        ${thumb(x.b)}
        <div class="sx-main">
          <div class="sx-name">${esc(x.b.name || '')}</div>
          <div class="sx-sub">${sub}${THRIFT ? '' : ` · ${x.u} in stock`} · ${ksh(effPrice(x.b))}</div>
        </div>
        <button class="btn-admin sx-small" type="button" data-sx-edit="${esc(x.b.id)}">Edit</button>
      </div>`;
    let html = '';
    if (!list.length) {
      html += `<p class="sx-empty">Nothing has sat for more than ${days} days. Everything in stock with a date on it has moved recently.</p>`;
    } else {
      const costLine = costKnown === list.length
        ? `${ksh(atCost)} at what you paid`
        : costKnown ? `${ksh(atCost)} at what you paid, for the ${costKnown} with a buying price set` : 'add buying prices to see what you paid';
      html += `<div class="sx-summary"><strong>${list.length} item${list.length === 1 ? '' : 's'}</strong>${THRIFT ? '' : ` · ${totalUnits} units`} with no sale in ${days}+ days.<br>Worth ${ksh(atPrice)} at your selling price · ${costLine}.</div>
        <div class="sx-note">Slowest first. Ideas: put it on sale, boost it for 7 days, or send it to customers who asked for something similar.</div>` +
        list.map(x => row(x, (x.b.sales && x.b.sales.length) ? `Last sold ${x.idle} days ago` : `Added ${x.idle} days ago, never sold`)).join('');
    }
    if (undated.length) {
      html += `<details class="sx-undated"><summary>${undated.length} item${undated.length === 1 ? '' : 's'} in stock with no date recorded (not counted above)</summary>
        <div class="sx-note">These were added before dates were kept and have not sold since, so there is no way to tell how long they have been sitting. Worth a look.</div>` +
        undated.map(x => row(x, 'No date recorded')).join('') + '</details>';
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-sx-edit]').forEach(btn => btn.addEventListener('click', () => { const f = editFn(); if (f) f(btn.dataset.sxEdit); }));
  }

  // ---------- 4. Photo check ----------
  // Measures each photo's real pixel size in the browser. Runs only when the
  // owner taps it: it downloads every photo, which costs mobile data.
  const SMALL_LONG = 800;  // long side under this looks soft on a phone
  // How much of the photo the shop's product card actually shows. Cards crop to
  // their own shape (object-fit: cover), so a tall photo in a square card loses
  // most of its height: Purple Bear's 576x1280 photos show 45%. cardRatio is the
  // card's height / width, set per shop in SHOP_EXTRAS (1 = square, 1.25 = 4:5).
  const CARD_RATIO = Number(CFG.cardRatio) || 1;
  const MIN_SHOWN = 0.65;
  let photoRunning = false;
  function measure(url) {
    return new Promise(res => {
      const img = new Image();
      const done = (r) => { img.onload = img.onerror = null; res(r); };
      const t = setTimeout(() => done({ ok: false, w: 0, h: 0, err: 'timeout' }), 15000);
      img.onload = () => { clearTimeout(t); done({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(t); done({ ok: false, w: 0, h: 0, err: 'broken' }); };
      img.src = url;
    });
  }
  async function runPhotoCheck() {
    const box = $('photoBody');
    if (!box || photoRunning) return;
    photoRunning = true;
    const items = allBags().filter(b => available(b));
    const results = [];
    let i = 0, doneN = 0;
    box.innerHTML = `<p class="sx-empty">Checking ${items.length} photos… <span id="photoProg">0</span> done.</p>`;
    await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
      while (i < items.length) {
        const b = items[i++];
        const r = b.image ? await measure(absUrl(b.image)) : { ok: false, w: 0, h: 0, err: 'none' };
        results.push({ b, ...r });
        doneN += 1; const p = $('photoProg'); if (p) p.textContent = doneN;
      }
    }));
    photoRunning = false;
    // Grade, don't just pass/fail. Uploads are resized so the long side is
    // 1280px, so resolution alone flags almost nothing useful; the common real
    // problem is a tall phone-screen image (e.g. 576 x 1280, a screenshot),
    // which the shop's cards crop hard.
    const grade = r => {
      if (!r.ok) return { rank: 0, label: r.err === 'none' ? 'No photo' : 'Photo will not load' };
      const long = Math.max(r.w, r.h), short = Math.min(r.w, r.h);
      if (long < SMALL_LONG) return { rank: 1, label: `Small photo (${r.w} × ${r.h}), will look blurry` };
      const photoRatio = r.h / r.w;
      const shown = photoRatio > CARD_RATIO ? CARD_RATIO / photoRatio : photoRatio / CARD_RATIO;
      if (shown < MIN_SHOWN) return { rank: 2, label: `Only ${Math.round(shown * 100)}% of this photo shows on the shop, the rest is cropped off (${r.w} × ${r.h})` };
      return null;
    };
    const bad = results.map(r => ({ r, g: grade(r) })).filter(x => x.g)
      .sort((a, b) => (a.g.rank - b.g.rank) || (Math.max(a.r.w, a.r.h) - Math.max(b.r.w, b.r.h)));
    if (!bad.length) {
      box.innerHTML = `<p class="sx-empty">All ${results.length} photos of items in stock look good. Nothing to re-shoot.</p>`;
      return;
    }
    const n = k => bad.filter(x => x.g.rank === k).length;
    const parts = [[0, 'broken or missing'], [1, 'too small'], [2, 'mostly cropped off on the shop']].filter(([k]) => n(k)).map(([k, t]) => `${n(k)} ${t}`);
    box.innerHTML = `<div class="sx-summary"><strong>${bad.length} of ${results.length}</strong> photos could be better: ${parts.join(', ')}.</div>
      <div class="sx-note">Worst first. Take the photo in the same shape as the shop's cards, with the item filling the frame.</div>` +
      bad.map(({ r, g }) => `
      <div class="sx-row">
        ${thumb(r.b)}
        <div class="sx-main">
          <div class="sx-name">${esc(r.b.name || '')}</div>
          <div class="sx-sub">${g.label}</div>
        </div>
        <button class="btn-admin sx-small" type="button" data-sx-edit="${esc(r.b.id)}">Change photo</button>
      </div>`).join('');
    box.querySelectorAll('[data-sx-edit]').forEach(btn => btn.addEventListener('click', () => { const f = editFn(); if (f) f(btn.dataset.sxEdit); }));
  }

  // ---------- wiring ----------
  window.renderExtras = function () { renderAsked(); renderSlow(); };
  function wire() {
    $('askedAddBtn')?.addEventListener('click', logAsked);
    $('askedItem')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); logAsked(); } });
    $('slowDays')?.addEventListener('change', renderSlow);
    $('photoRunBtn')?.addEventListener('click', runPhotoCheck);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  const css = document.createElement('style');
  css.textContent = `
    .sx-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line,#eee); }
    .sx-row:last-child { border-bottom:none; }
    .sx-main { flex:1 1 auto; min-width:0; }
    .sx-name { font-weight:600; font-size:14px; overflow-wrap:anywhere; }
    .sx-sub { font-size:12px; color:var(--ink-soft,#777); margin-top:2px; }
    .sx-thumb { width:44px; height:44px; border-radius:8px; object-fit:cover; flex:0 0 44px; background:#f0ede8; display:block; }
    .sx-small { font-size:12px !important; padding:6px 10px !important; flex:0 0 auto; }
    .sx-empty { color:var(--ink-soft,#777); font-size:13px; }
    .sx-note { font-size:12px; color:var(--ink-soft,#777); margin:4px 0 8px; }
    .sx-summary { font-size:14px; line-height:1.5; margin:4px 0 6px; }
    .sx-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 12px; }
    .sx-form input { flex:1 1 180px; min-width:0; padding:9px 12px; border:1px solid var(--line,#ddd); border-radius:8px; font-size:16px; }
    .sx-form input.sx-size { flex:0 1 110px; }
    .sx-undated { margin-top:14px; }
    .sx-undated summary { cursor:pointer; font-size:13px; font-weight:600; padding:6px 0; }
    .sx-form select { padding:8px 10px; border:1px solid var(--line,#ddd); border-radius:8px; font-size:14px; }
    .admin-card-actions .sx-send { white-space:nowrap; }
  `;
  document.head.appendChild(css);
})();
