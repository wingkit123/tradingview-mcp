/**
 * snr_map_v1.js
 * Pure, deterministic, evidence-only XAUUSD SNR mapper engine.
 *
 * Requirements:
 * - Schema version: snr-map.v1
 * - Evaluates closed bars only (always slices out open last bar).
 * - Strict +/- 50 pt scanning for W and D timeframes (no fallback prices or offsets).
 * - Confirmed structural entities:
 *   - horizontal_line: Confirmed structural level (Swing / Engulfing / SBR / RBS)
 *   - trend_line: 2+ confirmed pivots
 *   - rectangle: Real 2-sided range (2+ touches per side + 50% equilibrium)
 *   - text: Compact evidence-derived note
 * - Delta entities derived strictly from actual Delta indicator labels (no volume fallback).
 * - Canonical JSON and SHA-256 manifest hash.
 */

import crypto from 'node:crypto';

export const SCHEMA_VERSION = 'snr-map.v1';

export const STYLES = {
  W: { color: '#000000', width: 3 },
  D: { color: '#7E57C2', width: 2 },
  H4: { color: '#D32F2F', width: 2 },
  H1: { color: '#B8860B', width: 2 },
  RANGE: { color: 'rgba(76, 175, 80, 0.15)', border: '#2E7D32', width: 1 },
  DELTA: { color: '#E65100', width: 2 }
};

/**
 * Canonical JSON serialization (deterministic key sorting, array preservation).
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return 'null';
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const pairs = [];
  for (const key of keys) {
    const val = value[key];
    if (val !== undefined) {
      pairs.push(JSON.stringify(key) + ':' + canonicalizeJson(val));
    }
  }
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute deterministic SHA-256 hash of canonicalized payload.
 */
export function hashManifest(payload) {
  let target = payload;
  if (payload && typeof payload === 'object' && 'manifest_hash' in payload) {
    const { manifest_hash, ...rest } = payload;
    target = rest;
  }
  const canonical = canonicalizeJson(target);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Extract closed bars (discarding the forming/open last bar).
 */
export function getClosedBars(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return [];
  return bars.slice(0, -1);
}

/**
 * Detect sharp swing pivots on closed bars within price bounds.
 */
export function detectPivots(rawBars, beforeReq = 2, afterReq = 2, scanMin = -Infinity, scanMax = Infinity) {
  const bars = getClosedBars(rawBars);
  const pivots = [];
  const n = bars.length;
  if (n < beforeReq + afterReq + 1) return pivots;

  for (let i = beforeReq; i < n - afterReq; i++) {
    const b = bars[i];
    if (b.time == null || !Number.isFinite(b.time)) continue;
    const pClose = b.close;
    if (pClose == null || !Number.isFinite(pClose)) continue;
    const pHigh = b.high != null ? b.high : pClose;
    const pLow = b.low != null ? b.low : pClose;

    if (pClose < scanMin || pClose > scanMax) continue;

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= beforeReq; j++) {
      if (bars[i - j].close > pClose) isHigh = false;
      if (bars[i - j].close < pClose) isLow = false;
    }
    for (let j = 1; j <= afterReq; j++) {
      if (bars[i + j].close >= pClose) isHigh = false;
      if (bars[i + j].close <= pClose) isLow = false;
    }

    if (isHigh) {
      const upperWick = pHigh - Math.max(b.open ?? pClose, pClose);
      const isSharp = upperWick >= 1.5;
      pivots.push({
        type: 'R',
        price: Number(pClose.toFixed(2)),
        extremePrice: Number(pHigh.toFixed(2)),
        isSharp,
        barIndex: i,
        time: b.time,
        bar: b
      });
    } else if (isLow) {
      const lowerWick = Math.min(b.open ?? pClose, pClose) - pLow;
      const isSharp = lowerWick >= 1.5;
      pivots.push({
        type: 'S',
        price: Number(pClose.toFixed(2)),
        extremePrice: Number(pLow.toFixed(2)),
        isSharp,
        barIndex: i,
        time: b.time,
        bar: b
      });
    }
  }
  return pivots;
}

/**
 * Detect candle body engulfing between two consecutive candles.
 */
export function detectEngulfing(prevBar, currBar) {
  if (!prevBar || !currBar) return null;
  const pOpen = prevBar.open;
  const pClose = prevBar.close;
  const cOpen = currBar.open;
  const cClose = currBar.close;

  if (pOpen == null || pClose == null || cOpen == null || cClose == null) return null;

  const isPrevBearish = pClose < pOpen;
  const isPrevBullish = pClose > pOpen;
  const isCurrBullish = cClose > cOpen;
  const isCurrBearish = cClose < cOpen;

  // Bullish Engulfing: previous bearish, current bullish engulfing previous body
  if (isPrevBearish && isCurrBullish && cOpen <= pClose && cClose >= pOpen) {
    return 'EB';
  }

  // Bearish Engulfing: previous bullish, current bearish engulfing previous body
  if (isPrevBullish && isCurrBearish && cOpen >= pClose && cClose <= pOpen) {
    return 'ES';
  }

  return null;
}

/**
 * Detect SBR (Support Broken -> Resistance) and RBS (Resistance Broken -> Support).
 */
export function detectSbrRbs(pivot, closedBars) {
  const pPrice = pivot.price;
  const pType = pivot.type;
  const pIndex = pivot.barIndex;
  const n = closedBars.length;

  let broken = false;
  let retested = false;
  let role = pType;

  for (let i = pIndex + 1; i < n; i++) {
    const b = closedBars[i];
    if (pType === 'R') {
      if (b.close > pPrice + 0.5) broken = true;
      if (broken && b.low <= pPrice + 2.0 && b.close >= pPrice - 1.0) {
        retested = true;
        role = 'S';
      }
    } else {
      if (b.close < pPrice - 0.5) broken = true;
      if (broken && b.high >= pPrice - 2.0 && b.close <= pPrice + 1.0) {
        retested = true;
        role = 'R';
      }
    }
  }

  let action = pType === 'R' ? 'Swing Resistance' : 'Swing Support';
  if (retested) {
    action = role === 'S' ? 'RBS' : 'SBR';
  }

  return {
    retested,
    broken,
    role,
    action
  };
}

/**
 * Detect trendlines from 2 or more confirmed pivots with evidence-backed latest closed-bar setup.
 */
export function detectTrendlines(pivots, closedBars = [], style = STYLES.H4) {
  if (!Array.isArray(pivots) || pivots.length < 2) return [];
  const trendlines = [];
  const lastBar = closedBars.length > 0 ? closedBars[closedBars.length - 1] : null;
  if (!lastBar || lastBar.time == null || !Number.isFinite(lastBar.time)) return [];

  const supportPivots = pivots.filter(p => p.type === 'S' && p.time != null && Number.isFinite(p.time) && p.price != null && Number.isFinite(p.price));
  if (supportPivots.length >= 2) {
    for (let i = 0; i < supportPivots.length - 1; i++) {
      const p1 = supportPivots[i];
      const p2 = supportPivots[i + 1];
      if (p2.time > p1.time && p2.price >= p1.price - 5.0) {
        if (lastBar && lastBar.time >= p2.time) {
          const dt = p2.time - p1.time;
          const slope = dt > 0 ? (p2.price - p1.price) / dt : 0;
          const projectedPrice = p1.price + slope * (lastBar.time - p1.time);
          const lastLow = lastBar.low != null ? lastBar.low : lastBar.close;
          const lastClose = lastBar.close;
          const isRetestHold = lastLow <= projectedPrice + 3.0 && lastClose >= projectedPrice - 1.5;
          if (isRetestHold) {
            trendlines.push({
              kind: 'trend_line',
              shape: 'trend_line',
              reason: 'TL_SETUP',
              point: { time: p1.time, price: p1.price },
              point2: { time: p2.time, price: p2.price },
              tags: ['TREND_LINE', 'TL_SETUP', 'SUPPORT_TL'],
              label: `[TL_SETUP Support Retest/Hold] (AI)`,
              overrides: {
                linecolor: style.color,
                linewidth: style.width,
                linestyle: 0
              }
            });
            break;
          }
        }
      }
    }
  }

  const resPivots = pivots.filter(p => p.type === 'R' && p.time != null && Number.isFinite(p.time) && p.price != null && Number.isFinite(p.price));
  if (resPivots.length >= 2) {
    for (let i = 0; i < resPivots.length - 1; i++) {
      const p1 = resPivots[i];
      const p2 = resPivots[i + 1];
      if (p2.time > p1.time && p2.price <= p1.price + 5.0) {
        if (lastBar && lastBar.time >= p2.time) {
          const dt = p2.time - p1.time;
          const slope = dt > 0 ? (p2.price - p1.price) / dt : 0;
          const projectedPrice = p1.price + slope * (lastBar.time - p1.time);
          const lastHigh = lastBar.high != null ? lastBar.high : lastBar.close;
          const lastClose = lastBar.close;
          const isRetestReject = lastHigh >= projectedPrice - 3.0 && lastClose <= projectedPrice + 1.5;
          if (isRetestReject) {
            trendlines.push({
              kind: 'trend_line',
              shape: 'trend_line',
              reason: 'TL_SETUP',
              point: { time: p1.time, price: p1.price },
              point2: { time: p2.time, price: p2.price },
              tags: ['TREND_LINE', 'TL_SETUP', 'RESISTANCE_TL'],
              label: `[TL_SETUP Resistance Retest/Reject] (AI)`,
              overrides: {
                linecolor: style.color,
                linewidth: style.width,
                linestyle: 0
              }
            });
            break;
          }
        }
      }
    }
  }

  return trendlines;
}

/**
 * Detect two-sided range / box structures.
 * Requires: >= 2 touches at upper boundary and >= 2 touches at lower boundary.
 */
export function detectRanges(rawBars, minTouches = 2, tolerance = 3.0) {
  const bars = getClosedBars(rawBars);
  if (bars.length < 4) return [];

  const startTime = bars[0].time;
  const endTime = bars[bars.length - 1].time;
  if (startTime == null || !Number.isFinite(startTime) || endTime == null || !Number.isFinite(endTime)) {
    return [];
  }

  const highs = bars.map(b => b.high != null ? b.high : b.close);
  const lows = bars.map(b => b.low != null ? b.low : b.close);

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const rangeWidth = maxHigh - minLow;

  if (rangeWidth < 5.0 || rangeWidth > 150.0) return [];

  let highTouches = 0;
  let lowTouches = 0;

  for (let i = 0; i < bars.length; i++) {
    const h = highs[i];
    const l = lows[i];
    if (Math.abs(h - maxHigh) <= tolerance) highTouches++;
    if (Math.abs(l - minLow) <= tolerance) lowTouches++;
  }

  if (highTouches >= minTouches && lowTouches >= minTouches) {
    const equilibrium = Number(((maxHigh + minLow) / 2).toFixed(2));

    return [
      {
        kind: 'rectangle',
        shape: 'rectangle',
        reason: 'RANGE',
        high: Number(maxHigh.toFixed(2)),
        low: Number(minLow.toFixed(2)),
        equilibrium,
        point: { time: startTime, price: Number(maxHigh.toFixed(2)) },
        point2: { time: endTime, price: Number(minLow.toFixed(2)) },
        tags: ['RANGE', 'BOX'],
        label: `[Range ${minLow.toFixed(1)} - ${maxHigh.toFixed(1)} | Eq ${equilibrium.toFixed(1)}] (AI)`,
        overrides: {
          backgroundColor: STYLES.RANGE.color,
          color: STYLES.RANGE.border,
          bordercolor: STYLES.RANGE.border,
          linewidth: STYLES.RANGE.width,
          extendRight: false
        }
      }
    ];
  }

  return [];
}

/**
 * Parse actual Pine Delta indicator labels.
 * Strict: Never synthesize Delta entities or invent timestamps. Requires finite price & timestamp.
 */
export function parseDeltaLabels(deltaLabels) {
  if (!deltaLabels) return [];
  const rawList = Array.isArray(deltaLabels)
    ? deltaLabels
    : (deltaLabels.studies?.flatMap(s => s.labels || []) || []);

  const deltaEntities = [];
  for (const item of rawList) {
    const txt = item.text || item.raw?.t || '';
    const price = item.price ?? item.raw?.y;
    const time = item.time ?? item.x ?? item.raw?.x;

    const isDelta = /delta/i.test(txt) || /▲|▼/.test(txt) || txt.includes('★Δ-Rev');
    if (
      isDelta &&
      price != null &&
      Number.isFinite(price) &&
      time != null &&
      Number.isFinite(time)
    ) {
      const isBull = txt.includes('Bull') || txt.includes('Buy') || txt.includes('▲');
      const labelType = isBull ? 'Delta BuyRev' : 'Delta SellRev';
      deltaEntities.push({
        kind: 'horizontal_line',
        shape: 'horizontal_line',
        price: Number(price.toFixed(2)),
        time: Number(time),
        reason: 'DELTA_REV',
        tags: ['DELTA_REV', isBull ? 'BULL' : 'BEAR'],
        label: `[★${labelType} @ ${price.toFixed(2)}] (AI)`,
        overrides: {
          linecolor: STYLES.DELTA.color,
          linewidth: STYLES.DELTA.width,
          linestyle: 2,
          showPrice: true,
          showLabel: true,
          textcolor: STYLES.DELTA.color
        }
      });
    }
  }
  return deltaEntities;
}

/**
 * Pure SNR map builder.
 * Builds immutable snr-map.v1 payload.
 */
export function buildSnrMap({
  nowSec = Math.floor(Date.now() / 1000),
  quote,
  frames = {},
  deltaLabels = []
} = {}) {
  const quotePrice = typeof quote === 'number'
    ? quote
    : (quote?.price || quote?.last || quote?.close);

  if (quotePrice == null || !Number.isFinite(quotePrice)) {
    throw new Error('Valid quote price is required for SNR map building');
  }

  const entities = [];
  const scan50Min = quotePrice - 50.0;
  const scan50Max = quotePrice + 50.0;

  const wBars = frames.W?.bars || frames.W || [];
  const dBars = frames.D?.bars || frames.D || [];
  const h4Bars = frames.H4?.bars || frames.H4 || [];
  const h1Bars = frames.H1?.bars || frames.H1 || [];

  const closedWBars = getClosedBars(wBars);
  const closedDBars = getClosedBars(dBars);
  const closedH4Bars = getClosedBars(h4Bars);
  const closedH1Bars = getClosedBars(h1Bars);

  // 1. Weekly Pivots (Strict +/- 50 window, closed bars only)
  const wPivots = detectPivots(wBars, 2, 2, scan50Min, scan50Max);
  for (const wp of wPivots) {
    if (wp.time == null || !Number.isFinite(wp.time)) continue;
    const sbrRbs = detectSbrRbs(wp, closedWBars);
    const label = `[W - ${sbrRbs.action} @ ${wp.price.toFixed(2)}] (AI)`;
    entities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: wp.price,
      timeframe: 'W',
      reason: sbrRbs.action,
      tags: ['W', sbrRbs.action],
      point: { time: wp.time, price: wp.price },
      label,
      overrides: {
        linecolor: STYLES.W.color,
        linewidth: STYLES.W.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.W.color
      }
    });
  }

  // 2. Daily Pivots (Strict +/- 50 window, closed bars only)
  const dPivots = detectPivots(dBars, 3, 3, scan50Min, scan50Max);
  for (const dp of dPivots) {
    if (dp.time == null || !Number.isFinite(dp.time)) continue;
    if (entities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - dp.price) <= 2.0)) continue;
    const sbrRbs = detectSbrRbs(dp, closedDBars);
    const vTag = dp.isSharp ? ' (V角)' : '';
    const label = `[D - ${sbrRbs.action}${vTag} @ ${dp.price.toFixed(2)}] (AI)`;
    entities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: dp.price,
      timeframe: 'D',
      reason: sbrRbs.action,
      tags: ['D', sbrRbs.action],
      point: { time: dp.time, price: dp.price },
      label,
      overrides: {
        linecolor: STYLES.D.color,
        linewidth: STYLES.D.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.D.color
      }
    });
  }

  // 3. H4 Pivots & Structural Elements (Last 7 days)
  const sevenDaysAgo = nowSec - 7 * 86400;
  const h4Pivots = detectPivots(h4Bars, 3, 3, scan50Min - 30, scan50Max + 30)
    .filter(p => p.time != null && Number.isFinite(p.time) && p.time >= sevenDaysAgo);

  for (const h4p of h4Pivots) {
    if (h4p.time == null || !Number.isFinite(h4p.time)) continue;
    if (entities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - h4p.price) <= 2.0)) continue;
    const sbrRbs = detectSbrRbs(h4p, closedH4Bars);
    const label = `[H4 - ${sbrRbs.action} @ ${h4p.price.toFixed(2)}] (AI)`;
    entities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: h4p.price,
      timeframe: 'H4',
      reason: sbrRbs.action,
      tags: ['H4', sbrRbs.action],
      point: { time: h4p.time, price: h4p.price },
      label,
      overrides: {
        linecolor: STYLES.H4.color,
        linewidth: STYLES.H4.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.H4.color
      }
    });
    if (entities.filter(e => e.timeframe === 'H4').length >= 4) break;
  }

  // 4. H1 Pivots
  const h1Pivots = detectPivots(h1Bars, 3, 3, scan50Min - 20, scan50Max + 20)
    .filter(p => p.time != null && Number.isFinite(p.time) && p.time >= sevenDaysAgo);

  for (const h1p of h1Pivots) {
    if (h1p.time == null || !Number.isFinite(h1p.time)) continue;
    if (entities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - h1p.price) <= 2.0)) continue;
    const sbrRbs = detectSbrRbs(h1p, closedH1Bars);
    const label = `[H1 - ${sbrRbs.action} @ ${h1p.price.toFixed(2)}] (AI)`;
    entities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: h1p.price,
      timeframe: 'H1',
      reason: sbrRbs.action,
      tags: ['H1', sbrRbs.action],
      point: { time: h1p.time, price: h1p.price },
      label,
      overrides: {
        linecolor: STYLES.H1.color,
        linewidth: STYLES.H1.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.H1.color
      }
    });
    if (entities.filter(e => e.timeframe === 'H1').length >= 4) break;
  }

  // 5. Engulfing checks across closed bars (EB / ES)
  for (const { tf, bars } of [
    { tf: 'H1', bars: closedH1Bars },
    { tf: 'H4', bars: closedH4Bars },
    { tf: 'D', bars: closedDBars }
  ]) {
    if (bars.length >= 2) {
      const prevBar = bars[bars.length - 2];
      const currBar = bars[bars.length - 1];
      if (currBar?.time == null || !Number.isFinite(currBar.time)) continue;
      const type = detectEngulfing(prevBar, currBar);
      if (type) {
        const price = Number((type === 'EB' ? (currBar.low ?? currBar.close) : (currBar.high ?? currBar.close)).toFixed(2));
        const label = `[${tf} - ${type} @ ${price.toFixed(2)}] (AI)`;
        entities.push({
          kind: 'horizontal_line',
          shape: 'horizontal_line',
          price,
          timeframe: tf,
          reason: type,
          tags: [tf, type, 'ENGULFING'],
          point: { time: currBar.time, price },
          label,
          overrides: {
            linecolor: STYLES[tf]?.color || STYLES.H1.color,
            linewidth: STYLES[tf]?.width || STYLES.H1.width,
            linestyle: 0,
            showPrice: true,
            showLabel: true,
            textcolor: STYLES[tf]?.color || STYLES.H1.color
          }
        });
      }
    }
  }

  // 6. Trendlines with Confirmed Closed-Bar Setups (TL_SETUP)
  const trendlines = [
    ...detectTrendlines(h4Pivots, closedH4Bars, STYLES.H4),
    ...detectTrendlines(h1Pivots, closedH1Bars, STYLES.H1)
  ];
  for (const tl of trendlines) {
    entities.push(tl);
  }

  // 7. Real Ranges / Boxes & 50% Equilibrium Line
  const ranges = detectRanges(h4Bars);
  for (const r of ranges) {
    entities.push(r);
    if (
      r.equilibrium != null &&
      Number.isFinite(r.equilibrium) &&
      r.point?.time != null &&
      Number.isFinite(r.point.time)
    ) {
      const eqPrice = Number(r.equilibrium.toFixed(2));
      const eqLabel = `[Range 50% Eq @ ${eqPrice.toFixed(2)}] (AI)`;
      entities.push({
        kind: 'horizontal_line',
        shape: 'horizontal_line',
        price: eqPrice,
        timeframe: 'H4',
        reason: 'RANGE_EQ',
        tags: ['RANGE_EQ', 'RANGE', 'EQUILIBRIUM'],
        point: { time: r.point.time, price: eqPrice },
        label: eqLabel,
        overrides: {
          linecolor: STYLES.RANGE.border,
          linewidth: 1,
          linestyle: 2,
          showPrice: true,
          showLabel: true,
          textcolor: STYLES.RANGE.border
        }
      });
    }
  }

  // 8. Real Delta Volume Reversal Finder labels
  const deltaEntities = parseDeltaLabels(deltaLabels);
  for (const d of deltaEntities) {
    entities.push({
      ...d,
      point: { time: d.time, price: d.price }
    });
  }

  // 9. Generate compact note ONLY if evidence exists
  let note = null;
  if (entities.length > 0) {
    const anchor = entities.find(e => e.point && Number.isFinite(e.point.time) && Number.isFinite(e.point.price));
    if (anchor) {
    // Keep the note at the current chart edge while retaining an evidence-backed price.
    // A historical pivot timestamp can place an otherwise valid note off-screen.
    const anchorPoint = { time: nowSec, price: anchor.point.price };

      let dailyRegime = 'Daily: Neutral / Consolidating';
      if (dPivots.length > 0) {
        const lastDp = dPivots[dPivots.length - 1];
        dailyRegime = `Daily: ${lastDp.type === 'R' ? 'Resistance' : 'Support'} at ${lastDp.price.toFixed(2)}`;
      } else if (closedDBars.length >= 2) {
        const dCloseLast = closedDBars[closedDBars.length - 1].close;
        const dClosePrev = closedDBars[closedDBars.length - 2].close;
        dailyRegime = `Daily: Bias ${dCloseLast >= dClosePrev ? 'Bullish' : 'Bearish'}`;
      }

      let h4Structure = 'H4: Structural Consolidation';
      if (ranges.length > 0) {
        const rng = ranges[0];
        h4Structure = `H4: Range [${rng.low.toFixed(1)} - ${rng.high.toFixed(1)}] (Eq ${rng.equilibrium.toFixed(1)})`;
      } else if (h4Pivots.length > 0) {
        const lastH4 = h4Pivots[h4Pivots.length - 1];
        h4Structure = `H4: ${lastH4.type === 'R' ? 'Swing Resistance' : 'Swing Support'} @ ${lastH4.price.toFixed(2)}`;
      }

      let h1Direction = 'H1: Directional Range Flow';
      const h1Eb = entities.find(e => e.timeframe === 'H1' && (e.reason === 'EB' || e.reason === 'ES'));
      if (h1Eb) {
        h1Direction = `H1: ${h1Eb.reason === 'EB' ? 'Bullish Engulfing Hold' : 'Bearish Engulfing Reject'}`;
      } else if (h1Pivots.length > 0) {
        const lastH1 = h1Pivots[h1Pivots.length - 1];
        h1Direction = `H1: ${lastH1.type === 'R' ? 'Supply Reject' : 'Demand Hold'} @ ${lastH1.price.toFixed(2)}`;
      }

      const keyLevels = entities
        .filter(e => e.kind === 'horizontal_line' && e.price != null && Number.isFinite(e.price))
        .map(e => e.price)
        .sort((a, b) => a - b);
      const belowQuote = keyLevels.filter(p => p < quotePrice);
      const aboveQuote = keyLevels.filter(p => p > quotePrice);

      let condStatement = 'Invalidation: INSUFFICIENT_EVIDENCE';
      if (belowQuote.length > 0 && aboveQuote.length > 0) {
        const supp = belowQuote[belowQuote.length - 1];
        const res = aboveQuote[0];
        condStatement = `Invalidation: Break below ${supp.toFixed(1)} or above ${res.toFixed(1)} shifts bias`;
      }

      const noteLines = [dailyRegime, h4Structure, h1Direction, condStatement];
      note = noteLines.join('\n');

      entities.push({
        kind: 'text',
        shape: 'text',
        point: anchorPoint,
        tags: ['NOTE'],
        label: note,
        overrides: {
          text: note,
          color: '#1565C0',
          fontsize: 10,
          bold: true,
          fillBackground: false,
          showLabel: true
        }
      });
    }
  }

  const payloadForHash = {
    schema_version: SCHEMA_VERSION,
    symbol: 'OANDA:XAUUSD',
    generated_at_sec: nowSec,
    quote_price: quotePrice,
    entity_count: entities.length,
    entities: entities.map(e => ({
      kind: e.kind ?? null,
      shape: e.shape ?? null,
      timeframe: e.timeframe ?? null,
      reason: e.reason ?? null,
      tags: e.tags ?? [],
      point: e.point ?? null,
      point2: e.point2 ?? null,
      price: e.price ?? null,
      high: e.high ?? null,
      low: e.low ?? null,
      equilibrium: e.equilibrium ?? null,
      label: e.label ?? null,
      overrides: e.overrides ?? {}
    }))
  };

  const manifest_hash = hashManifest(payloadForHash);

  const manifest = {
    schema_version: SCHEMA_VERSION,
    symbol: 'OANDA:XAUUSD',
    generated_at_sec: nowSec,
    quote_price: quotePrice,
    entity_count: entities.length,
    manifest_hash
  };

  return {
    manifest,
    entities,
    note
  };
}
