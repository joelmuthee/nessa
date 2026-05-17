// Nessa portfolio gallery - shared by makeup.html and styling.html.
// Reads data.json (static for v1; later this can flip to a worker /api/posts).

const PAGE_SIZE = 15;
const WA_NUMBER = '254705044940';

(async function () {
  const gallery = document.getElementById('gallery');
  const meta = document.getElementById('galleryMeta');
  const pagination = document.getElementById('pagination');
  const category = document.body.dataset.category; // 'makeup' or 'styling'
  let posts = [];
  let settings = {};
  let currentPage = 1;

  async function loadData() {
    try {
      const res = await fetch('data.json?_=' + Date.now());
      const json = await res.json();
      posts = json.posts || [];
      settings = json.settings || {};
    } catch (e) {
      console.error('Failed to load data.json', e);
      gallery.innerHTML = '<p style="grid-column:1/-1;color:var(--ink-faint);text-align:center;padding:40px;">Could not load the gallery. Please refresh.</p>';
    }
  }

  function filteredPosts() {
    // Show posts where category matches OR is "both"; never show "unclear"
    return posts.filter(p => p.category === category || p.category === 'both');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
    ));
  }

  function whatsappLink(post) {
    const lines = [
      `Hi Vanessa, I saw your ${category === 'makeup' ? 'makeup' : 'styling'} work on this post and wanted to enquire:`,
      `"${post.title}"`,
      post.instagramUrl,
    ];
    return `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
  }

  function igSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>';
  }
  function waSvg() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>';
  }

  function render() {
    const all = filteredPosts();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = all.slice(start, start + PAGE_SIZE);

    meta.textContent = `${all.length} ${all.length === 1 ? 'piece' : 'pieces'} of work` +
      (totalPages > 1 ? ` · page ${currentPage} of ${totalPages}` : '');

    if (!page.length) {
      gallery.innerHTML = '<p style="grid-column:1/-1;color:var(--ink-faint);text-align:center;padding:40px;">No posts yet in this category.</p>';
      pagination.innerHTML = '';
      return;
    }

    gallery.innerHTML = page.map(p => {
      const tagClass = p.category === 'both' ? 'both' : '';
      const tagLabel = p.category === 'both' ? 'Both' : (p.category === 'makeup' ? 'Makeup' : 'Styling');
      return `
      <article class="post-card" data-id="${p.id}" tabindex="0">
        <span class="post-tag ${tagClass}">${tagLabel}</span>
        <img class="post-img" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy">
        <div class="post-overlay">
          <h3 class="post-title">${escapeHtml(p.title)}</h3>
          <div class="post-actions">
            <a class="post-btn post-btn-ig" href="${escapeHtml(p.instagramUrl)}" target="_blank" rel="noopener" data-action="ig">${igSvg()} View on Instagram</a>
          </div>
        </div>
      </article>`;
    }).join('');

    renderPagination(totalPages);
    observeNewCards();
  }

  function renderPagination(totalPages) {
    if (totalPages <= 1) { pagination.innerHTML = ''; return; }
    const btns = [];
    btns.push(`<button class="page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>&larr;</button>`);
    const pageNums = paginationNums(currentPage, totalPages);
    for (const n of pageNums) {
      if (n === '...') btns.push('<span class="page-ellipsis">&hellip;</span>');
      else btns.push(`<button class="page-btn ${n === currentPage ? 'active' : ''}" data-page="${n}">${n}</button>`);
    }
    btns.push(`<button class="page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>&rarr;</button>`);
    pagination.innerHTML = btns.join('');
  }

  function paginationNums(cur, total) {
    if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
    const out = [1];
    if (cur > 3) out.push('...');
    for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) out.push(i);
    if (cur < total - 2) out.push('...');
    out.push(total);
    return out;
  }

  // ----- Wire pagination -----
  pagination.addEventListener('click', e => {
    const b = e.target.closest('.page-btn');
    if (!b || b.disabled) return;
    const n = Number(b.dataset.page);
    if (!Number.isFinite(n)) return;
    currentPage = Math.max(1, Math.min(n, Math.ceil(filteredPosts().length / PAGE_SIZE)));
    render();
    document.querySelector('.gallery-section').scrollIntoView({behavior: 'smooth', block: 'start'});
  });

  // ----- Lightbox -----
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxCap = document.getElementById('lightboxCaption');
  const lightboxClose = document.getElementById('lightboxClose');

  gallery.addEventListener('click', e => {
    // Don't fire lightbox when the click was on a button/link
    if (e.target.closest('a, button')) return;
    const card = e.target.closest('.post-card');
    if (!card) return;
    const post = posts.find(p => p.id === card.dataset.id);
    if (!post) return;
    lightboxImg.src = post.image;
    lightboxImg.alt = post.title;
    lightboxCap.textContent = post.title;
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
  });
  function closeLightbox() {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    lightboxImg.src = '';
  }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox(); });

  // ----- Fade-in-up reveal on scroll (CATALOG-STANDARDS) -----
  let cardObserver = null;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    cardObserver = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); cardObserver.unobserve(e.target); } });
    }, {threshold: 0.12, rootMargin: '0px 0px -40px 0px'});
    document.querySelectorAll('.section-title, .about-grid > *, .footer-brand, .footer-links').forEach(el => cardObserver.observe(el));
  }
  function observeNewCards() {
    if (!cardObserver) return;
    document.querySelectorAll('.post-card:not(.in-view), .tile:not(.in-view)').forEach(el => cardObserver.observe(el));
  }

  await loadData();
  render();
})();
