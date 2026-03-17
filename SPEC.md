# Polymarket APY Calculator — Extension Spec

## Overview

A Manifest V3 Chrome extension that adds APY calculations to Polymarket. On **event pages** it injects a floating popup calculator. On the **portfolio page** it inlines an APY badge next to each open position row. It fetches live data from Polymarket's public Gamma API and computes the true compounding annualised percentage yield (APY), letting users compare prediction market returns against traditional yield opportunities.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — declares content script, CSS, and host permissions |
| `content.js` | All extension logic, organised into five modules |
| `styles.css` | Scoped styles: `#apy-ext-container` for the popup; `.apy-portfolio-*` for portfolio badges |

No background service worker. No `chrome.storage`. State is in-memory (resets on navigation) except the portfolio badge toggle which uses `localStorage`.

---

## APY Formula

For a binary outcome share priced at **P** with **D** days to settlement:

```
ROI = (1 - P) / P
APY = (1 + ROI)^(365/D) - 1
```

Display rules:
- Rounded to 2 decimal places (e.g. `14.73%`)
- Capped at `>9,999%` for near-zero prices where the result would be astronomical
- Shows `∞` if mathematically infinite, `Settled` if D ≤ 0, `N/A` if price is invalid

---

## Modules (`content.js`)

### `MarketDataFetcher`
- Extracts the event slug from `window.location.pathname` (`/event/<slug>`)
- **`fetch()`** — fetches by the current page slug; falls back to DOM scraping on failure
- **`fetchBySlug(slug)`** — fetches by an arbitrary slug directly (no DOM fallback); used by `PortfolioInjector`
- Fetches from `https://gamma-api.polymarket.com/events?slug=<slug>`
- Parses per-market `outcomePrices`, `outcomes`, `endDate`, `closed`, and `question` fields
- **Date normalisation**: if all sub-markets share the same `endDate` as the event (within 1 day tolerance), or if the API `endDate` is already in the past, attempts to parse a more specific settlement date from the market's `question` text (e.g. `"by March 31"` → March 31 of the inferred year)
- Year inference for partial dates: uses the event's end year as reference; if that candidate is already past, tries the next year
- Falls back to DOM scraping if the API call fails or no slug is found

### `APYCalculator`
- `calculateAPY(price, daysToSettlement)` — returns APY as a decimal or `null`
- `formatAPY(value, daysToSettlement)` — formats for display with capping and edge cases
- `daysUntil(date)` — floor of calendar days from today to the target date

### `UIInjector`
Manages all DOM interaction for event pages. Maintains two pieces of in-memory state (both reset on SPA navigation):
- `savedPosition` — last drag coordinates of the popup `{ left, top }`
- `trashedMarkets` — `Set` of market question strings the user has dismissed

**Button injection** (`injectButton`):
- Tries a priority-ordered list of CSS selectors to find a suitable injection point near the buy/trade area
- Inserts a `<div id="apy-ext-container">` with a "Calculate APY" button after the matched element
- Guards against duplicate injection

**Results popup** (`renderResults`):
- Filters out sub-markets where `closed === true` (already resolved)
- Renders a compact fixed-position floating card (260px wide, `z-index: max`)
- Opens at the last dragged position if one is saved; otherwise defaults to `top: 140px, right: 20px` (below Polymarket's sticky header)
- Draggable by grabbing the header bar; drag position is saved on mouseup
- Header contains: title, a **↻ refresh** button (re-fetches live prices), and a **✕ close** button
- For multi-market events, renders one section per open sub-market, sorted ascending by settlement date
- Each section shows: question title, an editable settlement date input, and a row per outcome with price, APY, and days-to-settlement
- Each section (on multi-market events) has a **🗑 trash** button that removes it from view for the session
- Date input is pre-filled from the market's resolved `endDate`; changing it recalculates APY in-place without re-fetching

### `PortfolioInjector`
Handles the `/portfolio` page. Inlines a compact APY badge to the right of each open position row.

**Toggle**: a fixed pill button (bottom-right corner) labelled "APY: Off" / "APY: On". State persists in `localStorage` (`apy-ext-portfolio-enabled`). Badges are off by default.

**Row discovery** (`findRows`): tries a priority-ordered list of selectors; returns the first set of elements that contain an `/event/` link. Primary selector is `[class*="lg:min-h-[64px]"]` which matches Polymarket's position card containers across all background-colour variants.

**Sub-market matching** (`findBestMarket`): matches the API sub-market to the row by scoring how well each market's `question` string matches the row's visible title text (longest common prefix). Falls back to outcome-label matching, then first market.

**Price detection** (`findPriceEl`): finds a leaf element whose text matches a price pattern (`18¢`, `65%`, `$0.65`, `0.65`).

**Badge** (`injectBadge`): appended to the row element. States: loading (pulsing), error (`—`), settled (italic), default (teal APY + days). The days text is clickable — clicking it replaces it with an inline `<input type="date">` for manual override; APY recalculates on change.

**Deduplication**: a `WeakSet` tracks already-processed row nodes. A `Map` cache deduplicates concurrent API fetches for the same slug. Both are reset on navigation; the `WeakSet` auto-GCs when React unmounts and remounts rows.

### `SPAObserver`
- `MutationObserver` on `document.body` watching for DOM changes
- On every mutation: if on `/portfolio`, calls `PortfolioInjector.injectToggle()` and `scan()` to pick up lazily-rendered rows
- Detects URL changes by comparing `window.location.href` to the last known value (debounced 500ms)
- On navigation: removes old containers, resets all injector state, then re-injects the appropriate UI for the new page type

---

## UI Behaviour Summary

### Event pages (`/event/…`)

| Action | Result |
|---|---|
| Click "Calculate APY" | Fetches API, renders floating popup |
| Click ↻ | Re-fetches API, re-renders (respects existing trash list) |
| Click ✕ | Closes popup; position is remembered |
| Drag header | Moves popup; new position is saved |
| Change date input | Recalculates APY for that sub-market instantly |
| Click 🗑 on sub-market | Hides that sub-market for the session |
| Navigate to new event | Full reset — button re-injected, position and trash cleared |
| Refresh page | Full reset (page reload clears all in-memory state) |

### Portfolio page (`/portfolio`)

| Action | Result |
|---|---|
| "APY: Off" pill (bottom-right) | Enables badges; rescans all visible rows; preference saved to `localStorage` |
| "APY: On" pill | Disables and hides all badges |
| Click days text on a badge | Opens inline date input for that badge |
| Change inline date | Recalculates APY instantly for that position |
| Scroll (lazy-loaded rows) | `MutationObserver` triggers `scan()`; new rows get badges automatically |
| Navigate away and back | Toggle button re-injected; cache cleared; badges re-injected if enabled |

---

## Permissions

```json
host_permissions: ["*://*.polymarket.com/*", "https://gamma-api.polymarket.com/*"]
```

No `permissions` array needed — no storage, tabs, or other browser APIs used.

---

## Known Limitations

- Event page button injection relies on Polymarket's CSS class names containing keywords like `buy` or `trade`; may need updating if Polymarket redesigns its UI
- Portfolio row selector relies on the Tailwind class `lg:min-h-[64px]` being present on position cards; may need updating if Polymarket redesigns its UI
- DOM scraping fallback (event pages only) is best-effort and may return no data on some page layouts
- Date parsing from question text covers `Month DD` and `Month DD, YYYY` patterns; unusual phrasings will fall back to the event-level end date
- Sub-market ordering and trash state are in-memory only — not persisted across page refreshes
- Portfolio badge toggle preference is the only state persisted to `localStorage`
