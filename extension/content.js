/**
 * Polymarket APY Calculator — Content Script
 *
 * Modules:
 *   MarketDataFetcher  — fetches market data from the Gamma API
 *   APYCalculator      — computes compounding APY from price + days
 *   UIInjector         — creates and manages the extension UI
 *   SPAObserver        — re-injects the button on SPA navigation
 */

// ---------------------------------------------------------------------------
// MarketDataFetcher
// ---------------------------------------------------------------------------
const MarketDataFetcher = (() => {
  /**
   * Extracts the event slug from the current URL path.
   * Polymarket event URLs look like: /event/some-event-slug
   */
  function getSlug() {
    const match = window.location.pathname.match(/^\/event\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  /**
   * Attempts to scrape price and end-date information directly from the DOM
   * as a fallback when the API call fails or no slug is found.
   * Returns { endDate, markets } or null.
   */
  function scrapeFromDOM() {
    // Try to find a date string anywhere in the page text
    const datePatterns = [
      // "Closes Jan 20, 2025" or "Ends Jan 20, 2025"
      /(?:closes?|ends?)\s+([A-Za-z]+ \d{1,2},\s*\d{4})/i,
      // ISO-ish dates in data attributes
    ];

    let endDate = null;
    for (const pattern of datePatterns) {
      const match = document.body.innerText.match(pattern);
      if (match) {
        const parsed = new Date(match[1]);
        if (!isNaN(parsed)) {
          endDate = parsed;
          break;
        }
      }
    }

    // Try to find price elements — Polymarket typically shows "73¢" or "73%"
    const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"], [class*="outcome"], [class*="Outcome"]');
    const prices = [];
    for (const el of priceEls) {
      const text = el.innerText.replace(/[¢%$\s]/g, '');
      const num = parseFloat(text);
      if (!isNaN(num) && num > 0 && num <= 100) {
        prices.push((num > 1 ? num / 100 : num).toFixed(2));
        if (prices.length >= 2) break;
      }
    }

    if (!endDate && prices.length === 0) return null;

    return {
      endDate: endDate || null,
      markets: prices.length >= 2
        ? [{
            outcomePrices: JSON.stringify(prices.slice(0, 2)),
            outcomes: JSON.stringify(['Yes', 'No']),
          }]
        : [],
    };
  }

  /**
   * Tries to extract a settlement date from a market question string.
   * Handles patterns like "by March 31", "by June 30, 2025", "by Dec 31".
   * Returns a Date or null.
   *
   * Year inference rule: use eventEndDate's year as the reference. If that
   * candidate falls before today, try the following year — but never past
   * eventEndDate itself.
   *
   * @param {string|undefined} question
   * @param {Date|null} eventEndDate
   */
  function parseDateFromQuestion(question, eventEndDate) {
    if (!question) return null;

    const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
    const pattern = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\b`, 'i');
    const match = question.match(pattern);
    if (!match) return null;

    const monthStr = match[1];
    const day = parseInt(match[2], 10);
    const explicitYear = match[3] ? parseInt(match[3], 10) : null;

    if (explicitYear) {
      const d = new Date(`${monthStr} ${day}, ${explicitYear}`);
      return isNaN(d) ? null : d;
    }

    // No year in the question — infer from the event's end year
    const refYear = eventEndDate ? eventEndDate.getFullYear() : new Date().getFullYear();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let candidate = new Date(`${monthStr} ${day}, ${refYear}`);
    if (isNaN(candidate)) return null;

    // If this candidate is already in the past, try the next year (but never
    // beyond the event's own end date, which is the hard deadline)
    if (candidate < today) {
      const nextYear = new Date(`${monthStr} ${day}, ${refYear + 1}`);
      if (!isNaN(nextYear) && (!eventEndDate || nextYear <= eventEndDate)) {
        candidate = nextYear;
      }
    }

    // Sanity check: the sub-market date must not exceed the event end date
    if (eventEndDate && candidate > eventEndDate) return null;

    return candidate;
  }

  /**
   * Fetches event data from the Gamma API for the current page slug.
   * Falls back to DOM scraping on failure.
   * Returns { endDate: Date|null, markets: Array } or throws.
   */
  async function fetch() {
    const slug = getSlug();

    if (slug) {
      try {
        const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
        const response = await window.fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // The API may return an array; find the first event matching the slug
        const event = Array.isArray(data)
          ? data.find(e => e.slug === slug) || data[0]
          : data;

        if (!event) throw new Error('No matching event in API response');

        const eventEndDate = event.endDate ? new Date(event.endDate) : null;

        // Normalise each market: prefer the market's own API endDate when it
        // differs from the event-level date.  When they're identical (the API
        // gave every sub-market the same deadline) try to extract the real
        // per-market date from the question text instead.
        const markets = (Array.isArray(event.markets) ? event.markets : []).map(m => {
          let endDate = m.endDate ? new Date(m.endDate) : eventEndDate;

          // Detect "all markets share the event date" — within 1 day tolerance
          // to absorb any time-zone rounding in the API response.
          const sameAsEvent =
            eventEndDate &&
            endDate &&
            Math.abs(endDate - eventEndDate) < 24 * 60 * 60 * 1000;

          if (sameAsEvent || !endDate) {
            const questionDate = parseDateFromQuestion(m.question, eventEndDate);
            if (questionDate) endDate = questionDate;
          }

          return { ...m, endDate };
        });

        return { endDate: eventEndDate, markets };
      } catch (err) {
        console.warn('[APY Ext] Gamma API fetch failed, falling back to DOM scraping:', err.message);
      }
    }

    // DOM fallback
    const scraped = scrapeFromDOM();
    if (scraped) return scraped;

    throw new Error('Could not retrieve market data from API or DOM.');
  }

  return { fetch, getSlug };
})();

// ---------------------------------------------------------------------------
// APYCalculator
// ---------------------------------------------------------------------------
const APYCalculator = (() => {
  /**
   * Calculates annualised compounding APY for a binary outcome share.
   *
   * Formula:
   *   ROI = (1 - P) / P          — profit per dollar invested if outcome wins
   *   APY = (1 + ROI)^(365/D) - 1
   *
   * @param {number} price           — current share price in [0, 1]
   * @param {number} daysToSettlement — calendar days until market settles
   * @returns {number|null}          — APY as a decimal (e.g. 0.15 = 15%), or null
   */
  function calculateAPY(price, daysToSettlement) {
    if (daysToSettlement <= 0 || price <= 0 || price >= 1) return null;
    const roi = (1 - price) / price;
    return Math.pow(1 + roi, 365 / daysToSettlement) - 1;
  }

  /**
   * Formats an APY decimal as a percentage string.
   * @param {number|null} value
   * @param {number} daysToSettlement
   */
  function formatAPY(value, daysToSettlement) {
    if (daysToSettlement <= 0) return 'Settled';
    if (value === null) return 'N/A';
    if (!isFinite(value)) return '∞';
    const pct = value * 100;
    // toFixed() returns scientific notation for values >= 1e+21 in V8, so cap
    // anything absurdly large (> 9,999%) rather than display garbage.
    if (pct >= 10000) return '>9,999%';
    return pct.toFixed(2) + '%';
  }

  /**
   * Computes days between today and a target date (floored to whole days).
   */
  function daysUntil(date) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    return Math.floor((target - now) / (1000 * 60 * 60 * 24));
  }

  return { calculateAPY, formatAPY, daysUntil };
})();

// ---------------------------------------------------------------------------
// UIInjector
// ---------------------------------------------------------------------------
const UIInjector = (() => {
  const CONTAINER_ID = 'apy-ext-container';

  // Last known popup position — persists for the lifetime of the page so
  // closing and re-opening keeps the card where the user left it.
  // Cleared by SPAObserver on navigation via reset().
  let savedPosition = null; // { left, top } in px

  // Set of market keys the user has trashed this session.
  // Key = market.question (stable per sub-market within an event).
  let trashedMarkets = new Set();

  function resetPosition() { savedPosition = null; }
  function resetTrashed() { trashedMarkets = new Set(); }
  function reset() { resetPosition(); resetTrashed(); }

  /**
   * Priority-ordered list of CSS selectors to try when finding the injection
   * target. We insert the extension card after the first match.
   * Update this list if Polymarket changes its DOM structure.
   */
  const INJECTION_TARGETS = [
    '[class*="buy"]',
    '[class*="trade"]',
    '[class*="orderBook"]',
    '[class*="Order"]',
    '[class*="market-"]',
    'main',
    'body',
  ];

  function findTarget() {
    for (const selector of INJECTION_TARGETS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return document.body;
  }

  /**
   * Injects the "Calculate APY" button into the page.
   * Safe to call multiple times — guards against duplicate injection.
   */
  function injectButton() {
    if (document.getElementById(CONTAINER_ID)) return; // already injected

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    const btn = document.createElement('button');
    btn.id = 'apy-ext-calc-btn';
    btn.textContent = 'Calculate APY';
    btn.setAttribute('aria-label', 'Calculate annualised percentage yield for this market');

    btn.addEventListener('click', handleCalculateClick);

    container.appendChild(btn);

    const target = findTarget();
    // Insert after the target element (or at the end of its parent)
    if (target.parentNode && target !== document.body) {
      target.parentNode.insertBefore(container, target.nextSibling);
    } else {
      target.appendChild(container);
    }
  }

  /**
   * Renders the APY results card inside the container.
   * Handles multi-market events by rendering a separate section per market,
   * each with its own settlement date input and independent recalculation.
   * @param {{ endDate: Date|null, markets: Array }} marketData
   */
  function renderResults(marketData) {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    // Remove any existing results card
    const existing = container.querySelector('#apy-ext-results');
    if (existing) existing.remove();

    const card = document.createElement('div');
    card.id = 'apy-ext-results';

    // Header — doubles as drag handle
    const header = document.createElement('div');
    header.className = 'apy-ext-header';
    header.innerHTML = '<span class="apy-ext-title">APY Calculator</span>';

    const headerBtns = document.createElement('div');
    headerBtns.className = 'apy-ext-header-btns';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'apy-ext-refresh';
    refreshBtn.textContent = '↻';
    refreshBtn.setAttribute('aria-label', 'Refresh APY calculations');
    refreshBtn.addEventListener('click', () => handleCalculateClick());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'apy-ext-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close APY calculator');
    closeBtn.addEventListener('click', () => card.remove());

    headerBtns.appendChild(refreshBtn);
    headerBtns.appendChild(closeBtn);
    header.appendChild(headerBtns);
    card.appendChild(header);

    // Make the card draggable; save position on every drag end
    makeDraggable(card, header, (pos) => { savedPosition = pos; });

    const markets = (marketData.markets.length > 0
      ? [...marketData.markets]
      : [{ endDate: marketData.endDate, outcomePrices: '[]', outcomes: '["Yes","No"]' }]
    ).sort((a, b) => {
      // Sort ascending by settlement date; markets with no date go last
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return a.endDate - b.endDate;
    });

    if (markets.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'apy-ext-no-data';
      msg.textContent = 'No market data available.';
      card.appendChild(msg);
    }

    const fallbackDate = marketData.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Filter out any markets the user has already trashed this session
    const visibleMarkets = markets.filter(m => !trashedMarkets.has(m.question));

    visibleMarkets.forEach((market, idx) => {
      // Parse prices and outcomes for this market
      let prices = [];
      let outcomes = ['Yes', 'No'];
      try {
        prices = JSON.parse(market.outcomePrices || '[]').map(Number);
        outcomes = JSON.parse(market.outcomes || '["Yes","No"]');
      } catch (e) {
        console.warn(`[APY Ext] Failed to parse market[${idx}] outcomePrices:`, e);
      }

      // Per-market settlement date (falls back to event-level date)
      const settlementDate = market.endDate || fallbackDate;
      const dateValue = toDateInputValue(settlementDate);

      const section = document.createElement('div');
      section.className = 'apy-ext-market-section';

      // Section header: question title + trash button (multi-market events only)
      if (markets.length > 1 && market.question) {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'apy-ext-section-header';

        const title = document.createElement('p');
        title.className = 'apy-ext-market-title';
        title.textContent = market.question;

        const trashBtn = document.createElement('button');
        trashBtn.className = 'apy-ext-trash';
        trashBtn.textContent = '🗑';
        trashBtn.setAttribute('aria-label', `Remove ${market.question}`);
        trashBtn.addEventListener('click', () => {
          trashedMarkets.add(market.question);
          section.remove();
        });

        sectionHeader.appendChild(title);
        sectionHeader.appendChild(trashBtn);
        section.appendChild(sectionHeader);
      }

      // Date row — unique id per market
      const dateInputId = `apy-ext-date-input-${idx}`;
      const dateRow = document.createElement('div');
      dateRow.className = 'apy-ext-date-row';
      const dateLabel = document.createElement('label');
      dateLabel.htmlFor = dateInputId;
      dateLabel.textContent = 'Settlement:';
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.id = dateInputId;
      dateInput.value = dateValue;
      dateRow.appendChild(dateLabel);
      dateRow.appendChild(dateInput);
      section.appendChild(dateRow);

      // Grid for APY rows
      const grid = document.createElement('div');
      grid.className = 'apy-ext-grid';
      section.appendChild(grid);

      card.appendChild(section);

      // Render initial values, then re-render on date change
      renderMarketAPY(grid, prices, outcomes, dateInput.value);
      dateInput.addEventListener('input', () => {
        renderMarketAPY(grid, prices, outcomes, dateInput.value);
      });
    });

    container.appendChild(card);
  }

  /**
   * Renders APY rows into a grid element for one market.
   * Called on initial render and whenever the date input changes.
   * @param {HTMLElement} grid
   * @param {number[]} prices    — share prices in [0,1]
   * @param {string[]} outcomes  — outcome labels
   * @param {string}   dateStr   — YYYY-MM-DD from the date input
   */
  function renderMarketAPY(grid, prices, outcomes, dateStr) {
    grid.innerHTML = '';

    const targetDate = dateStr ? new Date(dateStr) : null;
    const days = targetDate && !isNaN(targetDate) ? APYCalculator.daysUntil(targetDate) : 0;

    if (prices.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'apy-ext-no-data';
      msg.textContent = 'No price data available.';
      grid.appendChild(msg);
      return;
    }

    prices.forEach((price, i) => {
      const label = outcomes[i] || `Outcome ${i + 1}`;
      const apy = APYCalculator.calculateAPY(price, days);
      const formatted = APYCalculator.formatAPY(apy, days);

      const row = document.createElement('div');
      row.className = 'apy-ext-row';

      const labelEl = document.createElement('span');
      labelEl.className = 'apy-ext-outcome-label';
      labelEl.textContent = label;

      const priceEl = document.createElement('span');
      priceEl.className = 'apy-ext-price';
      priceEl.textContent = `${(price * 100).toFixed(1)}¢`;

      const apyEl = document.createElement('span');
      apyEl.className = 'apy-ext-apy-value';
      apyEl.textContent = formatted;

      const daysEl = document.createElement('span');
      daysEl.className = 'apy-ext-days';
      daysEl.textContent = days > 0 ? `${days}d` : 'Settled';

      row.appendChild(labelEl);
      row.appendChild(priceEl);
      row.appendChild(apyEl);
      row.appendChild(daysEl);
      grid.appendChild(row);
    });

    const summary = document.createElement('p');
    summary.className = 'apy-ext-summary';
    summary.textContent = days > 0
      ? `${days} day${days !== 1 ? 's' : ''} to settlement`
      : 'Market already settled or date is today';
    grid.appendChild(summary);
  }

  /** Converts a Date object to the YYYY-MM-DD string expected by <input type="date"> */
  function toDateInputValue(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** Shows a loading state on the calculate button */
  function setLoading(isLoading) {
    const btn = document.getElementById('apy-ext-calc-btn');
    if (!btn) return;
    btn.disabled = isLoading;
    btn.textContent = isLoading ? 'Loading…' : 'Calculate APY';
  }

  /** Shows an inline error message in the container */
  function showError(message) {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    let errEl = container.querySelector('#apy-ext-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = 'apy-ext-error';
      errEl.className = 'apy-ext-error';
      container.appendChild(errEl);
    }
    errEl.textContent = `⚠ ${message}`;
  }

  function clearError() {
    const errEl = document.getElementById('apy-ext-error');
    if (errEl) errEl.remove();
  }

  /**
   * Makes an element draggable by grabbing its handle.
   * Restores savedPosition if set, otherwise defaults to top-right.
   * Calls onDragEnd({ left, top }) whenever the user finishes a drag.
   */
  function makeDraggable(el, handle, onDragEnd) {
    if (savedPosition) {
      el.style.left = savedPosition.left + 'px';
      el.style.top  = savedPosition.top  + 'px';
      el.style.right = 'auto';
    } else {
      // Default: below Polymarket's sticky header
      el.style.top = '140px';
      el.style.right = '20px';
    }

    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.apy-ext-close, .apy-ext-refresh')) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      el.style.left = rect.left + 'px';
      el.style.right = 'auto';
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop  = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = Math.max(0, startLeft + dx) + 'px';
      el.style.top  = Math.max(0, startTop  + dy) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        onDragEnd({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) });
      }
    });
  }

  return { injectButton, renderResults, setLoading, showError, clearError, reset };
})();

// ---------------------------------------------------------------------------
// Button click handler
// ---------------------------------------------------------------------------
async function handleCalculateClick() {
  UIInjector.setLoading(true);
  UIInjector.clearError();
  try {
    const marketData = await MarketDataFetcher.fetch();
    UIInjector.renderResults(marketData);
  } catch (err) {
    console.error('[APY Ext] Error calculating APY:', err);
    UIInjector.showError(err.message || 'Failed to load market data.');
  } finally {
    UIInjector.setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// SPAObserver — re-injects the button when the user navigates within the SPA
// ---------------------------------------------------------------------------
const SPAObserver = (() => {
  let currentHref = window.location.href;
  let debounceTimer = null;

  function onMutation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const newHref = window.location.href;
      if (newHref !== currentHref) {
        currentHref = newHref;
        // The old container belongs to a different page — remove it and reset state
        const old = document.getElementById('apy-ext-container');
        if (old) old.remove();
        UIInjector.reset();
        // Only inject if we're on an event page
        if (/\/event\//.test(window.location.pathname)) {
          UIInjector.injectButton();
        }
      }
    }, 500);
  }

  function start() {
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return { start };
})();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
(function init() {
  if (/\/event\//.test(window.location.pathname)) {
    UIInjector.injectButton();
  }
  SPAObserver.start();
})();
