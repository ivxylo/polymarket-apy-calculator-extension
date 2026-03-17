# Polymarket APY Calculator — Extension Spec

## Overview

A Manifest V3 Chrome extension that injects an APY calculator into Polymarket event pages. It fetches live share prices from Polymarket's public API and computes the true compounding annualised percentage yield (APY) for each outcome, letting users compare prediction market returns against traditional yield opportunities.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — declares content script, CSS, and host permissions |
| `content.js` | All extension logic, organised into four modules |
| `styles.css` | Scoped styles prefixed with `#apy-ext-container` |

No background service worker. No `chrome.storage`. All state is in-memory and resets on page navigation.

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
- Fetches from `https://gamma-api.polymarket.com/events?slug=<slug>`
- Parses per-market `outcomePrices`, `outcomes`, `endDate`, and `question` fields
- **Date normalisation**: if all sub-markets share the same `endDate` as the event (within 1 day tolerance), attempts to parse a more specific settlement date from the market's `question` text (e.g. `"by March 31"` → March 31 of the inferred year)
- Year inference for partial dates: uses the event's end year as reference; if that candidate is already past, tries the next year, capped at the event's own end date
- Falls back to DOM scraping if the API call fails or no slug is found

### `APYCalculator`
- `calculateAPY(price, daysToSettlement)` — returns APY as a decimal or `null`
- `formatAPY(value, daysToSettlement)` — formats for display with capping and edge cases
- `daysUntil(date)` — floor of calendar days from today to the target date

### `UIInjector`
Manages all DOM interaction. Maintains two pieces of in-memory state (both reset on SPA navigation):
- `savedPosition` — last drag coordinates of the popup `{ left, top }`
- `trashedMarkets` — `Set` of market question strings the user has dismissed

**Button injection** (`injectButton`):
- Tries a priority-ordered list of CSS selectors to find a suitable injection point near the buy/trade area
- Inserts a `<div id="apy-ext-container">` with a "Calculate APY" button after the matched element
- Guards against duplicate injection

**Results popup** (`renderResults`):
- Renders a compact fixed-position floating card (260px wide, `z-index: max`)
- Opens at the last dragged position if one is saved; otherwise defaults to `top: 140px, right: 20px` (below Polymarket's sticky header)
- Draggable by grabbing the header bar; drag position is saved on mouseup
- Header contains: title, a **↻ refresh** button (re-fetches live prices), and a **✕ close** button
- For multi-market events, renders one section per sub-market, sorted ascending by settlement date
- Each section shows: question title, an editable settlement date input, and a row per outcome with price, APY, and days-to-settlement
- Each section (on multi-market events) has a **🗑 trash** button that removes it from view for the session
- Date input is pre-filled from the market's resolved `endDate`; changing it recalculates APY in-place without re-fetching

### `SPAObserver`
- `MutationObserver` on `document.body` watching for DOM changes
- Detects URL changes by comparing `window.location.href` to the last known value
- On navigation: removes the old container, resets `savedPosition` and `trashedMarkets`, re-injects the button if the new page is an event page
- Debounced at 500ms to avoid thrashing during SPA transitions

---

## UI Behaviour Summary

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

---

## Permissions

```json
host_permissions: ["*://*.polymarket.com/*", "https://gamma-api.polymarket.com/*"]
```

No `permissions` array needed — no storage, tabs, or other browser APIs used.

---

## Known Limitations

- Injection target selector relies on Polymarket's CSS class names containing keywords like `buy` or `trade`; may need updating if Polymarket redesigns its UI
- DOM scraping fallback is best-effort and may return no data on some page layouts
- Date parsing from question text covers `Month DD` and `Month DD, YYYY` patterns; unusual phrasings will fall back to the event-level end date
- Sub-market ordering and trash state are in-memory only — not persisted across page refreshes
