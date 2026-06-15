// Selection qualification helpers for the "Smart trigger" feature.
// Pure functions only (no event listeners, no DOM mutation).

(function () {
  const WORD_MIN = 20;
  const WORD_MAX = 400;
  const HARD_EXCLUDED_SELECTOR =
    'header,footer,nav,aside,button,input,select,[role="navigation"],textarea,[role="textbox"]';

  function asElement(node) {
    if (!node) return null;
    if (node.nodeType === Node.ELEMENT_NODE) return node;
    return node.parentElement || null;
  }

  /**
   * Returns true when the provided node is inside a "hard excluded" UI region.
   * Used for complete-silence boundaries and content-zone rejection.
   */
  function isInHardExcludedUI(node) {
    const el = asElement(node);
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest(HARD_EXCLUDED_SELECTOR) || el.isContentEditable === true;
  }

  /**
   * Count words by splitting on whitespace.
   * - "Exactly 20 words" is inclusive and requires >= 20.
   */
  function countWords(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  /**
   * Safely read the current selection range for the main document frame.
   * Returns null when selection is empty or range cannot be read.
   */
  function getSelectionRange() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      return sel.getRangeAt(0) || null;
    } catch {
      return null;
    }
  }

  /**
   * Gate that enforces the 20+ word minimum for the selection.
   */
  function selectionWordCountGate(range) {
    if (!range) return false;
    const selectionText = range.toString();
    const count = countWords(selectionText);
    return count >= WORD_MIN && count <= WORD_MAX;
  }

  /**
   * Find the deepest ancestor element that qualifies as a "meaningful content zone"
   * for the given selection range.
   *
   * Heuristics (must all pass):
   * - both selection boundary nodes are inside the same candidate element
   * - candidate is not within hard excluded UI
   * - candidate has >= 20 words of text
   * - candidate has link/button density < 30% of all descendant elements
   */
  function findDeepestContentZone(range) {
    if (!range) return null;

    const startNode = range.startContainer;
    const endNode = range.endContainer;

    if (isInHardExcludedUI(startNode) || isInHardExcludedUI(endNode)) return null;

    const rawWords = countWords(range.toString());

    let candidate = asElement(startNode);
    if (!candidate) return null;

    while (candidate) {
      // Guard B: never use body/html as content zone.
      const tag = candidate.tagName?.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      const startInside = candidate.contains(startNode);
      const endInside = candidate.contains(endNode);

      if (startInside && endInside) {
        if (!isInHardExcludedUI(candidate)) {
          // Guard C: container must not be taller than 2.5× the viewport.
          const cRect = candidate.getBoundingClientRect();
          if (cRect.height > window.innerHeight * 2.5) {
            candidate = candidate.parentElement;
            continue;
          }

          const text = (candidate.innerText || candidate.textContent || "").trim();
          const wordCount = countWords(text);

          if (wordCount >= WORD_MIN) {
            // Guard D: selection must cover ≥ 10% of the container's text.
            if (rawWords / wordCount < 0.10) {
              candidate = candidate.parentElement;
              continue;
            }

            // Reject link lists / menus by the share of WORDS inside links,
            // not the count of link elements — so link-rich prose (e.g. a
            // Wikipedia intro) still qualifies while nav menus don't.
            // Only count <a> tags, not buttons — action bars (Like/Comment/
            // Repost/Send) would otherwise inflate the count and block social feeds.
            let linkWords = 0;
            candidate.querySelectorAll("a").forEach((el) => {
              linkWords += countWords(el.innerText || el.textContent || "");
            });
            if (linkWords / wordCount < 0.30) return candidate;
          }
        }
      }

      candidate = candidate.parentElement;
    }

    return null;
  }

  /**
   * Returns true when the selection range visually spans over a block media
   * element (img, video, figure). Clones range contents so it never touches
   * the live DOM.
   */
  function selectionSpansMedia(range) {
    if (!range) return false;
    try {
      const fragment = range.cloneContents();
      return !!fragment.querySelector('img, video, figure');
    } catch {
      return false;
    }
  }

  // Expose helpers to `selection-listener.js` (loaded after this file).
  window.KaniSelectionDetector = {
    WORD_MIN,
    WORD_MAX,
    HARD_EXCLUDED_SELECTOR,
    asElement,
    isInHardExcludedUI,
    countWords,
    getSelectionRange,
    selectionWordCountGate,
    selectionSpansMedia,
    findDeepestContentZone
  };
})();

