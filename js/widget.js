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
    expandOverlayItems.forEach(({ overlay, getBounds }) => {
      let r = null;
      try { r = getBounds(); } catch (_) { r = null; }
      if (!r || r.height === 0) { overlay.style.display = 'none'; return; }
      // Fully above the clip line → hide entirely.
      if (r.bottom <= headerBottom) { overlay.style.display = 'none'; return; }
      overlay.style.display = 'block';
      overlay.style.top    = (r.top  + sy - expandContainerDocTop)  + 'px';
      overlay.style.left   = (r.left + sx - expandContainerDocLeft) + 'px';
      overlay.style.width  = r.width  + 'px';
      overlay.style.height = r.height + 'px';
      // Clip the slice that would render above the bar (measured from box top).
      const clipTop = Math.max(0, headerBottom - r.top);
      overlay.style.clipPath = clipTop > 0 ? `inset(${clipTop}px 0 0 0)` : 'none';
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
  function findParagraphs(zoneEl) {
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
          return { range, text: (el.innerText || '').trim(), getBounds: () => getUnionRect(range.getClientRects()) };
        });
      }
    }

    // 2. Visual-gap engine.
    const groups = groupByVisualGap(zoneEl);
    if (groups.length) return groups;

    // 3. Last resort: whole zone as one paragraph.
    const range = document.createRange();
    range.selectNodeContents(zoneEl);
    return [{ range, text: (zoneEl.innerText || '').trim(), getBounds: () => getUnionRect(range.getClientRects()) }];
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
  function groupByVisualGap(zoneEl) {
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

    // Drop chrome lines (author bylines, headlines, timestamps, reaction labels)
    // at the LINE level — before grouping — so they can never merge into an
    // adjacent prose paragraph and drag its box up over the header.
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

    // Fold single-line groups forward into the next multi-line group (or, if
    // trailing, back into the previous), so a lone line never stands alone —
    // BUT first drop single lines that are feed/page chrome (author bylines,
    // timestamps, reaction labels). Otherwise they fold into the first real
    // paragraph and drag the zone box up over the header (e.g. LinkedIn posts).
    const merged = [];
    let pending = [];
    for (const g of groups) {
      if (g.heading) continue;            // titles/subheads aren't summarizable paragraphs
      if (g.lines <= 1) {
        if (isMetadataLine(g)) continue;  // chrome, not prose → drop entirely
        pending = pending.concat(g.segs);
      } else {
        merged.push({ segs: pending.concat(g.segs) });
        pending = [];
      }
    }
    if (pending.length) {
      if (merged.length) merged[merged.length - 1].segs.push(...pending);
      else merged.push({ segs: pending });   // whole zone was single lines → one block
    }

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
      const getBounds = () => {
        const rects = [];
        for (const s of segs) {
          const r = document.createRange();
          r.setStart(s.node, s.start);
          r.setEnd(s.node, s.end);
          for (const rect of r.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
          }
        }
        return getUnionRect(rects);
      };
      result.push({ range: textRange, text, getBounds });
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

  function createExpandOverlay(rect, isZone, scrollContainer, onClick) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'border-radius:3px',
      'box-sizing:border-box',
      `top:${rect.top + window.scrollY - expandContainerDocTop}px`,
      `left:${rect.left + window.scrollX - expandContainerDocLeft}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      isZone
        ? 'pointer-events:all;cursor:pointer;background:rgba(46,160,110,0.10);border:2px solid rgba(46,160,110,0.45);z-index:2147483640;'
        : 'pointer-events:all;cursor:pointer;background:rgba(32,120,90,0.30);border:1px solid rgba(32,120,90,0.45);z-index:2147483641;'
    ].join(';');

    if (isZone) {
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(46,160,110,0.20)';
        el.style.borderColor = 'rgba(46,160,110,0.75)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'rgba(46,160,110,0.10)';
        el.style.borderColor = 'rgba(46,160,110,0.45)';
      });
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    } else {
      el.addEventListener('mouseenter', () => {
        el.style.background = 'rgba(32,120,90,0.50)';
        el.style.borderColor = 'rgba(32,120,90,0.70)';
      });
      el.addEventListener('mouseleave', () => {
        el.style.background = 'rgba(32,120,90,0.30)';
        el.style.borderColor = 'rgba(32,120,90,0.45)';
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
          return { range: r, text: (el.innerText || '').trim(), getBounds: () => getUnionRect(Array.from(r.getClientRects())) };
        });
      }
    }
    if (!paragraphs) paragraphs = findParagraphs(zoneEl);

    // Drop any paragraph whose box overlaps an embedded video/iframe (e.g. a
    // video's overlaid caption text on Goal). Text-node detection can't tell a
    // caption that floats on top of a video from real article prose, so reject
    // it geometrically by intersection with the media element's on-screen rect.
    paragraphs = rejectMediaOverlaps(paragraphs);

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
    const zoneRect = zoneBounds();
    if (zoneRect) {
      const zoneOverlay = createExpandOverlay(zoneRect, true, scrollContainer, () => {
        removeExpandOverlays();
        showPicker(zoneText, zoneBounds());
      });
      expandOverlayContainer.appendChild(zoneOverlay);
      expandOverlayItems.push({ overlay: zoneOverlay, getBounds: zoneBounds });
    }

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
