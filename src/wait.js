import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export function normalizeResolution(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  const aliasMap = {
    D: 'D',
    '1D': 'D',
    W: 'W',
    '1W': 'W',
    M: 'M',
    '1M': 'M',
    H4: '240',
    '4H': '240',
    '240': '240',
    H1: '60',
    '1H': '60',
    '60': '60',
    M15: '15',
    '15M': '15',
    '15': '15',
    M5: '5',
    '5M': '5',
    '5': '5',
    M1: '1',
    '1': '1',
    M3: '3',
    '3M': '3',
    '3': '3',
    M30: '30',
    '30M': '30',
    '30': '30',
    M45: '45',
    '45M': '45',
    '45': '45',
    H2: '120',
    '2H': '120',
    '120': '120',
    H3: '180',
    '3H': '180',
    '180': '180',
    H6: '360',
    '6H': '360',
    '360': '360',
    H8: '480',
    '8H': '480',
    '480': '480',
    H12: '720',
    '12H': '720',
    '720': '720',
  };
  if (aliasMap[raw]) {
    return aliasMap[raw];
  }
  const hMatch = raw.match(/^H(\d+)$/) || raw.match(/^(\d+)H$/);
  if (hMatch) {
    return String(parseInt(hMatch[1], 10) * 60);
  }
  const mMatch = raw.match(/^M(\d+)$/) || raw.match(/^(\d+)M$/);
  if (mMatch) {
    return String(parseInt(mMatch[1], 10));
  }
  return raw;
}

export async function waitForChartReady(
  expectedSymbol = null,
  expectedTf = null,
  timeout = DEFAULT_TIMEOUT,
  { evaluate: evalFn = evaluate, pollInterval = POLL_INTERVAL } = {},
) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evalFn(`
      (function() {
        // Check for chart loading spinner (target chart-level loading overlays, excluding legend elements)
        var spinner = document.querySelector('.ch-loader, .chart-loading-screen, [class*="loading-overlay"]:not(.js-hidden), [data-name="loading"]')
          || document.querySelector('.chart-container > [class*="loader"], .chart-widget > [class*="loader"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        var barCount = -1;
        var currentSymbol = '';
        var resolution = '';

        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          if (chart) {
            if (typeof chart.symbol === 'function') currentSymbol = chart.symbol();
            if (typeof chart.resolution === 'function') resolution = chart.resolution();

            var model = chart._chartWidget && chart._chartWidget.model
              ? chart._chartWidget.model()
              : (chart.model ? chart.model() : null);
            var ms = model && model.mainSeries ? model.mainSeries() : null;
            var bars = ms && ms.bars ? ms.bars() : null;
            if (bars) {
              if (typeof bars.size === 'function') {
                barCount = bars.size();
              } else if (typeof bars.count === 'function') {
                barCount = bars.count();
              } else if (typeof bars.size === 'number') {
                barCount = bars.size;
              } else if (typeof bars.length === 'number') {
                barCount = bars.length;
              } else if (typeof bars.firstIndex === 'function' && typeof bars.lastIndex === 'function') {
                var fi = bars.firstIndex();
                var li = bars.lastIndex();
                if (fi != null && li != null && li >= fi) {
                  barCount = li - fi + 1;
                }
              }
            }
          }
        } catch(e) {}

        if (!currentSymbol) {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          if (symbolEl) currentSymbol = symbolEl.textContent.trim();
        }

        return {
          isLoading: !!isLoading,
          barCount: barCount,
          currentSymbol: currentSymbol,
          resolution: resolution
        };
      })()
    `);

    if (!state) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    // Check symbol match if expected
    if (expectedSymbol && (!state.currentSymbol || !state.currentSymbol.toUpperCase().includes(expectedSymbol.toUpperCase()))) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    if (expectedTf && (!state.resolution || normalizeResolution(state.resolution) !== normalizeResolution(expectedTf))) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    // Check bar count stability with positive loaded bar evidence
    if (typeof state.barCount === 'number' && state.barCount > 0 && state.barCount === lastBarCount) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  // Timeout — fail closed, return false
  return false;
}

/**
 * Wait for the chart to finish (re)rendering — used before screenshots so a
 * capture right after chart_set_symbol / chart_set_timeframe doesn't grab a
 * stale frame (issue #144). Waits for any loading spinner to clear, then for
 * the symbol/resolution/canvas signature to hold stable across 3 polls.
 */
export async function waitForChartRender(timeout = 5000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('.ch-loader, .chart-loading-screen, [class*="loading-overlay"]:not(.js-hidden), [data-name="loading"]')
          || document.querySelector('.chart-container > [class*="loader"], .chart-widget > [class*="loader"]');
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: !!(spinner && spinner.offsetParent !== null),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= 3) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
