(function () {
  const WIDGET_WIDTH = 320;
  const WIDGET_HEIGHT = 230;
  const GAP = 8;

  const SIZE_MAP = { small: {w:280,h:190}, medium: {w:320,h:230}, large: {w:400,h:300} };

  let state = 'IDLE'; // 'IDLE' | 'TRIGGER' | 'EXPAND' | 'TLDR' | 'SIGNIN' | 'SETTINGS'
  let currentTab = 'short';
  let currentSize = 'medium';
  let currentCustomSize = {w:320, h:230};
  let currentMode = null; // null | 'tldr' | 'terms' | 'diagram'
  let currentAnalysisText = null;
  let storedSelectionText = '';
  let isRegenerating = false;
  let selectionRect = null;
  let tldrCache = null;

  let triggerHostEl = null;
  let triggerShadow = null;
  let tldrHostEl = null;
  let tldrShadow = null;
  let expandOverlayContainer = null;
  let expandOverlayItems = []; // { overlay, el } for scroll repositioning
  let expandScrollHandler = null;

  // ── Storage helpers ──────────────────────────────────────────

  function loadPrefs() {
    return new Promise(resolve => {
      const fallback = { style: 'short', size: 'medium', customSize: {w:320,h:230}, blocklist: [], snoozeUntil: 0 };
      if (!chrome || !chrome.storage) { resolve(fallback); return; }
      chrome.storage.sync.get(['kani_default_style', 'kani_default_size', 'kani_custom_size', 'kani_blocklist'], sync => {
        chrome.storage.local.get(['kani_snooze_until'], local => {
          resolve({
            style: sync.kani_default_style || 'short',
            size: sync.kani_default_size || 'medium',
            customSize: sync.kani_custom_size || {w:320, h:230},
            blocklist: sync.kani_blocklist || [],
            snoozeUntil: local.kani_snooze_until || 0
          });
        });
      });
    });
  }

  function hasStorage() { return !!(chrome && chrome.storage); }

  function saveDefaultStyle(style) {
    if (!hasStorage()) return;
    chrome.storage.sync.set({ kani_default_style: style });
  }

  function saveDefaultSize(size) {
    if (!hasStorage()) return;
    chrome.storage.sync.set({ kani_default_size: size });
  }

  function saveCustomSize(w, h) {
    if (!hasStorage()) return;
    chrome.storage.sync.set({ kani_custom_size: {w, h}, kani_default_size: 'custom' });
  }

  function getWidgetDimensions() {
    if (currentSize === 'custom') return currentCustomSize;
    return SIZE_MAP[currentSize] || SIZE_MAP.medium;
  }

  function saveBlocklist(blocklist) {
    if (!hasStorage()) return;
    chrome.storage.sync.set({ kani_blocklist: blocklist });
  }

  function saveSnooze() {
    if (!hasStorage()) return;
    chrome.storage.local.set({ kani_snooze_until: Date.now() + 3600000 });
  }

  function saveTldrToStorage(text, style) {
    if (!hasStorage()) return;
    chrome.storage.local.get(['kani_saved_tldrs'], result => {
      const saved = result.kani_saved_tldrs || [];
      saved.unshift({ text, style, url: location.href, date: Date.now() });
      chrome.storage.local.set({ kani_saved_tldrs: saved });
    });
  }

  // ── Dismiss listeners ────────────────────────────────────────

  function onDocMousedown(e) {
    const inTrigger = triggerHostEl && triggerHostEl.contains(e.target);
    const inTldr = tldrHostEl && tldrHostEl.contains(e.target);
    if (!inTrigger && !inTldr) dismiss();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') dismiss();
  }

  function registerDismissListeners() {
    document.addEventListener('mousedown', onDocMousedown, true);
    document.addEventListener('keydown', onDocKeydown, true);
  }

  function unregisterDismissListeners() {
    document.removeEventListener('mousedown', onDocMousedown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
  }

  // ── Scroll dismiss ───────────────────────────────────────────

  function onScrollDismiss() {
    if (state === 'TRIGGER') dismiss();
  }

  function registerScrollDismiss() {
    window.addEventListener('scroll', onScrollDismiss, { capture: true, passive: true });
  }

  function unregisterScrollDismiss() {
    window.removeEventListener('scroll', onScrollDismiss, { capture: true });
  }

  // ── Positioning ──────────────────────────────────────────────

  function positionTrigger(rect) {
    const vw = window.innerWidth;
    const height = Math.min(Math.max(rect.height, 24), window.innerHeight * 0.4);

    triggerHostEl.style.top = rect.top + 'px';
    triggerHostEl.style.left = rect.left + 'px';
    triggerHostEl.style.width = rect.width + 'px';
    triggerHostEl.style.height = height + 'px';

    const rail = triggerShadow.querySelector('.kani-rail');
    if (rail) rail.style.left = (rect.left < 22 ? 0 : -14) + 'px';

    const fab = triggerShadow.querySelector('.kani-fab');
    if (fab) fab.style.right = ((rect.right + 50) > vw ? 0 : -50) + 'px';
  }

  function positionTldr(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + GAP;
    let left = rect.left;

    if (rect.bottom + GAP + WIDGET_HEIGHT > vh) top = rect.top - GAP - WIDGET_HEIGHT;
    if (top < GAP) top = GAP;
    if (left + WIDGET_WIDTH > vw) left = vw - WIDGET_WIDTH - GAP;
    if (left < GAP) left = GAP;

    tldrHostEl.style.top = top + 'px';
    tldrHostEl.style.left = left + 'px';
  }

  // ── HTML templates ───────────────────────────────────────────

  function triggerHTML() {
    return `
      <div class="kani-trigger-container">
        <button class="kani-rail" id="kani-rail-btn" aria-label="Summarize selection"></button>
        <button class="kani-fab" id="kani-fab-btn" aria-label="Explore content zone">肝</button>
      </div>
    `;
  }

  function contentHTML(tab) {
    if (!tldrCache) return '<span class="kani-spinner"></span>';
    if (tab === 'bullets') {
      const items = tldrCache.bullets.map(b => `<li>${b}</li>`).join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${tldrCache[tab]}</p>`;
  }

  const ICON_TLDR    = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/></svg>`;
  const ICON_TERMS   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
  const ICON_DIAGRAM = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
  const ICON_REGEN   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-5.93"/></svg>`;
  const ICON_SAVE    = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
  const ICON_SETTINGS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.5" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.5" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2.5" fill="currentColor" stroke="none"/></svg>`;

  function widgetHTML(mode, tab) {
    const tldrActive    = mode === 'tldr';
    const termsActive   = mode === 'terms';
    const diagramActive = mode === 'diagram';

    const bodyHTML = tldrActive
      ? contentHTML(tab)
      : termsActive
        ? '<p class="kani-placeholder">Terms Explorer — coming soon</p>'
        : diagramActive
          ? '<p class="kani-placeholder">Visual Explainer — coming soon</p>'
          : '<p class="kani-placeholder">Choose an analysis above</p>';

    return `
      <div class="kani-widget" role="dialog" aria-label="Kani">
        <div class="kani-header">
          <div class="kani-header-brand">
            <span class="kani-logo">Kani</span>
            <span class="kani-kanji">肝</span>
          </div>
          <button class="kani-close-btn" id="kani-close-btn" aria-label="Close">×</button>
        </div>
        <div class="kani-modes">
          <button class="kani-mode-btn ${tldrActive ? 'active' : ''}" id="kani-mode-tldr" aria-label="TLDR">${ICON_TLDR}</button>
          <button class="kani-mode-btn ${termsActive ? 'active' : ''}" id="kani-mode-terms" aria-label="Terms">${ICON_TERMS}</button>
          <button class="kani-mode-btn ${diagramActive ? 'active' : ''}" id="kani-mode-diagram" aria-label="Diagram">${ICON_DIAGRAM}</button>
        </div>
        <div class="kani-tabs" id="kani-subtabs" style="${tldrActive ? '' : 'display:none'}">
          <div class="kani-tab ${tab === 'short' ? 'active' : ''}" data-tab="short">Short</div>
          <div class="kani-tab ${tab === 'bullets' ? 'active' : ''}" data-tab="bullets">Bullets</div>
          <div class="kani-tab ${tab === 'simple' ? 'active' : ''}" data-tab="simple">Simple</div>
        </div>
        <div class="kani-content" id="kani-content">${bodyHTML}</div>
        <div class="kani-footer" id="kani-footer" style="${tldrActive ? '' : 'display:none'}">
          <button class="kani-icon-btn" id="kani-regen-btn" aria-label="Regenerate">${ICON_REGEN}</button>
          <button class="kani-icon-btn" id="kani-save-btn" aria-label="Save">${ICON_SAVE}</button>
          <button class="kani-icon-btn" id="kani-settings-btn" aria-label="Settings">${ICON_SETTINGS}</button>
        </div>
        <div class="kani-resize-handle" id="kani-resize-handle"></div>
      </div>
    `;
  }

  function signInHTML() {
    return `
      <div class="kani-widget" role="dialog">
        <div class="kani-header">
          <div class="kani-header-brand">
            <span class="kani-logo">Kani</span>
            <span class="kani-kanji">肝</span>
          </div>
          <button class="kani-close-btn" id="kani-close-btn">×</button>
        </div>
        <div class="kani-content" style="text-align:center; padding: 20px 16px; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <p style="margin-bottom:12px; font-size:13px; color:#555; font-weight:400">Sign in to get your TLDR</p>
          <button class="kani-google-btn" id="kani-signin-btn">Sign in with Google</button>
        </div>
      </div>
    `;
  }

  function settingsHTML(prefs) {
    const isBlocked = prefs.blocklist.includes(location.hostname);
    return `
      <div class="kani-widget" role="dialog" aria-label="Kani Settings">
        <div class="kani-header">
          <button class="kani-back-btn" id="kani-back-btn" aria-label="Back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="kani-settings-title">Settings</span>
          <button class="kani-close-btn" id="kani-close-btn" aria-label="Close">×</button>
        </div>
        <div class="kani-settings-body">
          <div class="kani-setting-row">
            <span class="kani-setting-label">Default style</span>
            <div class="kani-style-picker">
              <button class="kani-style-opt ${prefs.style === 'short' ? 'active' : ''}" data-style="short">Short</button>
              <button class="kani-style-opt ${prefs.style === 'bullets' ? 'active' : ''}" data-style="bullets">Bullets</button>
              <button class="kani-style-opt ${prefs.style === 'simple' ? 'active' : ''}" data-style="simple">Simple</button>
            </div>
          </div>
          <div class="kani-setting-row">
            <span class="kani-setting-label">Default size</span>
            <div class="kani-style-picker">
              <button class="kani-style-opt ${prefs.size === 'small' ? 'active' : ''}" data-size="small">S</button>
              <button class="kani-style-opt ${(prefs.size === 'medium' || !prefs.size) ? 'active' : ''}" data-size="medium">M</button>
              <button class="kani-style-opt ${prefs.size === 'large' ? 'active' : ''}" data-size="large">L</button>
              <button class="kani-style-opt ${prefs.size === 'custom' ? 'active' : ''}" data-size="custom">Custom</button>
            </div>
            <div class="kani-custom-size-row" id="kani-custom-size-row" style="display:${prefs.size === 'custom' ? 'flex' : 'none'}">
              <input type="number" class="kani-size-input" id="kani-custom-w" value="${prefs.customSize.w}" min="280" max="800">
              <span class="kani-size-sep">×</span>
              <input type="number" class="kani-size-input" id="kani-custom-h" value="${prefs.customSize.h}" min="160" max="600">
              <span class="kani-size-sep">px</span>
            </div>
          </div>
          <div class="kani-setting-row kani-setting-row--split">
            <div>
              <span class="kani-setting-label">Disable on this site</span>
              <span class="kani-setting-desc">${location.hostname}</span>
            </div>
            <button class="kani-toggle ${isBlocked ? 'active' : ''}" id="kani-site-toggle" aria-label="Toggle site"></button>
          </div>
          <div class="kani-setting-row">
            <button class="kani-snooze-btn" id="kani-snooze-btn">Snooze for 1 hour</button>
          </div>
        </div>
        <div class="kani-resize-handle" id="kani-resize-handle"></div>
      </div>
    `;
  }

  // ── Shadow DOM helpers ───────────────────────────────────────

  function clearShadow(shadow) {
    Array.from(shadow.children).forEach(c => { if (c.tagName !== 'STYLE') c.remove(); });
  }

  function renderIntoShadow(shadow, html) {
    clearShadow(shadow);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    Array.from(wrapper.children).forEach(el => shadow.appendChild(el));
  }

  // ── TLDR content ─────────────────────────────────────────────

  function renderContent(tab) {
    const el = tldrShadow.getElementById('kani-content');
    if (el) el.innerHTML = contentHTML(tab);
  }

  function requestTldr(explicitText) {
    const text = explicitText != null
      ? explicitText
      : (window.getSelection() ? window.getSelection().toString().trim() : '');
    chrome.runtime.sendMessage({ type: 'GET_TLDR', text }, result => {
      if (result.error === 'AUTH_REQUIRED') { showSignIn(); return; }
      if (result.error) { showError(); return; }
      tldrCache = result.data;
      renderContent(currentTab);
      const btn = tldrShadow.getElementById('kani-regen-btn');
      if (btn) btn.disabled = false;
      isRegenerating = false;
    });
  }

  function showError() {
    const el = tldrShadow.getElementById('kani-content');
    if (el) el.innerHTML = '<p style="color:#e57373;font-size:12px">Something went wrong. Try again.</p>';
    isRegenerating = false;
    const btn = tldrShadow.getElementById('kani-regen-btn');
    if (btn) btn.disabled = false;
  }

  function startRegen() {
    if (isRegenerating) return;
    isRegenerating = true;
    tldrCache = null;
    const btn = tldrShadow.getElementById('kani-regen-btn');
    const content = tldrShadow.getElementById('kani-content');
    if (btn) btn.disabled = true;
    if (content) content.innerHTML = '<span class="kani-spinner"></span>';
    requestTldr(currentAnalysisText);
  }

  const CHECK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  function saveTldr() {
    const contentEl = tldrShadow.getElementById('kani-content');
    const text = contentEl ? contentEl.innerText : '';
    saveTldrToStorage(text, currentTab);

    const saveBtn = tldrShadow.getElementById('kani-save-btn');
    if (!saveBtn) return;
    saveBtn.innerHTML = CHECK_ICON;
    saveBtn.style.color = '#3d9da6';
    setTimeout(() => {
      saveBtn.innerHTML = ICON_SAVE;
      saveBtn.style.color = '';
    }, 1500);
  }

  // ── Drag + Resize ────────────────────────────────────────────

  function makeDraggable(headerEl) {
    headerEl.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const startX = e.clientX - tldrHostEl.offsetLeft;
      const startY = e.clientY - tldrHostEl.offsetTop;
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const vw = window.innerWidth, vh = window.innerHeight;
        let left = e.clientX - startX;
        let top  = e.clientY - startY;
        left = Math.max(0, Math.min(left, vw - 60));
        top  = Math.max(0, Math.min(top,  vh - 40));
        tldrHostEl.style.left = left + 'px';
        tldrHostEl.style.top  = top  + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function makeResizable(handleEl, widgetEl) {
    handleEl.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = widgetEl.offsetWidth;
      const startH = widgetEl.offsetHeight;
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const newW = Math.max(280, startW + (e.clientX - startX));
        const newH = Math.max(160, startH + (e.clientY - startY));
        widgetEl.style.width  = newW + 'px';
        widgetEl.style.height = newH + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Expand overlays ──────────────────────────────────────────

  function removeExpandOverlays() {
    if (expandOverlayContainer) {
      expandOverlayContainer.remove();
      expandOverlayContainer = null;
    }
    expandOverlayItems = [];
    if (expandScrollHandler) {
      window.removeEventListener('scroll', expandScrollHandler, true);
      expandScrollHandler = null;
    }
  }

  function updateExpandOverlayPositions() {
    expandOverlayItems.forEach(({ overlay, getBounds }) => {
      const r = getBounds();
      if (!r || r.height === 0) return;
      overlay.style.top    = r.top    + 'px';
      overlay.style.left   = r.left   + 'px';
      overlay.style.width  = r.width  + 'px';
      overlay.style.height = r.height + 'px';
    });
  }

  function findScrollableContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      if (/auto|scroll/.test(s.overflowY) || /auto|scroll/.test(s.overflow)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function getUnionRect(rectList) {
    const rects = Array.from(rectList).filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const top    = Math.min(...rects.map(r => r.top));
    const left   = Math.min(...rects.map(r => r.left));
    const bottom = Math.max(...rects.map(r => r.bottom));
    const right  = Math.max(...rects.map(r => r.right));
    return { top, left, width: right - left, height: bottom - top };
  }

  // Split a leaf element into paragraph chunks at <br><br> boundaries.
  // Returns [{text, range}] or null if no double-breaks found.
  function splitByDoubleBreaks(leafEl) {
    const brs = Array.from(leafEl.querySelectorAll('br'));
    const boundaries = [];
    for (let i = 0; i < brs.length - 1; i++) {
      let node = brs[i].nextSibling;
      while (node && node !== brs[i + 1] && node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
        node = node.nextSibling;
      }
      if (node === brs[i + 1]) { boundaries.push([brs[i], brs[i + 1]]); i++; }
    }
    if (!boundaries.length) return null;

    const MIN = 3;
    const chunks = [];
    const tryAdd = (makeRange) => {
      try {
        const r = makeRange();
        const text = r.toString().trim();
        if (text.split(/\s+/).length >= MIN) chunks.push({ text, range: r });
      } catch (_) {}
    };

    tryAdd(() => {
      const r = document.createRange();
      r.setStart(leafEl, 0); r.setEndBefore(boundaries[0][0]); return r;
    });
    for (let i = 0; i < boundaries.length - 1; i++) {
      tryAdd(() => {
        const r = document.createRange();
        r.setStartAfter(boundaries[i][1]); r.setEndBefore(boundaries[i + 1][0]); return r;
      });
    }
    tryAdd(() => {
      const r = document.createRange();
      r.setStartAfter(boundaries[boundaries.length - 1][1]);
      r.setEnd(leafEl, leafEl.childNodes.length); return r;
    });

    return chunks.length >= 2 ? chunks : null;
  }

  // Returns [{el?, range?, text, getBounds}]
  function findParagraphs(zoneEl) {
    const MIN = 3;
    const hasWords = (el) => (el.innerText || el.textContent || '').trim().split(/\s+/).length >= MIN;

    // 1. Semantic block elements — treat entire lists as one unit
    const semantic = Array.from(zoneEl.querySelectorAll('p, ul, ol, blockquote')).filter(hasWords);
    if (semantic.length >= 2) {
      return semantic.map(el => ({ el, text: el.innerText || '', getBounds: () => el.getBoundingClientRect() }));
    }

    // 2. Walk DOM for leaf blocks, then try to split each by <br><br>
    const BLOCK = new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','LI','H1','H2','H3','H4','H5','H6']);
    const leafEls = [];
    function walk(el, depth) {
      if (depth > 10 || !hasWords(el)) return;
      const blockKids = Array.from(el.children).filter(c => BLOCK.has(c.tagName) && hasWords(c));
      if (blockKids.length === 0) leafEls.push(el);
      else blockKids.forEach(c => walk(c, depth + 1));
    }
    Array.from(zoneEl.children).forEach(c => walk(c, 0));
    const deduped = leafEls.filter((el, i) => !leafEls.some((o, j) => i !== j && el.contains(o)));

    const result = [];
    for (const el of deduped) {
      const brChunks = splitByDoubleBreaks(el);
      if (brChunks) {
        brChunks.forEach(({ text, range }) => {
          result.push({ range, text, getBounds: () => getUnionRect(range.getClientRects()) });
        });
      } else {
        result.push({ el, text: el.innerText || '', getBounds: () => el.getBoundingClientRect() });
      }
    }
    if (result.length >= 1) return result;

    // 3. Fallback: direct children
    return Array.from(zoneEl.children).filter(hasWords).map(el => ({
      el, text: el.innerText || '', getBounds: () => el.getBoundingClientRect()
    }));
  }

  function createExpandOverlay(rect, isZone, scrollContainer, onClick) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      'border-radius:3px',
      'box-sizing:border-box',
      'transition:background 0.12s',
      `top:${rect.top}px`,
      `left:${rect.left}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      isZone
        ? 'pointer-events:all;cursor:pointer;background:transparent;border:2px solid rgba(61,157,166,0.45);z-index:2147483640;'
        : 'pointer-events:all;cursor:pointer;background:rgba(32,120,90,0.22);border:1px solid rgba(32,120,90,0.40);z-index:2147483641;'
    ].join(';');

    if (isZone) {
      el.addEventListener('mouseenter', () => { el.style.borderColor = 'rgba(61,157,166,0.75)'; });
      el.addEventListener('mouseleave', () => { el.style.borderColor = 'rgba(61,157,166,0.45)'; });
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    } else {
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(32,120,90,0.38)';
        el.style.borderColor = 'rgba(32,120,90,0.65)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'rgba(32,120,90,0.22)';
        el.style.borderColor = 'rgba(32,120,90,0.40)';
      });
      el.addEventListener('wheel', (e) => {
        if (scrollContainer) {
          scrollContainer.scrollTop += e.deltaY;
          scrollContainer.scrollLeft += e.deltaX;
        } else {
          window.scrollBy(e.deltaX, e.deltaY);
        }
      }, { passive: true });
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    }

    return el;
  }

  function showExpand() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const detector = window.KaniSelectionDetector;
    const zoneEl = detector ? detector.findDeepestContentZone(range) : null;
    if (!zoneEl) return;

    state = 'EXPAND';
    triggerHostEl.style.display = 'none';
    unregisterScrollDismiss();

    removeExpandOverlays();
    expandOverlayContainer = document.createElement('div');
    expandOverlayContainer.style.cssText = 'position:static;pointer-events:none;';
    document.body.appendChild(expandOverlayContainer);

    const scrollContainer = findScrollableContainer(zoneEl);

    const zoneRect = zoneEl.getBoundingClientRect();
    const zoneText = zoneEl.innerText || zoneEl.textContent || '';
    const zoneOverlay = createExpandOverlay(zoneRect, true, scrollContainer, () => {
      removeExpandOverlays();
      showPicker(zoneText, zoneEl.getBoundingClientRect());
    });
    expandOverlayContainer.appendChild(zoneOverlay);
    expandOverlayItems.push({ overlay: zoneOverlay, getBounds: () => zoneEl.getBoundingClientRect() });

    const paragraphs = findParagraphs(zoneEl);
    paragraphs.forEach(({ text, getBounds }) => {
      const pRect = getBounds();
      if (!pRect || pRect.height === 0 || pRect.width === 0) return;
      if (!text.trim()) return;
      const pOverlay = createExpandOverlay(pRect, false, scrollContainer, () => {
        removeExpandOverlays();
        showPicker(text, getBounds());
      });
      expandOverlayContainer.appendChild(pOverlay);
      expandOverlayItems.push({ overlay: pOverlay, getBounds });
    });

    expandScrollHandler = () => updateExpandOverlayPositions();
    window.addEventListener('scroll', expandScrollHandler, { capture: true, passive: true });

    registerDismissListeners();
  }

  // ── State transitions ────────────────────────────────────────

  function showTrigger(rect) {
    state = 'TRIGGER';
    renderIntoShadow(triggerShadow, triggerHTML());
    positionTrigger(rect);
    triggerHostEl.style.display = 'block';

    triggerShadow.getElementById('kani-rail-btn').addEventListener('click', () => showPicker(storedSelectionText));
    triggerShadow.getElementById('kani-fab-btn').addEventListener('click', showExpand);

    registerScrollDismiss();
    registerDismissListeners();
  }

  function showPicker(text, positionRect) {
    currentAnalysisText = text;
    currentMode = null;
    tldrCache = null;
    state = 'TLDR';
    if (positionRect) selectionRect = positionRect;

    unregisterScrollDismiss();
    triggerHostEl.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }, ({ isSignedIn }) => {
      if (!isSignedIn) { showSignIn(); return; }
      renderWidget(null, currentTab);
    });
  }

  function selectMode(mode) {
    currentMode = mode;
    tldrShadow.querySelectorAll('.kani-mode-btn').forEach(b => b.classList.remove('active'));
    const btn = tldrShadow.getElementById('kani-mode-' + mode);
    if (btn) btn.classList.add('active');

    const subtabs = tldrShadow.getElementById('kani-subtabs');
    const footer   = tldrShadow.getElementById('kani-footer');
    const content  = tldrShadow.getElementById('kani-content');

    if (mode === 'tldr') {
      if (subtabs) subtabs.style.display = '';
      if (footer)  footer.style.display  = '';
      if (content) content.innerHTML = '<span class="kani-spinner"></span>';

      tldrShadow.getElementById('kani-regen-btn').addEventListener('click', startRegen);
      tldrShadow.getElementById('kani-save-btn').addEventListener('click', saveTldr);
      tldrShadow.getElementById('kani-settings-btn').addEventListener('click', showSettings);
      tldrShadow.querySelectorAll('.kani-tab').forEach(tab => {
        tab.addEventListener('click', function () {
          currentTab = this.dataset.tab;
          tldrShadow.querySelectorAll('.kani-tab').forEach(t => t.classList.remove('active'));
          this.classList.add('active');
          renderContent(currentTab);
        });
      });

      requestTldr(currentAnalysisText);
    } else {
      if (subtabs) subtabs.style.display = 'none';
      if (footer)  footer.style.display  = 'none';
      const label = mode === 'terms' ? 'Terms Explorer' : 'Visual Explainer';
      if (content) content.innerHTML = `<p class="kani-placeholder">${label} — coming soon</p>`;
    }
  }

  function renderWidget(mode, tab) {
    renderIntoShadow(tldrShadow, widgetHTML(mode, tab));
    positionTldr(selectionRect);
    tldrHostEl.style.display = 'block';
    const sz = getWidgetDimensions();
    const widgetEl = tldrShadow.querySelector('.kani-widget');
    widgetEl.style.width  = sz.w + 'px';
    widgetEl.style.height = sz.h + 'px';

    tldrShadow.getElementById('kani-close-btn').addEventListener('click', dismiss);
    tldrShadow.getElementById('kani-mode-tldr').addEventListener('click', () => selectMode('tldr'));
    tldrShadow.getElementById('kani-mode-terms').addEventListener('click', () => selectMode('terms'));
    tldrShadow.getElementById('kani-mode-diagram').addEventListener('click', () => selectMode('diagram'));

    if (mode === 'tldr') {
      tldrShadow.getElementById('kani-regen-btn').addEventListener('click', startRegen);
      tldrShadow.getElementById('kani-save-btn').addEventListener('click', saveTldr);
      tldrShadow.getElementById('kani-settings-btn').addEventListener('click', showSettings);
      tldrShadow.querySelectorAll('.kani-tab').forEach(tab => {
        tab.addEventListener('click', function () {
          currentTab = this.dataset.tab;
          tldrShadow.querySelectorAll('.kani-tab').forEach(t => t.classList.remove('active'));
          this.classList.add('active');
          renderContent(currentTab);
        });
      });
    }

    makeDraggable(tldrShadow.querySelector('.kani-header'));
    makeResizable(tldrShadow.getElementById('kani-resize-handle'), tldrShadow.querySelector('.kani-widget'));
  }

  function showSignIn() {
    state = 'SIGNIN';
    renderIntoShadow(tldrShadow, signInHTML());
    positionTldr(selectionRect);
    tldrHostEl.style.display = 'block';

    tldrShadow.getElementById('kani-close-btn').addEventListener('click', dismiss);
    tldrShadow.getElementById('kani-signin-btn').addEventListener('click', () => {
      const btn = tldrShadow.getElementById('kani-signin-btn');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      chrome.runtime.sendMessage({ type: 'SIGN_IN' }, result => {
        if (result.error) {
          btn.disabled = false;
          btn.textContent = 'Sign in with Google';
          return;
        }
        tldrCache = null;
        renderWidget(null, currentTab);
      });
    });
  }

  function showSettings() {
    state = 'SETTINGS';
    loadPrefs().then(prefs => {
      renderIntoShadow(tldrShadow, settingsHTML(prefs));

      tldrShadow.getElementById('kani-back-btn').addEventListener('click', () => {
        renderWidget('tldr', currentTab);
        if (!tldrCache) requestTldr(currentAnalysisText);
      });
      tldrShadow.getElementById('kani-close-btn').addEventListener('click', dismiss);

      tldrShadow.querySelectorAll('.kani-style-opt[data-style]').forEach(btn => {
        btn.addEventListener('click', function () {
          const style = this.dataset.style;
          currentTab = style;
          saveDefaultStyle(style);
          tldrShadow.querySelectorAll('.kani-style-opt[data-style]').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
        });
      });

      const customRow = tldrShadow.getElementById('kani-custom-size-row');
      const widgetEl  = tldrShadow.querySelector('.kani-widget');

      tldrShadow.querySelectorAll('.kani-style-opt[data-size]').forEach(btn => {
        btn.addEventListener('click', function () {
          const size = this.dataset.size;
          currentSize = size;
          tldrShadow.querySelectorAll('.kani-style-opt[data-size]').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          customRow.style.display = size === 'custom' ? 'flex' : 'none';
          if (size !== 'custom') {
            saveDefaultSize(size);
            const sz = SIZE_MAP[size];
            widgetEl.style.width  = sz.w + 'px';
            widgetEl.style.height = sz.h + 'px';
          }
        });
      });

      function applyCustom() {
        const w = Math.min(800, Math.max(280, parseInt(tldrShadow.getElementById('kani-custom-w').value) || 320));
        const h = Math.min(600, Math.max(160, parseInt(tldrShadow.getElementById('kani-custom-h').value) || 230));
        currentCustomSize = {w, h};
        widgetEl.style.width  = w + 'px';
        widgetEl.style.height = h + 'px';
        saveCustomSize(w, h);
      }
      tldrShadow.getElementById('kani-custom-w').addEventListener('input', applyCustom);
      tldrShadow.getElementById('kani-custom-h').addEventListener('input', applyCustom);

      const toggle = tldrShadow.getElementById('kani-site-toggle');
      toggle.addEventListener('click', function () {
        loadPrefs().then(p => {
          const host = location.hostname;
          let list = p.blocklist.slice();
          if (list.includes(host)) {
            list = list.filter(h => h !== host);
            this.classList.remove('active');
          } else {
            list.push(host);
            this.classList.add('active');
          }
          saveBlocklist(list);
        });
      });

      tldrShadow.getElementById('kani-snooze-btn').addEventListener('click', () => {
        saveSnooze();
        dismiss();
      });

      makeDraggable(tldrShadow.querySelector('.kani-header'));
      makeResizable(tldrShadow.getElementById('kani-resize-handle'), tldrShadow.querySelector('.kani-widget'));
    });
  }

  function dismiss() {
    state = 'IDLE';
    unregisterScrollDismiss();
    triggerHostEl.style.display = 'none';
    tldrHostEl.style.display = 'none';
    removeExpandOverlays();
    unregisterDismissListeners();
  }

  // ── Selection handler ────────────────────────────────────────

  function onQualifiedSelection() {
    loadPrefs().then(prefs => {
      if (prefs.snoozeUntil > Date.now()) return;
      if (prefs.blocklist.includes(location.hostname)) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      selectionRect = rect;
      storedSelectionText = sel.toString().trim();
      currentTab = prefs.style;
      currentSize = prefs.size || 'medium';
      currentCustomSize = prefs.customSize || {w:320, h:230};
      showTrigger(rect);
    });
  }

  // ── Init ─────────────────────────────────────────────────────

  function init() {
    if (!document.querySelector('link[data-kani-fonts]')) {
      const fontLink = document.createElement('link');
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;600&display=swap';
      fontLink.dataset.kaniFonts = 'true';
      document.head.appendChild(fontLink);
    }

    const trigger = window.KaniWidgetShadow.create();
    triggerHostEl = trigger.hostEl;
    triggerShadow = trigger.shadowRoot;
    triggerHostEl.style.cssText = 'position:fixed;overflow:visible;pointer-events:none;z-index:2147483647;display:none;';

    const tldr = window.KaniWidgetShadow.create();
    tldrHostEl = tldr.hostEl;
    tldrShadow = tldr.shadowRoot;

    Promise.all([
      window.KaniWidgetShadow.injectStyles(triggerShadow),
      window.KaniWidgetShadow.injectStyles(tldrShadow)
    ]).then(() => {
      document.body.appendChild(triggerHostEl);
      document.body.appendChild(tldrHostEl);
      document.addEventListener('kani:selection-qualified', onQualifiedSelection);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
