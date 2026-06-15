# Kani — Roadmap

> This file tracks what's been built, what's next, and what's deferred. Update after every completed feature. Read this at the start of any planning session (`/office-hours`, `/autoplan`).

---

## Current State (as of April 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| Manifest V3 setup | ✅ Working | v0.0.1, named "Kani" |
| Smart trigger (content zone detection) | ✅ Verified working | `js/selection-detector.js` + `js/selection-listener.js`. 20-word gate, DOM walk, link density <30%, dedup, fires `kani:selection-qualified`. Background service worker is empty placeholder. |
| Small widget + TLDR | ❌ Not started | — |
| Large widget + content expansion | ✅ Working | 肝 FAB → expand mode, zone + paragraph highlights, in-place TLDR replacement |
| Term Explorer | ❌ Not started | — |
| Visual Explainer (diagrams) | ❌ Not started | — |
| Settings & preferences | ❌ Not started | — |
| Supabase backend (Edge Functions) | ❌ Not started | — |
| Auth (Google sign-in) | ❌ Not started | — |
| Usage tracking | ❌ Not started | — |

---

## Build Order

Build strictly in this order. Do not start the next phase until the current one is complete, reviewed, and documented in `docs/prds/`.

### Phase 1 — Core TLDR (the product people will try)

**1.1 — Repo audit + smart trigger verification** ✅ Complete
Smart trigger verified working. See Current State table above and `CLAUDE.md` for full detail.

**1.2 — Small widget + TLDR generation**
Grammarly-style floating widget appears on text selection (20+ words in a content zone). Click widget → instant TLDR. Three styles: Short / Bullets / Simple. Regenerate button. Widget disappears on click-outside or new selection.

**1.3 — Supabase backend + auth**
Set up Supabase project. Edge Function for TLDR generation (receives text + auth token, calls Claude, returns summary). Google sign-in via Supabase Auth. Extension stores auth session only. API key server-side only — verify in DevTools.

**1.4 — Large widget + content zone expansion** ✅ Complete
肝 FAB on trigger enters expand mode. Full content zone highlighted in teal, paragraphs glow on hover. Click zone or paragraph → TLDR for that scope. Replaces in-place if widget already open.

**Done when Phase 1 is complete:** User can install extension, sign in, select text on any site, get a TLDR in 3 styles, expand to full content zone. Works on Twitter, LinkedIn, Reddit, news articles. No API key exposed.

---

### Phase 2 — Comprehension Layer (the thing that makes Kani different)

**2.1 — Term Explorer: auto-detection**
When a TLDR is generated, Claude also returns a list of professional/technical terms detected in the text. These are highlighted within the TLDR. Clicking a term shows a contextual explanation — what the term means in this specific text, not a dictionary definition. Explanation appears inline in the widget (tooltip or expandable section).

**2.2 — Term Explorer: user-triggered**
User can also manually select any term on the page or in the TLDR. Kani explains it in context. Same UX as auto-detected terms.

**2.3 — Visual Explainer: concept extraction + diagram rendering**
"Visualize" button available from any TLDR or term view. Opens a side panel or overlay. Claude extracts structured concept data (entities + relationships: causes, part-of, leads-to, contrasts-with). Frontend renders an interactive diagram using a JS library (D3, Mermaid, or React Flow — decide during planning). Claude picks the best diagram type (flowchart, mind map, timeline, comparison) or user can switch.

**Done when Phase 2 is complete:** User gets TLDR + highlighted terms + contextual explanations + visual diagrams. Kani is now a reading comprehension tool, not just a summarizer.

---

### Phase 3 — Settings, Polish, and Trial/Payment

**3.1 — Settings & preferences**
Default TLDR style. Site blocklist. Temporary disable (1 hour). Account management.

**3.2 — Usage tracking + trial logic**
Every request logged (user_id, timestamp, feature, word count). Free trial period (duration TBD). Trial expiry flow — what happens when trial ends.

**3.3 — Stripe integration**
Payment page. Subscription management. Upgrade/downgrade flow.

**Done when Phase 3 is complete:** Kani is a shippable product with auth, features, settings, trial, and payment. Ready for Chrome Web Store.

---

### Phase 4 — Platform Expansion (only if business validates)

**4.1 — Web app companion**
Same features, web interface instead of extension. Shares Supabase backend.

**4.2 — Mobile app (iOS / Android)**
Only if web app validates demand.

**4.3 — Desktop app (Mac / Windows)**
Only if mobile validates demand.

---

### Future Ideas (parked — not committed)

- **Image generation for diagrams** — DALL-E or similar, as an alternative to structured diagrams. Deferred because: adds a second AI model integration, slower, less interactive, not needed for v1. Revisit if users ask for more visual/creative representations.
- **Saved summaries / history** — let users save and revisit past TLDRs. Requires a dashboard or history view.
- **Share a TLDR** — generate a shareable link or image from a summary.
- **Multi-language support** — detect text language, summarize in same language or translate.
- **Team/workspace features** — shared summaries, team accounts. Only relevant if B2B signal emerges.

---

## How This Roadmap Is Used

- **`/office-hours`** reads this to assess whether a proposed feature fits the current priorities.
- **`/autoplan`** reads this to understand what's been built and what infrastructure exists.
- **After every completed feature:** update the Current State table, move the feature from "Not started" to "Complete," and save the feature's PRD to `docs/prds/<feature-name>.md`.
