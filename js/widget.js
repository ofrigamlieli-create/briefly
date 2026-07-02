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
  let storedRange = null;
  let storedZoneEl = null;
  let isRegenerating = false;
  let selectionRect = null;
  let tldrCache = null;

  let triggerHostEl = null;
  let triggerShadow = null;
  let tldrHostEl = null;
  let tldrShadow = null;
  let expandOverlayContainer = null;
  let expandOverlayItems = []; // { overlay, getBounds } for per-frame repositioning
  let expandRafId = null;
  let expandContainerDocTop = 0;  // overlay container's fixed document-Y origin
  let expandContainerDocLeft = 0;
  let expandScrollContainer = null; // scrollable ancestor of the zone (null = window scroll)

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
    // Expand overlays live in expandOverlayContainer (appended to <body>, not
    // inside either shadow host). Without this guard, mousedown on a paragraph/
    // zone overlay dismisses everything before its click can fire showPicker.
    const inExpand = expandOverlayContainer && expandOverlayContainer.contains(e.target);
    if (!inTrigger && !inTldr && !inExpand) dismiss();
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
          <p id="kani-signin-err" style="margin-top:8px; font-size:11px; color:#e57373; min-height:16px;"></p>
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
    if (expandRafId) {
      cancelAnimationFrame(expandRafId);
      expandRafId = null;
    }
    if (expandOverlayContainer) {
      expandOverlayContainer.remove();
      expandOverlayContainer = null;
    }
    expandScrollContainer = null;
    expandOverlayItems = [];
  }

  // Overlays are position:absolute in DOCUMENT coordinates. For ordinary page
  // (window) scrolling the browser moves them natively in lockstep with the text
  // — zero lag — because document-Y (rect.top + scrollY) stays constant, so the
  // per-frame write is a no-op and native scrolling does the work. The rAF loop
  // only does real work for inner-panel scroll, where scrollY doesn't change.
  // Find the bottom edge (viewport px) of any fixed/sticky bar pinned to the top
  // of the page — e.g. LinkedIn's nav (Home/My Network/Jobs/Messaging). Overlay
  // boxes must be clipped below this line so they never paint over that bar as
  // the text they mark scrolls up underneath it. Universal: no per-site code.
  function getTopOcclusionBottom() {
    const w = window.innerWidth;
    const maxBar = window.innerHeight * 0.4; // ignore tall overlays/modals
    const minW = w * 0.25;                    // wide enough to be a bar, not a button
    let bottom = 0;

    const consider = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.id === 'kani-widget-host' || node.id === 'kani-expand-overlay-root') return;
      let cs;
      try { cs = getComputedStyle(node); } catch (_) { return; }
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const r = node.getBoundingClientRect();
      // A real top bar: anchored at the top, wide, short.
      if (r.top <= 1 && r.width >= minW && r.bottom > bottom && r.bottom < maxBar) {
        bottom = r.bottom;
      }
    };

    // Source A — standard top-of-page landmarks. Catches LinkedIn's <header>
    // global nav, which the point-sampling below can miss.
    let landmarks;
    try { landmarks = document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]'); }
    catch (_) { landmarks = []; }
    landmarks.forEach(consider);

    // Source B — point-sampling + ancestor climb. Catches in-column sticky
    // headers (e.g. Twitter's "Post" bar) that aren't header/nav landmarks.
    const xs = [w * 0.2, w * 0.5, w * 0.8];
    for (const x of xs) {
      let els;
      try { els = document.elementsFromPoint(x, 2); } catch (_) { continue; }
      for (const el of els) {
        let node = el, hops = 0;
        while (node && node.nodeType === 1 && hops < 25) {
          consider(node);
          node = node.parentElement;
          hops++;
        }
      }
    }
    return bottom;
  }

  // Top edge (viewport px) above which overlays must be clipped: the greater of
  // any pinned/sticky header bottom and the top of the scroll container holding
  // the text. On LinkedIn the text scrolls inside <main> (top ≈ 52) under a
  // static nav, so the scroll-container top is what clips the green off the nav.
  function getOverlayClipLine() {
    let line = getTopOcclusionBottom();
    if (expandScrollContainer) {
      try {
        const t = expandScrollContainer.getBoundingClientRect().top;
        if (t > line) line = t;
      } catch (_) {}
    }
    return line;
  }

  function updateExpandOverlayPositions() {
    const sx = window.scrollX, sy = window.scrollY;
    const headerBottom = getOverlayClipLine();
    expandOverlayItems.forEach((item) => {
      // Chip — keeps its intrinsic size; only its position follows the prose,
      // anchored just below the last marked paragraph.
      if (item.isChip) {
        let r = null;
        try { r = item.getBounds(); } catch (_) { r = null; }
        if (!r || !r.height || (r.top + r.height) <= headerBottom) { item.overlay.style.display = 'none'; return; }
        item.overlay.style.display = 'flex';
        item.overlay.style.top  = (r.top + r.height + sy - expandContainerDocTop + 8) + 'px';
        item.overlay.style.left = (r.left + sx - expandContainerDocLeft) + 'px';
        return;
      }
      // Paragraph — recompute its line rects once, then place each line div so
      // the marks track the text as it scrolls (and never paint the gaps).
      let rects = [];
      try { rects = item.getRects() || []; } catch (_) { rects = []; }
      item.overlays.forEach((ov, i) => {
        const r = rects[i];
        if (!r || r.height === 0 || r.bottom <= headerBottom) { ov.style.display = 'none'; return; }
        ov.style.display = 'block';
        ov.style.top    = (r.top  + sy - expandContainerDocTop)  + 'px';
        ov.style.left   = (r.left + sx - expandContainerDocLeft) + 'px';
        ov.style.width  = r.width  + 'px';
        ov.style.height = r.height + 'px';
        const clipTop = Math.max(0, headerBottom - r.top);
        ov.style.clipPath = clipTop > 0 ? `inset(${clipTop}px 0 0 0)` : 'none';
      });
    });
  }

  function startExpandSyncLoop() {
    const tick = () => {
      try { updateExpandOverlayPositions(); } catch (_) { /* keep the loop alive */ }
      expandRafId = requestAnimationFrame(tick);
    };
    expandRafId = requestAnimationFrame(tick);
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

  // getClientRects() returns one rect per inline fragment (text run, link, <b>…),
  // so link-dense lines get stacked overlapping marks that render darker than the
  // rest. Merge every fragment on the same visual line into one spanning rect.
  function mergeLineRects(rects) {
    const sorted = Array.from(rects)
      .filter(r => r.width > 0 && r.height > 0)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const lines = [];
    let lastRaw = null;
    for (const r of sorted) {
      const line = lines[lines.length - 1];
      // Same line = vertical center overlaps the PREVIOUS RAW rect's own band
      // (not the accumulated merged box — else tightly-spaced lines with no
      // paragraph gap chain-merge into one giant block, since a growing merged
      // bottom keeps swallowing the next line too).
      const sameLine = line && lastRaw &&
        (r.top + r.height / 2) < lastRaw.bottom && (r.bottom - r.height / 2) > lastRaw.top;
      if (sameLine) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      lastRaw = r;
    }
    return lines.map(l => ({
      left: l.left, top: l.top, right: l.right, bottom: l.bottom,
      width: l.right - l.left, height: l.bottom - l.top
    }));
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

  const PARA_MIN_WORDS = 3;
  const GAP_FACTOR = 0.75;        // blank vertical gap (× line height) that starts a new paragraph
  const INDENT_FACTOR = 1.5;      // left-edge jump (× line height) that starts a new paragraph
  const wordCount = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
  const isHeadingEl = (el) => !!el && /^H[1-6]$/.test(el.tagName || '');

  // Reject embedded-media blocks so paragraph boxes never land on a video or
  // iframe. Conservative on purpose — only real media tags, never class/id
  // substring guesses (those wrongly flag normal article/feed markup).
  const AD_MEDIA_SELECTOR = 'iframe,video';
  function isAdOrMedia(el) {
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest(AD_MEDIA_SELECTOR)) return true;
    return !!el.querySelector('video, iframe');
  }

  // A video player / embed marks a section boundary — but an AD does not. Ads
  // sit between the standfirst and the body (e.g. Goal), so cutting on them would
  // drop the intro; real video players (Goal's trailing clip) should cut so the
  // zone never spans the player. Matched by explicit player class, never "ad".
  const VIDEO_BOUNDARY_SELECTOR =
    'video,[class*="video-player"],[class*="videoPlayer"],[data-testid*="video-player"]';
  function isSectionBoundary(el) {
    if (isHeadingEl(el)) return true;
    try { return typeof el.matches === 'function' && el.matches(VIDEO_BOUNDARY_SELECTOR); }
    catch (_) { return false; }
  }

  // When zoneEl is a single <p>, find the ancestor container whose section
  // (the run of paragraphs around pEl, bounded by headings and video players)
  // yields the MOST qualifying <p> elements. Climbing to the widest such section
  // captures siblings that live in separate sub-containers — e.g. Goal wraps the
  // standfirst and the article body in different divs, so stopping at the body
  // alone would miss the intro. Returns [] if no section has ≥ 2 paragraphs.
  function getSectionSiblings(pEl) {
    function getParasInSection(container) {
      // Collect headings, video players, and <p> elements in document order.
      const items = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          const tag = el.tagName?.toLowerCase();
          if (tag === 'p' || isSectionBoundary(el)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      });
      let node;
      while ((node = walker.nextNode())) items.push(node);

      const idx = items.indexOf(pEl);
      if (idx === -1) return null;

      let start = 0;
      for (let i = idx - 1; i >= 0; i--) {
        if (isSectionBoundary(items[i])) { start = i + 1; break; }
      }
      let end = items.length;
      for (let i = idx + 1; i < items.length; i++) {
        if (isSectionBoundary(items[i])) { end = i; break; }
      }

      return items.slice(start, end).filter(c =>
        c.tagName?.toLowerCase() === 'p' && wordCount(c.innerText) >= PARA_MIN_WORDS && !isAdOrMedia(c) &&
        (!window.KaniProse || !window.KaniProse.looksLikeMetadata(c.innerText))
      );
    }

    let best = [];
    let candidate = pEl.parentElement;
    while (candidate && !['body', 'html'].includes(candidate.tagName?.toLowerCase())) {
      const ps = getParasInSection(candidate);
      if (ps && ps.length > best.length) best = ps;
      candidate = candidate.parentElement;
    }
    return best.length >= 2 ? best : [];
  }

  // Universal, render-based paragraph detection.
  // Reads what's actually drawn on screen (per-line rects) instead of trusting
  // <p> tags or <br> patterns, so it works on articles AND social feeds.
  // Returns [{ range, text, getBounds }].
  function findParagraphs(zoneEl, anchorTop) {
    const zoneWords = wordCount(zoneEl.innerText || zoneEl.textContent);

    // 1. Semantic fast-path — only when clean elements cover most of the zone.
    const notMetadata = (el) => !window.KaniProse || !window.KaniProse.looksLikeMetadata(el.innerText);
    const semantic = collectSemanticBlocks(zoneEl).filter(el => wordCount(el.innerText) >= PARA_MIN_WORDS && !isAdOrMedia(el) && notMetadata(el));
    if (semantic.length >= 2) {
      const covered = semantic.reduce((sum, el) => sum + wordCount(el.innerText), 0);
      if (zoneWords > 0 && covered / zoneWords >= 0.70) {
        return semantic.map(el => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return {
            range, text: (el.innerText || '').trim(),
            getRects: () => mergeLineRects(range.getClientRects()),
            getBounds: () => getUnionRect(range.getClientRects())
          };
        });
      }
    }

    // 2. Visual-gap engine.
    const groups = groupByVisualGap(zoneEl, anchorTop);
    if (groups.length) return groups;

    // 3. Last resort: whole zone as one paragraph.
    const range = document.createRange();
    range.selectNodeContents(zoneEl);
    return [{
      range, text: (zoneEl.innerText || '').trim(),
      getRects: () => mergeLineRects(range.getClientRects()),
      getBounds: () => getUnionRect(range.getClientRects())
    }];
  }

  // p / blockquote plus top-level lists (a list is one block).
  function collectSemanticBlocks(zoneEl) {
    const lists = Array.from(zoneEl.querySelectorAll('ul, ol'))
      .filter(l => !l.parentElement.closest('ul, ol'));
    const blocks = Array.from(zoneEl.querySelectorAll('p, blockquote'))
      .filter(b => !lists.some(l => l.contains(b)));
    const all = blocks.concat(lists);
    all.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return all;
  }

  // Walk visible text, break it into "segments" (a run of text between
  // newlines — this is what splits tweets that pack a whole post into one
  // node with \n line breaks), then cut a new paragraph at a blank vertical
  // gap, a left-indent jump, or a heading. Finally fold lone single lines
  // into a neighbour so we never draw a box around one bare line.
  function groupByVisualGap(zoneEl, anchorTop) {
    const excludeSel = (window.KaniSelectionDetector && window.KaniSelectionDetector.HARD_EXCLUDED_SELECTOR) ||
      'header,footer,nav,aside,button,input,select,textarea';
    const walker = document.createTreeWalker(zoneEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || p.closest(excludeSel) || p.closest('a') || p.closest(AD_MEDIA_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const segs = [];
    const allLineHeights = [];
    let n;
    while ((n = walker.nextNode())) {
      const txt = n.textContent;
      const block = n.parentElement.closest('p,div,section,article,blockquote,li,h1,h2,h3,h4,h5,h6') || n.parentElement;
      let start = 0;
      const flush = (end) => {
        if (txt.slice(start, end).trim()) {
          const range = document.createRange();
          range.setStart(n, start); range.setEnd(n, end);
          const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
          if (rects.length) {
            rects.forEach(r => allLineHeights.push(r.height));
            segs.push({
              node: n, start, end,
              top: Math.min(...rects.map(r => r.top)),
              bottom: Math.max(...rects.map(r => r.bottom)),
              left: Math.min(...rects.map(r => r.left)),
              lines: rects.length,
              block,
            });
          }
        }
        start = end + 1;
      };
      for (let i = 0; i < txt.length; i++) if (txt[i] === '\n') flush(i);
      flush(txt.length);
    }

    // Drop individual chrome lines (author bylines with a connection degree,
    // timestamps, engagement counts, "and N others") BEFORE grouping, using the
    // shared classifier. Without this, a chrome line flush against the body gets
    // swept into the body's block and — now that we draw per line — picks up a
    // highlighter mark. This only removes lines the classifier is confident about;
    // shapeless chrome (bios, "Voices worth following" headers) is left to the
    // group-level wall logic and the summary-time backstop. Headings stay so they
    // can still act as walls.
    if (window.KaniProse) {
      for (let i = segs.length - 1; i >= 0; i--) {
        const lineText = segs[i].node.textContent.slice(segs[i].start, segs[i].end);
        if (window.KaniProse.looksLikeMetadata(lineText)) segs.splice(i, 1);
      }
    }

    if (!segs.length) return [];

    const lineH = median(allLineHeights) || 16;
    segs.sort((a, b) => (a.top - b.top) || (a.left - b.left));

    // Gap-based grouping.
    const groups = [];
    let cur = null;
    for (const s of segs) {
      const heading = isHeadingEl(s.block);
      let cut = !cur;
      if (cur) {
        const gap = s.top - cur.bottom;
        if (gap > GAP_FACTOR * lineH) cut = true;
        else if (s.left - cur.left > INDENT_FACTOR * lineH) cut = true;
        else if (heading || cur.heading) cut = true;
      }
      if (cut) {
        cur = { segs: [s], bottom: s.bottom, left: s.left, lines: s.lines, heading };
        groups.push(cur);
      } else {
        cur.segs.push(s);
        cur.bottom = Math.max(cur.bottom, s.bottom);
        cur.left = Math.min(cur.left, s.left);
        cur.lines += s.lines;
      }
    }

    // Text of a group, for prose-vs-metadata classification.
    const groupText = (g) =>
      g.segs.map(s => s.node.textContent.slice(s.start, s.end)).join(' ').replace(/\s+/g, ' ').trim();
    const isMetadataLine = (g) =>
      window.KaniProse ? window.KaniProse.looksLikeMetadata(groupText(g)) : false;

    // --- Anchor-based contiguous prose run --------------------------------
    // Mark each group prose-vs-chrome, then grow OUT from the group nearest the
    // user's selection through touching prose groups only, stopping at the first
    // chrome/heading group or a large vertical gap (e.g. a removed action bar or
    // spacer). This keeps bylines/bios/timestamps above and reactions/comments
    // below OUT of the box without needing to perfectly classify every one of
    // them — a single chrome line between the body and the noise is wall enough.
    groups.forEach(g => {
      g.top = Math.min(...g.segs.map(s => s.top));
      g.isMeta = g.heading || isMetadataLine(g);
    });
    const BIG_GAP = 2.5 * lineH;
    let anchor = -1, best = Infinity;
    if (anchorTop != null) {
      groups.forEach((g, i) => {
        if (g.isMeta) return;
        const d = (anchorTop >= g.top && anchorTop <= g.bottom)
          ? 0 : Math.min(Math.abs(anchorTop - g.top), Math.abs(anchorTop - g.bottom));
        if (d < best) { best = d; anchor = i; }
      });
    }
    let lo, hi;
    if (anchor === -1) {                    // no usable anchor → keep all prose
      lo = 0; hi = groups.length - 1;
    } else {
      lo = hi = anchor;
      for (let i = anchor - 1; i >= 0; i--) {          // grow upward
        if (groups[i].isMeta) break;
        if (groups[i + 1].top - groups[i].bottom > BIG_GAP) break;
        lo = i;
      }
      for (let i = anchor + 1; i < groups.length; i++) { // grow downward
        if (groups[i].isMeta) break;
        if (groups[i].top - groups[i - 1].bottom > BIG_GAP) break;
        hi = i;
      }
    }
    const merged = groups.slice(lo, hi + 1)
      .filter(g => !g.isMeta && !g.heading)
      .map(g => ({ segs: g.segs }));

    // Build each paragraph from its own kept prose segments. Crucially, the box
    // is the union of the PER-SEGMENT rects (each confined to one line of prose),
    // NOT a range spanning first→last — a spanning range's getClientRects() would
    // also cover anything wedged between the lines (links, timestamps, action
    // bars, the next post), bleeding the box past the prose. Text still comes
    // from the full first→last range so wording reads naturally.
    const result = [];
    for (const g of merged) {
      const first = g.segs[0];
      const last = g.segs[g.segs.length - 1];
      const textRange = document.createRange();
      textRange.setStart(first.node, first.start);
      textRange.setEnd(last.node, last.end);
      const text = textRange.toString().trim();
      if (wordCount(text) < PARA_MIN_WORDS) continue;
      const segs = g.segs;
      const getRects = () => {
        const rects = [];
        for (const s of segs) {
          const r = document.createRange();
          r.setStart(s.node, s.start);
          r.setEnd(s.node, s.end);
          for (const rect of r.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
          }
        }
        return mergeLineRects(rects);
      };
      const getBounds = () => getUnionRect(getRects());
      result.push({ range: textRange, text, getRects, getBounds });
    }
    return result;
  }

  // Nearest common ancestor element shared by every paragraph's range.
  function commonAncestorOf(paragraphs) {
    let anc = null;
    for (const p of paragraphs) {
      let c = p.range && p.range.commonAncestorContainer;
      if (c && c.nodeType !== Node.ELEMENT_NODE) c = c.parentElement;
      if (!c) continue;
      if (!anc) { anc = c; continue; }
      while (anc && !anc.contains(c)) anc = anc.parentElement;
    }
    return anc;
  }

  // Reject paragraphs that geometrically overlap an embedded video/iframe.
  // Scoped to media INSIDE the content block only — scanning the whole document
  // would catch unrelated page iframes (ads, embeds, trackers) on sites like
  // LinkedIn/Goal and wrongly delete real paragraphs.
  function rejectMediaOverlaps(paragraphs) {
    const scope = commonAncestorOf(paragraphs);
    if (!scope) return paragraphs;
    const mediaRects = Array.from(scope.querySelectorAll('video, iframe'))
      .map(m => m.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0);
    if (!mediaRects.length) return paragraphs;
    const overlaps = (a, b) => {
      const ix = Math.max(0, Math.min(a.left + a.width, b.right) - Math.max(a.left, b.left));
      const iy = Math.max(0, Math.min(a.top + a.height, b.bottom) - Math.max(a.top, b.top));
      const inter = ix * iy;
      return inter > 0.35 * (a.width * a.height);
    };
    return paragraphs.filter(p => {
      const r = p.getBounds();
      if (!r || r.height === 0) return true;
      return !mediaRects.some(m => overlaps(r, m));
    });
  }

  function median(nums) {
    if (!nums.length) return 0;
    const s = nums.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // A per-paragraph "highlighter" mark. It hugs the prose lines (rect = union of
  // that paragraph's per-line rects), so it can NEVER paint over the gaps between
  // paragraphs — no more green over an ad, reaction bar, or the next post. There
  // is deliberately no big zone rectangle anymore; the whole-post action lives in
  // the chip below (createChip).
  function createExpandOverlay(rect, scrollContainer, onClick) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'border-radius:2px',
      'box-sizing:border-box',
      `top:${rect.top + window.scrollY - expandContainerDocTop}px`,
      `left:${rect.left + window.scrollX - expandContainerDocLeft}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'pointer-events:all;cursor:pointer;background:rgba(46,160,110,0.20);z-index:2147483641;'
    ].join(';');

    el.addEventListener('mouseenter', () => { el.style.background = 'rgba(46,160,110,0.34)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'rgba(46,160,110,0.20)'; });
    el.addEventListener('wheel', (e) => {
      if (scrollContainer) {
        scrollContainer.scrollTop += e.deltaY;
        scrollContainer.scrollLeft += e.deltaX;
      } else {
        window.scrollBy(e.deltaX, e.deltaY);
      }
    }, { passive: true });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });

    return el;
  }

  // The single "Summarize" chip — the one action affordance for the whole post,
  // replacing the old big clickable rectangle. The sync loop anchors it just
  // below the prose. Solid pill + own font so it reads on any page background.
  function createChip(count, onClick) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'pointer-events:all;cursor:pointer',
      'display:flex;align-items:center;gap:6px',
      'font:500 13px/1 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif',
      'color:#ffffff;background:#2ea06e',
      'padding:6px 12px;border-radius:999px',
      'box-shadow:0 1px 4px rgba(0,0,0,0.18)',
      'white-space:nowrap;z-index:2147483642;'
    ].join(';');
    el.textContent = count > 1 ? ('Summarize · ' + count + ' paragraphs') : 'Summarize';
    el.addEventListener('mouseenter', () => { el.style.background = '#278a5e'; });
    el.addEventListener('mouseleave', () => { el.style.background = '#2ea06e'; });
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return el;
  }

  function showExpand() {
    if (!storedRange || !storedZoneEl) return;

    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }, (res) => {
      if (!res || !res.isSignedIn) {
        unregisterScrollDismiss();
        triggerHostEl.style.display = 'none';
        showSignIn();
        return;
      }
      _doExpand(storedZoneEl);
    });
  }

  function _doExpand(zoneEl) {
    state = 'EXPAND';
    triggerHostEl.style.display = 'none';
    unregisterScrollDismiss();
    window.getSelection()?.removeAllRanges();

    removeExpandOverlays();
    expandOverlayContainer = document.createElement('div');
    expandOverlayContainer.id = 'kani-expand-overlay-root';
    expandOverlayContainer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;';
    document.body.appendChild(expandOverlayContainer);
    // Capture the container's document-relative origin once. Overlays are
    // absolute children of it, so this stays valid through native scrolling.
    const __co = expandOverlayContainer.getBoundingClientRect();
    expandContainerDocTop  = __co.top  + window.scrollY;
    expandContainerDocLeft = __co.left + window.scrollX;

    const scrollContainer = findScrollableContainer(zoneEl);
    expandScrollContainer = scrollContainer;

    // Expand to all <p> siblings in the same section (bounded by headings and
    // video players). Seed with a real <p> even when the zone is a wrapper div —
    // a multi-paragraph selection resolves the zone to the article-body div, but
    // the standfirst/intro lives in a sibling container above it, so seeding lets
    // the section walk climb high enough to include it (e.g. Goal, Wikipedia).
    // Vertical position of the user's selection — the anchor the prose run grows
    // out from, so the box is centred on what they actually selected.
    const __selRect = storedRange ? storedRange.getBoundingClientRect() : null;
    const anchorTop = __selRect && __selRect.height ? __selRect.top : null;

    let paragraphs;
    let seedP = null;
    if (zoneEl.tagName?.toLowerCase() === 'p') {
      seedP = zoneEl;
    } else {
      const startEl = storedRange
        ? (storedRange.startContainer.nodeType === 1 ? storedRange.startContainer : storedRange.startContainer.parentElement)
        : null;
      // Only seed from the <p> the selection actually starts in — never a random
      // <p> elsewhere in the zone (keeps <p>-less feeds like LinkedIn unaffected).
      seedP = startEl && startEl.closest ? startEl.closest('p') : null;
    }
    if (seedP) {
      const siblings = getSectionSiblings(seedP);
      if (siblings.length >= 2) {
        paragraphs = siblings.map(el => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return {
            range: r, text: (el.innerText || '').trim(),
            getRects: () => mergeLineRects(r.getClientRects()),
            getBounds: () => getUnionRect(Array.from(r.getClientRects()))
          };
        });
      }
    }
    if (!paragraphs) paragraphs = findParagraphs(zoneEl, anchorTop);

    // Drop any paragraph whose box overlaps an embedded video/iframe (e.g. a
    // video's overlaid caption text on Goal). Text-node detection can't tell a
    // caption that floats on top of a video from real article prose, so reject
    // it geometrically by intersection with the media element's on-screen rect.
    paragraphs = rejectMediaOverlaps(paragraphs);

    // Feed boundary: a content zone can span several stacked posts (the detector
    // climbs to a container holding 1–2 posts). Bound the result to the single
    // post the selection STARTED in by capping at its nearest semantic post
    // wrapper (<article>/[role="article"] — used by X, Reddit, Facebook, and
    // others for a self-contained post). Article pages have no such wrapper near
    // the selection, so this is a no-op there.
    const startNode = storedRange
      ? (storedRange.startContainer.nodeType === 1 ? storedRange.startContainer : storedRange.startContainer.parentElement)
      : null;
    let postEl = startNode && startNode.closest ? startNode.closest('article,[role="article"]') : null;
    // Feeds that don't use <article> mark each post as an ARIA list item
    // (LinkedIn: role="listitem" inside role="list"). Use the nearest one as the
    // boundary, but only when it's a sizeable card — so a small <li> bullet
    // inside an article's list doesn't shrink the zone to a single bullet.
    if (!postEl && startNode && startNode.closest) {
      const li = startNode.closest('[role="listitem"]');
      if (li && li.getBoundingClientRect().height >= window.innerHeight * 0.25) postEl = li;
    }
    if (postEl) {
      const within = (p) => {
        let c = p.range && p.range.commonAncestorContainer;
        if (c && c.nodeType !== Node.ELEMENT_NODE) c = c.parentElement;
        return !!c && postEl.contains(c);
      };
      const bounded = paragraphs.filter(within);
      if (bounded.length) paragraphs = bounded;

      // Within a social post, the Like/Comment/Repost/Send (or Reply/React) row
      // separates the post BODY from the reactions and comment thread below it.
      // Find that action row below the selection and drop any paragraph at/below
      // it, so the zone is the post body only — never the comments. This verb
      // set is near-universal across social platforms.
      const ACTION = /^(like|comment|repost|share|send|reply|react|upvote)$/i;
      const ARIA_ACTION = /^(like|comment|repost|share|send|reply|react|upvote)\b/i;
      const selTop = storedRange ? storedRange.getBoundingClientRect().top : -Infinity;
      let cutTop = Infinity;
      postEl.querySelectorAll('button,[role="button"]').forEach(b => {
        const label = (b.innerText || '').trim();
        const aria = (b.getAttribute('aria-label') || '').trim();
        if (ACTION.test(label) || ARIA_ACTION.test(aria)) {
          const r = b.getBoundingClientRect();
          if (r.height > 0 && r.top > selTop && r.top < cutTop) cutTop = r.top;
        }
      });
      if (cutTop !== Infinity) {
        const above = paragraphs.filter(p => { const bb = p.getBounds(); return bb && bb.top < cutTop - 4; });
        if (above.length) paragraphs = above;
      }

      // Header cut: a post's byline cluster — avatar, author name, bio,
      // "X likes this", "Visit my website" — sits either BESIDE the avatar
      // (indented to its right) or ABOVE it, while the body runs full-width
      // below. Find the post avatar (a small, roughly-square image at/above the
      // selection) and drop any paragraph above the selection that is indented
      // past the avatar or sits above it. No avatar (most article pages) → no
      // cut, so articles are untouched. Purely positional — no phrase matching.
      let avatar = null;
      postEl.querySelectorAll('img').forEach(im => {
        const r = im.getBoundingClientRect();
        if (r.width < 16 || r.width > 96 || r.height < 16 || r.height > 96) return;
        if (r.width / r.height < 0.6 || r.width / r.height > 1.7) return;   // square-ish = avatar
        if (r.top > selTop) return;                                          // header region only
        if (!avatar || r.bottom > avatar.bottom) avatar = r;                 // actor avatar nearest the body
      });
      if (avatar) {
        const bylineLeft = avatar.left + avatar.width - 2;
        const body = paragraphs.filter(p => {
          const bb = p.getBounds();
          if (!bb) return false;
          if (bb.top >= selTop - 2) return true;                            // never drop at/below the selection
          if (bb.left >= bylineLeft) return false;                          // indented beside avatar = byline field
          if (bb.top + bb.height <= avatar.top + 2) return false;           // sits above avatar = context header
          return true;
        });
        if (body.length) paragraphs = body;
      }
    }

    // Zone = the area hugging just the detected paragraphs (so title, media,
    // and tags fall outside), and its text = those paragraphs combined.
    // Uses the median of per-paragraph right edges so floated sidebars (e.g.
    // Wikipedia infobox) don't widen the zone, while text within the article
    // column isn't clipped (per-line median was too aggressive).
    const zoneBounds = () => {
      const pBounds = paragraphs.map(p => p.getBounds()).filter(Boolean);
      if (!pBounds.length) return null;
      const top    = Math.min(...pBounds.map(r => r.top));
      const left   = Math.min(...pBounds.map(r => r.left));
      const bottom = Math.max(...pBounds.map(r => r.top + r.height));
      const rights = pBounds.map(r => r.left + r.width).sort((a, b) => a - b);
      const right  = rights[Math.floor(rights.length / 2)];
      return { top, left, width: right - left, height: bottom - top };
    };
    const zoneText = paragraphs.map(p => p.text).join('\n\n') || zoneEl.innerText || '';

    // Highlighter marks, drawn ONE PER LINE rect (never the union bounding box)
    // so the green hugs the text and never fills the blank gaps between lines or
    // paragraphs. Each paragraph is one item holding its line divs; the sync loop
    // recomputes that paragraph's line rects once per frame. Click any line of a
    // paragraph → summarize that whole paragraph.
    const lineRectsOf = (p) =>
      (p.getRects ? p.getRects() : [p.getBounds()]).filter(r => r && r.width > 0 && r.height > 0);
    let drawn = 0;
    paragraphs.forEach((p) => {
      if (!p.text.trim()) return;
      const rects = lineRectsOf(p);
      if (!rects.length) return;
      const onClick = () => { removeExpandOverlays(); showPicker(p.text, p.getBounds()); };
      const overlays = rects.map((rect) => {
        const mark = createExpandOverlay(rect, scrollContainer, onClick);
        expandOverlayContainer.appendChild(mark);
        return mark;
      });
      expandOverlayItems.push({ overlays, getRects: () => lineRectsOf(p) });
      drawn++;
    });

    // One "Summarize" chip for the whole post — no big rectangle, so nothing is
    // ever drawn over the gaps. Anchored under the prose by the sync loop.
    if (drawn && zoneBounds()) {
      const chip = createChip(drawn, () => {
        removeExpandOverlays();
        showPicker(zoneText, zoneBounds());
      });
      expandOverlayContainer.appendChild(chip);
      expandOverlayItems.push({ overlay: chip, getBounds: zoneBounds, isChip: true });
    }

    startExpandSyncLoop();

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

    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }, (res) => {
      if (!res || !res.isSignedIn) { showSignIn(); return; }
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
      const errEl = tldrShadow.getElementById('kani-signin-err');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      if (errEl) errEl.textContent = '';
      chrome.runtime.sendMessage({ type: 'SIGN_IN' }, result => {
        if (!result || result.error) {
          btn.disabled = false;
          btn.textContent = 'Sign in with Google';
          if (errEl) errEl.textContent = result?.error || 'Could not connect. Try again.';
          return;
        }
        tldrCache = null;
        renderWidget('tldr', currentTab);
        requestTldr(currentAnalysisText);
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
      storedRange = sel.getRangeAt(0).cloneRange();
      const detector = window.KaniSelectionDetector;
      storedZoneEl = detector ? detector.findDeepestContentZone(storedRange) : null;
      currentTab = prefs.style;
      currentSize = prefs.size || 'medium';
      currentCustomSize = prefs.customSize || {w:320, h:230};
      showTrigger(rect);
    });
  }

  // ── Init ─────────────────────────────────────────────────────

  function init() {
    // Fonts: rely on the system font stack declared in widget.css. We do NOT
    // inject an external Google Fonts <link> — strict sites (LinkedIn, GitHub,
    // many news sites) block it via Content Security Policy, which logs a console
    // error, and loading it would ping Google from every page the user visits.
    // To restore the exact branded font later, bundle the woff2 locally and
    // @font-face it from a web_accessible_resource inside the shadow DOM.

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
