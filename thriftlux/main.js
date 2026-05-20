// ThriftLux frontend gallery
const IMG_VERSION = 'v7'; // bump this whenever you re-crop/replace bag images
const API_BASE = 'https://thriftlux-api.stawisystems.workers.dev';
const NEW_BADGE_DAYS = 7;
const INSIGHTS_KEY = 'thriftlux_analytics'; // localStorage bucket consumed by admin Insights

(async function() {
  const gallery = document.getElementById('gallery');
  const filterMeta = document.getElementById('filterMeta');
  let bags = [];
  let settings = {};

  // Filter / sort / search state
  let currentFilter = 'all';        // 'all' | 'available' | 'sold'
  let currentCategory = 'all';      // 'all' | category name
  let currentSort = 'featured';     // 'featured' | 'newest' | 'price-asc' | 'price-desc'
  let searchQuery = '';

  async function loadData() {
    try {
      const res = await fetch(`${API_BASE}/api/bags?_=${Date.now()}`);
      const json = await res.json();
      bags = json.bags || [];
      settings = json.settings || {};
    } catch(e) {
      console.error('Failed to load bags from API, falling back to data.json', e);
      try {
        const res = await fetch('data.json');
        const json = await res.json();
        bags = json.bags || [];
        settings = json.settings || {};
      } catch(e2) { bags = []; }
    }
  }

  function fmtPrice(n) { return 'Ksh ' + Number(n || 0).toLocaleString('en-KE'); }
  function isNew(bag) {
    if (!bag.createdAt) return false;
    const age = Date.now() - new Date(bag.createdAt).getTime();
    return age >= 0 && age < NEW_BADGE_DAYS * 86400000;
  }
  // A bag is on sale when it has a valid salePrice below its regular price and
  // hasn't been sold. effectivePrice = what the buyer actually pays right now.
  function isOnSale(bag) {
    return !bag.sold && Number(bag.salePrice) > 0 && Number(bag.salePrice) < Number(bag.price);
  }
  function effectivePrice(bag) { return isOnSale(bag) ? Number(bag.salePrice) : Number(bag.price || 0); }
  function discountPct(bag) { return Math.round((1 - Number(bag.salePrice) / Number(bag.price)) * 100); }

  // ----- Likes (per-bag deterministic base + per-visitor +1 stored locally) -----
  const LIKES_KEY = 'thriftlux_likes';
  function bagBaseLikes(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return 7 + Math.abs(h) % 14; // 7..20 inclusive
  }
  function getLikedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveLikedSet(set) {
    try { localStorage.setItem(LIKES_KEY, JSON.stringify(Array.from(set))); } catch {}
  }
  function bagLikeCount(id) {
    return bagBaseLikes(id) + (getLikedSet().has(id) ? 1 : 0);
  }

  // ----- Insights tracking (per-browser, localStorage) -----
  // Five metrics per CATALOG-STANDARDS.md "Insights" rules.
  function track(metric, key) {
    if (!key && key !== 0) return;
    try {
      const data = JSON.parse(localStorage.getItem(INSIGHTS_KEY) || '{}');
      data[metric] = data[metric] || {};
      data[metric][key] = (data[metric][key] || 0) + 1;
      localStorage.setItem(INSIGHTS_KEY, JSON.stringify(data));
    } catch {}
  }

  // Resolve relative image paths to absolute URLs. WhatsApp will only
  // render a preview card when the URL in the message is fully qualified.
  function absImageUrl(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    return new URL(src, location.href).href;
  }

  // ----- WhatsApp link -----
  // Standard rule: append the item's image URL on its own line at the end,
  // separated by \n\n, so WhatsApp generates a link-preview card.
  function whatsappLink(bag) {
    const phone = (settings.whatsappNumber || '254705044940');
    let pricePart = '';
    if (isOnSale(bag)) pricePart = ` (on sale: ${fmtPrice(bag.salePrice)}, was ${fmtPrice(bag.price)})`;
    else if (bag.price > 0) pricePart = ` (${fmtPrice(bag.price)})`;
    let msg = `Hi Venessa! I'd like to enquire about the *${bag.name}*${pricePart} on ThriftLux.`;
    if (bag.reel || bag.instagramUrl) msg += `\nReel: ${bag.reel || bag.instagramUrl}`;
    const imgUrl = absImageUrl(bag.image);
    if (imgUrl) msg += `\n\n${imgUrl}`; // absolute URL on its own line for the WA preview card
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  }

  // ----- Filter / sort / search pipeline -----
  function visibleBags() {
    let out = bags.slice();
    if (currentFilter === 'sold') out = out.filter(b => b.sold);
    else if (currentFilter === 'available') out = out.filter(b => !b.sold);
    else if (currentFilter === 'sale') out = out.filter(b => isOnSale(b));
    if (currentCategory !== 'all') out = out.filter(b => (b.category || '') === currentCategory);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      out = out.filter(b =>
        (b.name || '').toLowerCase().includes(q)
        || (b.description || '').toLowerCase().includes(q)
        || (b.category || '').toLowerCase().includes(q)
      );
    }
    switch (currentSort) {
      case 'newest':
        out.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        break;
      case 'price-asc': out.sort((a, b) => effectivePrice(a) - effectivePrice(b)); break;
      case 'price-desc': out.sort((a, b) => effectivePrice(b) - effectivePrice(a)); break;
      // 'featured' = original order
    }
    return out;
  }

  // Build category pills from data
  function renderCategoryPills() {
    const container = document.getElementById('catPills');
    if (!container) return;
    const cats = [...new Set(bags.map(b => b.category).filter(Boolean))].sort();
    if (!cats.length) { container.innerHTML = ''; return; }
    container.innerHTML =
      `<button class="pill ${currentCategory === 'all' ? 'active' : ''}" data-cat="all">All categories</button>` +
      cats.map(c => `<button class="pill ${currentCategory === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
    container.querySelectorAll('.pill').forEach(p => {
      p.addEventListener('click', () => {
        currentCategory = p.dataset.cat;
        render();
      });
    });
  }

  function render() {
    const filtered = visibleBags();

    // Track zero-result searches (the killer feature: search-gaps as stock intel)
    if (searchQuery && !filtered.length) track('searchNoResults', searchQuery.toLowerCase().trim());

    // Refresh filter pills state
    document.querySelectorAll('.filter-pills--availability .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.filter === currentFilter);
    });
    document.querySelectorAll('.filter-pills--cats .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.cat === currentCategory);
    });

    const availableCount = bags.filter(b => !b.sold).length;
    if (filterMeta) {
      filterMeta.textContent = filtered.length === bags.length
        ? `${bags.length} ${bags.length === 1 ? 'bag' : 'bags'} · ${availableCount} available`
        : `${filtered.length} of ${bags.length} ${bags.length === 1 ? 'bag' : 'bags'}`;
    }

    if (!filtered.length) {
      gallery.innerHTML = `
        <p style="grid-column:1/-1;padding:40px 20px;text-align:center;color:var(--ink-faint);font-size:15px;">
          No bags match${searchQuery ? ` "${escapeHtml(searchQuery)}"` : ' these filters'}. Try a different keyword or clear filters.
        </p>`;
      return;
    }

    gallery.innerHTML = filtered.map(bag => {
      const igUrl = bag.instagramUrl || bag.reel || '';
      let priceLine;
      if (isOnSale(bag)) {
        priceLine = `<span class="card-price-was">${fmtPrice(bag.price)}</span>`
          + `<span class="card-price card-price-sale">${fmtPrice(bag.salePrice)}</span>`
          + `<span class="price-off">-${discountPct(bag)}%</span>`;
      } else if (bag.price > 0) {
        priceLine = `<span class="card-price">${fmtPrice(bag.price)}</span>`;
      } else {
        priceLine = `<span class="card-price"><small style="font-style:italic;font-weight:400;">Price on request</small></span>`;
      }
      const enquireLabel = bag.sold
        ? 'Sold out'
        : `<svg class="wa-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg> Enquire`;
      return `
      <article class="card ${bag.sold ? 'sold' : ''}">
        <div class="card-img-wrap" data-action="zoom" data-id="${bag.id}">
          <img class="card-img" src="${bag.image}?${IMG_VERSION}" alt="${escapeHtml(bag.name)}" loading="lazy">
          ${bag.sold ? '<span class="badge-sold">Sold</span>' : ''}
          ${isOnSale(bag) ? '<span class="badge-sale">SALE</span>' : ''}
          ${!bag.sold && !isOnSale(bag) && isNew(bag) ? '<span class="badge-new">NEW</span>' : ''}
          <button type="button" class="like-pill ${getLikedSet().has(bag.id) ? 'liked' : ''}" data-action="like" data-id="${bag.id}" aria-label="Like this bag">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 21s-7.5-4.5-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.5 1.2 4.5 3 1-1.8 2.5-3 4.5-3C20 4 23 7.5 21.5 11.5 19.5 16.5 12 21 12 21z"/></svg>
          <span class="like-count">${bagLikeCount(bag.id)}</span>
          </button>
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(bag.name)}</h3>
          <p class="card-desc">${escapeHtml(bag.description || '')}</p>
          <div class="card-price-row">${priceLine}</div>
          <div class="card-actions">
            <a class="btn-card primary" href="${whatsappLink(bag)}" target="_blank" rel="noopener" data-action="enquire" data-id="${bag.id}" ${bag.sold ? 'aria-disabled="true"' : ''}>
              ${enquireLabel}
            </a>
            ${igUrl
              ? `<a class="btn-card" href="${escapeHtml(igUrl)}" target="_blank" rel="noopener" data-action="ig-click" data-id="${bag.id}">
                  <svg class="ig-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>
                  View on IG
                </a>`
              : '<span class="btn-card" style="opacity:0.4;cursor:default;">No reel</span>'}
          </div>
        </div>
      </article>
    `;}).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ----- Wire filter pills -----
  document.querySelectorAll('.filter-pills--availability .pill').forEach(p => {
    p.addEventListener('click', () => { currentFilter = p.dataset.filter; render(); });
  });

  // ----- Wire search -----
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let searchTimer;
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      const v = e.target.value;
      if (searchClear) searchClear.hidden = !v;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchQuery = v.trim(); render(); }, 180);
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.hidden = true;
      searchQuery = '';
      render();
      searchInput.focus();
    });
  }

  // ----- Wire sort -----
  const sortSelect = document.getElementById('sortSelect');
  if (sortSelect) sortSelect.addEventListener('change', () => { currentSort = sortSelect.value; render(); });

  // ----- Insights: track enquire + IG clicks via event delegation -----
  gallery.addEventListener('click', e => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const id = a.dataset.id;
    if (a.dataset.action === 'enquire') track('itemEnquiries', id);
    if (a.dataset.action === 'ig-click') track('itemIgClicks', id);
  });

  // ----- Like pill: tap to toggle (persists in localStorage) -----
  // Registered before the zoom handler so we can stopImmediatePropagation and
  // keep the lightbox from also firing when the user taps the heart inside the
  // card image wrap.
  gallery.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="like"]');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = btn.dataset.id;
    const liked = getLikedSet();
    if (liked.has(id)) {
      liked.delete(id);
      btn.classList.remove('liked');
    } else {
      liked.add(id);
      btn.classList.add('liked', 'pop');
      setTimeout(() => btn.classList.remove('pop'), 350);
    }
    saveLikedSet(liked);
    const countEl = btn.querySelector('.like-count');
    if (countEl) countEl.textContent = bagLikeCount(id);
  });

  // ----- Lightbox -----
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCap = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  gallery.addEventListener('click', e => {
    const wrap = e.target.closest('[data-action="zoom"]');
    if (!wrap) return;
    const id = wrap.dataset.id;
    const bag = bags.find(b => b.id === id);
    if (!bag) return;
    track('itemViews', id);
    lightboxImg.src = bag.image + '?' + IMG_VERSION;
    lightboxImg.alt = bag.name;
    const priceText = isOnSale(bag)
      ? `${fmtPrice(bag.salePrice)} (was ${fmtPrice(bag.price)})`
      : (bag.price > 0 ? fmtPrice(bag.price) : 'Price on request');
    lightboxCap.textContent = `${bag.name} · ${priceText}${bag.sold ? ' · SOLD' : isOnSale(bag) ? ' · ON SALE' : ''}`;
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  });
  function closeLightbox() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
  }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  // Mobile nav
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  navToggle?.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks?.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));

  document.getElementById('year').textContent = new Date().getFullYear();

  await loadData();
  renderCategoryPills();
  render();
})();
