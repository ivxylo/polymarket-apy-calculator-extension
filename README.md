# Polymarket APY Extension

A Chrome extension that adds an APY calculator to Polymarket event pages.

---

<!-- Screenshot: add a screenshot of the popup here once available -->

## What it does

- Fetches live share prices from Polymarket's Gamma API and computes the true compounding APY for each outcome
- Supports multi-market events — shows one section per sub-market, sorted by settlement date
- Floating popup is draggable and remembers its position within the session
- Settlement date can be overridden per sub-market to model different scenarios

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the `extension/` folder inside the repository
5. Navigate to any Polymarket event page (e.g. `polymarket.com/event/...`)

## Usage

1. On an event page, a **Calculate APY** button appears near the trade area
2. Click it — the extension fetches live prices and opens a floating popup
3. In the popup:
   - **↻** re-fetches live prices and refreshes results
   - **✕** closes the popup (position is remembered)
   - **🗑** (per sub-market) hides that sub-market for the session
   - Drag the header to reposition the popup
   - Edit the date field under any sub-market to recalculate APY with a custom settlement date

All state resets when you navigate to a new page or refresh.

## APY formula

For a binary outcome share priced at **P** with **D** days to settlement:

```
ROI = (1 - P) / P
APY = (1 + ROI)^(365/D) - 1
```

Results are capped at `>9,999%` for near-zero prices. Shows `Settled` if D ≤ 0, `N/A` for invalid prices.

## Permissions

The extension requests host access to `*.polymarket.com` and `gamma-api.polymarket.com`.

- `*.polymarket.com` — needed to inject the button and scrape data as a fallback
- `gamma-api.polymarket.com` — the only outbound network request the extension makes

No data is stored. No data is sent anywhere other than this single API call.

## Limitations

- The button injection relies on Polymarket's CSS class names containing keywords like `buy` or `trade`. If Polymarket redesigns its UI, the selector may need updating.
- Date parsing from market question text covers common patterns like `"by March 31"`. Unusual phrasings fall back to the event-level end date.
- Popup position and dismissed sub-markets are in-memory only — not persisted across page refreshes.

## License

MIT
