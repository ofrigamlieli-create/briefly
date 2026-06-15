(function () {
  const WIDGET_WIDTH = 320;
  const WIDGET_HEIGHT = 230;
  const GAP = 8;

  const SIZE_MAP = { small: {w:280,h:190}, medium: {w:320,h:230}, large: {w:400,h:300} };

  let state = 'IDLE'; // 'IDLE' | 'TRIGGER' | 'TLDR' | 'SIGNIN' | 'SETTINGS'
  let currentTab = 'short';
  let currentSize = 'medium';
  let currentCustomSize = {w:320, h:230};
  let isRegenerating = false;
  let selectionRect = null;
  let tldrCache = null;

  let triggerHostEl = null;
  let triggerShadow = null;
  let tldrHostEl = null;
  let tldrShadow = null;

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
        <button class="kani-fab" id="kani-fab-btn" aria-label="Explore content">要</button>
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

  function expandedHTML(tab) {
    return `
      <div class="kani-widget" role="dialog" aria-label="Kani TLDR">
        <div class="kani-header">
          <div class="kani-header-brand">
            <span class="kani-logo">Kani</span>
            <span class="kani-kanji">要</span>
            <span class="kani-tagline">The essential point</span>
          </div>
          <button class="kani-close-btn" id="kani-close-btn" aria-label="Close">×</button>
        </div>
        <div class="kani-tabs">
          <div class="kani-tab ${tab === 'short' ? 'active' : ''}" data-tab="short">Short</div>
          <div class="kani-tab ${tab === 'bullets' ? 'active' : ''}" data-tab="bullets">Bullets</div>
          <div class="kani-tab ${tab === 'simple' ? 'active' : ''}" data-tab="simple">Simple</div>
        </div>
        <div class="kani-content" id="kani-content">${contentHTML(tab)}</div>
        <div class="kani-footer">
          <button class="kani-icon-btn" id="kani-regen-btn" aria-label="Regenerate">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-5.93"/></svg>
          </button>
          <button class="kani-icon-btn" id="kani-save-btn" aria-label="Save">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          </button>
          <button class="kani-icon-btn" id="kani-settings-btn" aria-label="Settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.5" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.5" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2.5" fill="currentColor" stroke="none"/></svg>
          </button>
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
            <span class="kani-kanji">要</span>
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

  function requestTldr() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    chrome.runtime.sendMessage({ type: 'GET_TLDR', text }, result => {
      if (result.error === 'AUTH_REQUIRED') { showSignIn(); return; }
      if (result.error === 'TRIAL_EXHAUSTED') { showUpgrade(); return; }
      if (result.error === 'DAILY_LIMIT_REACHED') { showError('Daily limit reached. Resets tomorrow.'); return; }
      if (result.error === 'RATE_LIMITED') { showError('Slow down — too many requests.'); return; }
      if (result.error) { showError(); return; }
      tldrCache = result.data;
      renderContent(currentTab);
      const btn = tldrShadow.getElementById('kani-regen-btn');
      if (btn) btn.disabled = false;
      isRegenerating = false;
    });
  }

  function showError(msg) {
    const el = tldrShadow.getElementById('kani-content');
    const text = msg || 'Something went wrong. Try again.';
    if (el) el.innerHTML = `<p style="color:#e57373;font-size:12px">${text}</p>`;
    isRegenerating = false;
    const btn = tldrShadow.getElementById('kani-regen-btn');
    if (btn) btn.disabled = false;
  }

  function showUpgrade() {
    const el = tldrShadow.getElementById('kani-content');
    if (el) el.innerHTML = `
      <div style="text-align:center;padding:12px 8px">
        <p style="font-size:13px;margin:0 0 8px">You've used your free TLDRs.</p>
        <p style="font-size:12px;color:#888;margin:0 0 12px">Upgrade to keep reading smarter.</p>
        <button id="kani-upgrade-btn" style="background:#1a73e8;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;cursor:pointer">Upgrade — $5/mo</button>
      </div>`;
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
    requestTldr();
  }

  const SAVE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
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
      saveBtn.innerHTML = SAVE_ICON;
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

  // ── State transitions ────────────────────────────────────────

  function showTrigger(rect) {
    state = 'TRIGGER';
    renderIntoShadow(triggerShadow, triggerHTML());
    positionTrigger(rect);
    triggerHostEl.style.display = 'block';

    triggerShadow.getElementById('kani-rail-btn').addEventListener('click', showTldr);

    registerScrollDismiss();
    registerDismissListeners();
  }

  function showTldr() {
    state = 'TLDR';
    currentTab = currentTab || 'short';
    tldrCache = null;

    unregisterScrollDismiss();
    triggerHostEl.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATE' }, ({ isSignedIn }) => {
      if (!isSignedIn) { showSignIn(); return; }
      renderTldrWidget();
      requestTldr();
    });
  }

  function renderTldrWidget() {
    renderIntoShadow(tldrShadow, expandedHTML(currentTab));
    positionTldr(selectionRect);
    tldrHostEl.style.display = 'block';
    const sz = getWidgetDimensions();
    const widgetEl = tldrShadow.querySelector('.kani-widget');
    widgetEl.style.width  = sz.w + 'px';
    widgetEl.style.height = sz.h + 'px';

    tldrShadow.getElementById('kani-close-btn').addEventListener('click', dismiss);
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
        renderTldrWidget();
        requestTldr();
      });
    });
  }

  function showSettings() {
    state = 'SETTINGS';
    loadPrefs().then(prefs => {
      renderIntoShadow(tldrShadow, settingsHTML(prefs));

      tldrShadow.getElementById('kani-back-btn').addEventListener('click', () => {
        renderTldrWidget();
        if (tldrCache) renderContent(currentTab);
        else requestTldr();
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
