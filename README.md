# Polymarket APY Extension

A Chrome extension that adds APY calculations to Polymarket — both on event pages and the portfolio page.

---

<!-- Screenshot: add a screenshot of the popup here once available -->

## What it does

**Event pages** (`/event/…`)
- Fetches live share prices from Polymarket's Gamma API and computes the true compounding APY for each outcome
- Supports multi-market events — shows one section per open sub-market, sorted by settlement date; resolved sub-markets are filtered out
- Floating popup is draggable and remembers its position within the session
- Settlement date can be overridden per sub-market to model different scenarios

**Portfolio page** (`/portfolio`)
- Inlines a compact APY badge next to each open position showing the annualised yield at your average entry price
- Toggle on/off with the **APY: Off / APY: On** pill button in the bottom-right corner (off by default; preference is saved)
- Click the days count on any badge to edit the settlement date inline

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select the `extension/` folder inside the repository
5. Navigate to any Polymarket event page (`polymarket.com/event/…`) or your portfolio (`polymarket.com/portfolio`)

## Usage

### Event pages

1. A **Calculate APY** button appears near the trade area
2. Click it — the extension fetches live prices and opens a floating popup
3. In the popup:
   - **↻** re-fetches live prices and refreshes results
   - **✕** closes the popup (position is remembered for the session)
   - **🗑** (per sub-market) hides that sub-market for the session
   - Drag the header to reposition the popup
   - Edit the date field under any sub-market to recalculate APY with a custom settlement date

### Portfolio page

1. Navigate to `polymarket.com/portfolio`
2. Click the **APY: Off** pill in the bottom-right corner to enable badges
3. Each open position row shows a teal APY badge with the annualised yield and days to settlement
4. Click the days count on any badge to open an inline date picker and model a different settlement date

All in-memory state (popup position, dismissed sub-markets) resets on navigation or page refresh. The portfolio badge toggle is saved across sessions.

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

- Event page button injection relies on Polymarket's CSS class names containing keywords like `buy` or `trade`. Portfolio badge injection relies on the Tailwind class `lg:min-h-[64px]` on position cards. Either may need updating if Polymarket redesigns its UI.
- Date parsing from market question text covers common patterns like `"by March 31"`. Unusual phrasings fall back to the event-level end date.
- Popup position and dismissed sub-markets are in-memory only — not persisted across page refreshes.
- The portfolio badge toggle is the only setting persisted (via `localStorage`).

## License

MIT
