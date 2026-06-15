// Prose vs. metadata classifier for the "Smart Brain" content-zone detector.
// Pure functions only — no DOM mutation, no listeners. Loaded before widget.js.
//
// Goal: tell real article/post prose apart from the non-prose chrome that sits
// right next to it in feeds (author bylines, timestamps, reaction labels,
// "Promoted"/"Sponsored", connection degrees). This is done by the SHAPE of the
// text, not the site's HTML — so it survives site redesigns and needs zero
// per-platform rules.
//
// Design rule: HIGH PRECISION. A line is only called metadata when it is short
// AND carries a strong structural signal of being chrome. A normal short
// sentence ("He scored in the final minute.") must never be dropped — that
// would be prose omission, which fails our quality bar just like content bleed.

(function () {
  // Build stamp — bump on every change so we can confirm the page is running the
  // latest content script (reloading the extension does NOT update already-open
  // tabs; the page must be refreshed). Open DevTools console and look for this.
  const KANI_BUILD = 'smart-brain-v2 · build 5';
  console.log('%c[Kani] ' + KANI_BUILD + ' loaded', 'color:#3d9da6;font-weight:600');
  window.KANI_BUILD = KANI_BUILD;

  // --- tunables -------------------------------------------------------------
  // Above this many words a line is almost certainly real prose, so we never
  // treat it as metadata regardless of punctuation/separators.
  const METADATA_MAX_WORDS = 12;

  // Middot / pipe separators feeds use to pack byline fields onto one line:
  // "Name · 1st · Title · 5d".
  const SEPARATORS = /[·•‧|│]/;

  // Relative timestamps: "5d", "3h", "2 weeks ago", "1mo", "Just now".
  const RELATIVE_TIME =
    /^\s*(just now|yesterday|today|edited)\s*$|(\b\d+\s?(s|m|h|d|w|mo|y|sec|secs|min|mins|hr|hrs|hour|hours|day|days|week|weeks|month|months|year|years)\b\s*(ago)?)/i;

  // Connection degree shown on professional feeds.
  const CONNECTION_DEGREE = /(^|[·•|\s])(1st|2nd|3rd)([·•|\s]|$)/i;

  // Standalone social/UI labels that are never article prose.
  const SOCIAL_LABEL =
    /^\s*(promoted|sponsored|premium|featured|follow|following|connect|connected|like|liked|comment|comments|repost|reposted|share|shared|send|save|saved|see more|see translation|show more|read more|sort by|suggested|recommended|trending|who'?s viewed|people also viewed)\b/i;

  // Pure engagement counts: "129", "1.2K", "28 comments", "5 reactions".
  const ENGAGEMENT_COUNT =
    /^\s*[\d.,]+\s?[km]?\b(\s*(likes?|reactions?|comments?|reposts?|shares?|views?|followers?|connections?))?\s*$/i;

  function words(text) {
    const t = (text || '').trim();
    if (!t) return [];
    return t.split(/\s+/);
  }

  // Does the text read like a real sentence? Multiple words AND ends in
  // sentence punctuation somewhere. Used as a strong "this IS prose" override.
  // A TRAILING ellipsis ("Builder | 15+ years…") is truncation, not a sentence
  // end, so strip it before judging — otherwise headlines look like prose.
  function hasSentenceShape(text) {
    const t = (text || '').trim().replace(/(\.{2,}|…)+\s*$/, '').trim();
    if (words(t).length < 5) return false;
    return /[.!?]["')\]]?\s*$/.test(t) || /[.!?]\s+[A-Z]/.test(t);
  }

  /**
   * True when `text` looks like feed/page chrome rather than article prose.
   * Conservative by construction — see the design rule at the top of the file.
   */
  function looksLikeMetadata(text) {
    const t = (text || '').trim();
    if (!t) return true;                       // empty/whitespace = not prose
    const w = words(t);

    // Long lines, or anything that reads like a real sentence, are prose.
    if (w.length > METADATA_MAX_WORDS) return false;
    if (hasSentenceShape(t)) return false;

    // Strong, high-precision metadata signals (only reached for short, non-
    // sentence lines).
    if (RELATIVE_TIME.test(t)) return true;
    if (CONNECTION_DEGREE.test(t)) return true;
    if (SOCIAL_LABEL.test(t)) return true;
    if (ENGAGEMENT_COUNT.test(t)) return true;

    // Separator-packed byline / headline: "Name · Title · 5d",
    // "Builder | 15+ years of Dev + PM". Multiple fields joined by middots/pipes
    // with no sentence shape (already ruled out above) and a short total line is
    // chrome, not article prose. We don't require every field to be tiny —
    // professional headlines pack a long noun phrase into one field.
    if (SEPARATORS.test(t)) {
      const fields = t.split(SEPARATORS).map(s => s.trim()).filter(Boolean);
      if (fields.length >= 2) return true;
    }

    return false;
  }

  /** Convenience inverse: a usable prose line. */
  function isProse(text) {
    return !looksLikeMetadata(text);
  }

  window.KaniProse = { looksLikeMetadata, isProse, hasSentenceShape };
})();
