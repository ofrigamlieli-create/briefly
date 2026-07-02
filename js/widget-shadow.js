window.KaniWidgetShadow = {
  create() {
    const hostEl = document.createElement('div');
    hostEl.id = 'kani-widget-host';
    hostEl.style.cssText = 'position:fixed;z-index:2147483647;display:none;';
    const shadowRoot = hostEl.attachShadow({ mode: 'closed' });
    return { hostEl, shadowRoot };
  },

  injectStyles(shadowRoot) {
    // Guard against an invalidated extension context (happens when the extension
    // is reloaded while this tab is still open). In that state chrome.runtime
    // is gone / getURL returns chrome-extension://invalid/, so skip the fetch
    // instead of emitting a failed network request. Also swallow any fetch
    // rejection so a transient failure never spams the page console.
    try {
      if (!chrome.runtime || !chrome.runtime.id) return Promise.resolve();
      const url = chrome.runtime.getURL('css/widget.css');
      if (!url || url.indexOf('invalid') !== -1) return Promise.resolve();
      return fetch(url)
        .then(r => r.text())
        .then(css => {
          const style = document.createElement('style');
          style.textContent = css;
          shadowRoot.appendChild(style);
        })
        .catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }
};
