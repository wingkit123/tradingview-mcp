/**
 * snr_map_v1.js
 * Pure, deterministic, evidence-only XAUUSD SNR mapper engine.
 *
 * Requirements:
 * - Schema version: snr-map.v1
 * - Evaluates closed bars only (always slices out open last bar).
 * - Strict scanning window: Weekly +/- 200 pt (quotePrice +/- 200), Daily +/- 100 pt (quotePrice +/- 100).
 * - Only draw when confirmed structural evidence exists (no synthetic or fallback offset lines).
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

/** Hash the exact entity collection persisted in an snr-map.v1 receipt. */
export function hashSnrMapEntities({
  schema_version = SCHEMA_VERSION,
  symbol = 'OANDA:XAUUSD',
  generated_at_sec,
  quote_price,
  entities = []
} = {}) {
  if (!Number.isFinite(generated_at_sec) || !Number.isFinite(quote_price) || !Array.isArray(entities)) {
    throw new Error('Cannot hash SNR map receipt without finite timestamp, quote price, and entity array');
  }
  return hashManifest({
    schema_version,
    symbol,
    generated_at_sec,
    quote_price,
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
  });
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
 * Priority scoring for horizontal lines during clustering.
 * Higher score = preferred cluster representative.
 */
function getHorizontalLinePriority(e) {
  let tfScore = 0;
  const tf = e.timeframe || (e.tags?.includes('W') ? 'W' : e.tags?.includes('D') ? 'D' : e.tags?.includes('H4') ? 'H4' : e.tags?.includes('H1') ? 'H1' : null);
  if (tf === 'W') tfScore = 500;
  else if (tf === 'D') tfScore = 400;
  else if (tf === 'H4') tfScore = 300;
  else if (tf === 'H1') tfScore = 200;
  else if (e.reason === 'DELTA_REV' || e.tags?.includes('DELTA_REV')) tfScore = 150;
  else if (e.reason === 'RANGE_EQ' || e.tags?.includes('RANGE_EQ')) tfScore = 100;
  else tfScore = 50;

  let reasonScore = 0;
  if (e.reason === 'RBS' || e.reason === 'SBR') reasonScore = 80;
  else if (e.reason === 'EB' || e.reason === 'ES') reasonScore = 60;
  else if (e.reason?.includes('Swing')) reasonScore = 40;
  else if (e.reason === 'DELTA_REV') reasonScore = 30;
  else if (e.reason === 'RANGE_EQ') reasonScore = 20;

  const deltaBonus = (e.tags?.includes('DELTA_CONFIRMED') || e.hasDeltaRev) ? 150 : 0;
  const weeklyZoneBonus = (e.tags?.includes('WEEKLY_ZONE') || e.inWeeklyZone) ? 50 : 0;

  const timeScore = (e.point?.time && Number.isFinite(e.point.time)) ? e.point.time / 1e12 : 0;
  return tfScore + reasonScore + deltaBonus + weeklyZoneBonus + timeScore;
}

/**
 * Determine the dominant timeframe and styling for a cluster.
 * Weekly (Black) dominates Daily, which dominates H4, which dominates H1.
 */
export function determineDominantStyle(cluster) {
  if (cluster.some(m => m.timeframe === 'W' || m.tags?.includes('W'))) {
    return { timeframe: 'W', ...STYLES.W };
  }
  if (cluster.some(m => m.timeframe === 'D' || m.tags?.includes('D'))) {
    return { timeframe: 'D', ...STYLES.D };
  }
  if (cluster.some(m => m.timeframe === 'H4' || m.tags?.includes('H4'))) {
    return { timeframe: 'H4', ...STYLES.H4 };
  }
  return { timeframe: 'H1', ...STYLES.H1 };
}

/**
 * Synthesize multi-timeframe confluence label:
 * e.g. "[W RBS + D EB + H4 RBS @ 4283.72] (AI)"
 * or "[W RBS + H4 SBR (Double, ★Δ-Buy) @ 4317.02] (AI)"
 */
export function synthesizeConfluenceLabel(cluster, targetPrice) {
  const TF_ORDER = { W: 1, D: 2, H4: 3, H1: 4 };

  const seenTokens = new Set();
  const tokens = [];
  let hasDelta = false;
  let deltaType = null;
  let hasV = false;
  let has2B = false;

  for (const m of cluster) {
    if (m.tags?.includes('DELTA_CONFIRMED') || m.hasDeltaRev || m.reason === 'DELTA_REV' || m.tags?.includes('DELTA_REV') || m.label?.includes('★Δ')) {
      hasDelta = true;
      if (m.deltaType) deltaType = m.deltaType;
      else if (m.tags?.includes('BULL') || m.label?.includes('BuyRev') || m.label?.includes('Buy')) deltaType = 'Buy';
      else if (m.tags?.includes('BEAR') || m.label?.includes('SellRev') || m.label?.includes('Sell')) deltaType = 'Sell';
    }
    if (m.tags?.includes('V角') || m.label?.includes('V角')) hasV = true;
    if (m.tags?.includes('2B') || m.label?.includes('Double')) has2B = true;

    const tf = m.timeframe || (m.tags?.includes('W') ? 'W' : m.tags?.includes('D') ? 'D' : m.tags?.includes('H4') ? 'H4' : m.tags?.includes('H1') ? 'H1' : null);
    const reason = m.reason || (m.tags?.includes('RBS') ? 'RBS' : m.tags?.includes('SBR') ? 'SBR' : m.tags?.includes('EB') ? 'EB' : m.tags?.includes('ES') ? 'ES' : null);

    if (tf && reason && reason !== 'DELTA_REV' && reason !== 'RANGE_EQ') {
      const cleanReason = reason.replace(/\s*\(V角\)/, '');
      const token = `${tf} ${cleanReason}`;
      if (!seenTokens.has(token)) {
        seenTokens.add(token);
        tokens.push({ tf, reason: cleanReason, token, order: TF_ORDER[tf] || 5 });
      }
    }
  }

  tokens.sort((a, b) => a.order - b.order);

  const extras = [];
  if (hasV) extras.push('V角');
  if (has2B) extras.push('Double');
  if (hasDelta) {
    if (deltaType === 'Buy' || deltaType === 'BULL') extras.push('★Δ-Buy');
    else if (deltaType === 'Sell' || deltaType === 'BEAR') extras.push('★Δ-Sell');
    else extras.push('★Δ-Rev');
  }

  const extrasStr = extras.length > 0 ? ` (${extras.join(', ')})` : '';

  if (tokens.length === 0) {
    return cluster[0]?.label || `[Level @ ${targetPrice.toFixed(2)}] (AI)`;
  }

  if (tokens.length === 1 && extras.length === 0) {
    return `[${tokens[0].token} @ ${targetPrice.toFixed(2)}] (AI)`;
  }

  const mainPart = tokens.map(t => t.token).join(' + ');
  return `[${mainPart}${extrasStr} @ ${targetPrice.toFixed(2)}] (AI)`;
}

/**
 * Deterministic global horizontal-line canonical dedup/clustering pass with a 4.0 price-point threshold.
 * Keeps one representative, merges confluence metadata deterministically, and applies dominant timeframe styling.
 */
export function clusterHorizontalLines(lines = [], threshold = 2.0) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  if (lines.length === 1) {
    const item = lines[0];
    const hasDelta = item.tags?.includes('DELTA_CONFIRMED') || item.hasDeltaRev || item.tags?.includes('DELTA_REV') || item.label?.includes('★Δ');
    if (hasDelta && !item.label?.includes('★Δ')) {
      const targetPrice = item.price ?? item.point?.price ?? 0;
      const synthLabel = synthesizeConfluenceLabel([item], targetPrice);
      const domStyle = determineDominantStyle([item]);
      return [{
        ...item,
        label: synthLabel,
        overrides: {
          ...(item.overrides || {}),
          linecolor: domStyle.color,
          linewidth: Math.max(item.overrides?.linewidth || domStyle.width, 3),
          textcolor: domStyle.color,
          text: synthLabel
        }
      }];
    }
    return [...lines];
  }

  // Sort deterministically by price ascending, then tiebreak by priority descending, then label
  const sorted = [...lines].sort((a, b) => {
    const pA = a.price ?? a.point?.price ?? 0;
    const pB = b.price ?? b.point?.price ?? 0;
    if (Math.abs(pA - pB) > 1e-6) return pA - pB;
    const prioDiff = getHorizontalLinePriority(b) - getHorizontalLinePriority(a);
    if (prioDiff !== 0) return prioDiff;
    return (a.label || '').localeCompare(b.label || '');
  });

  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const itemPrice = item.price ?? item.point?.price ?? 0;
    const clusterMinPrice = currentCluster[0].price ?? currentCluster[0].point?.price ?? 0;

    if (itemPrice - clusterMinPrice <= threshold) {
      currentCluster.push(item);
    } else {
      clusters.push(currentCluster);
      currentCluster = [item];
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const result = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      const item = cluster[0];
      const hasDelta = item.tags?.includes('DELTA_CONFIRMED') || item.hasDeltaRev || item.tags?.includes('DELTA_REV') || item.label?.includes('★Δ');
      if (hasDelta && !item.label?.includes('★Δ')) {
        const targetPrice = item.price ?? item.point?.price ?? 0;
        const synthLabel = synthesizeConfluenceLabel(cluster, targetPrice);
        const domStyle = determineDominantStyle(cluster);
        result.push({
          ...item,
          label: synthLabel,
          overrides: {
            ...(item.overrides || {}),
            linecolor: domStyle.color,
            linewidth: Math.max(item.overrides?.linewidth || domStyle.width, 3),
            textcolor: domStyle.color,
            text: synthLabel
          }
        });
      } else {
        result.push(item);
      }
      continue;
    }

    // Select the best representative by priority
    let representative = cluster[0];
    let bestScore = getHorizontalLinePriority(representative);

    for (let j = 1; j < cluster.length; j++) {
      const score = getHorizontalLinePriority(cluster[j]);
      if (score > bestScore) {
        bestScore = score;
        representative = cluster[j];
      }
    }

    // Merge confluence metadata deterministically
    const mergedTagsSet = new Set();
    const confluenceTfs = new Set();
    const confluenceReasons = new Set();

    for (const member of cluster) {
      (member.tags || []).forEach(t => mergedTagsSet.add(t));
      if (member.timeframe) confluenceTfs.add(member.timeframe);
      if (member.reason) confluenceReasons.add(member.reason);
    }

    const mergedTags = Array.from(mergedTagsSet).sort();
    const mergedConfluenceTfs = Array.from(confluenceTfs).sort();
    const mergedConfluenceReasons = Array.from(confluenceReasons).sort();

    // Dominant style: Weekly (Black, width 3) dominates Daily, H4, H1
    const domStyle = determineDominantStyle(cluster);
    const targetPrice = representative.price ?? representative.point?.price ?? 0;
    const synthLabel = synthesizeConfluenceLabel(cluster, targetPrice);
    const hasDelta = cluster.some(m => m.tags?.includes('DELTA_CONFIRMED') || m.hasDeltaRev || m.tags?.includes('DELTA_REV') || m.label?.includes('★Δ'));

    const updatedOverrides = {
      ...(representative.overrides || {}),
      linecolor: domStyle.color,
      linewidth: hasDelta ? Math.max(domStyle.width, 3) : domStyle.width,
      textcolor: domStyle.color,
      text: synthLabel,
      showPrice: true,
      showLabel: true
    };

    result.push({
      ...representative,
      timeframe: domStyle.timeframe,
      label: synthLabel,
      tags: mergedTags,
      confluence_count: cluster.length,
      confluence_timeframes: mergedConfluenceTfs,
      confluence_reasons: mergedConfluenceReasons,
      overrides: updatedOverrides
    });
  }

  return result;
}

/**
 * Format brief note timestamp in UTC+8 (e.g. "15/9, 8.00am", "15/9, 12.00pm").
 */
export function formatBriefTimestamp(nowSec = Math.floor(Date.now() / 1000)) {
  const d = new Date(nowSec * 1000);
  const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
  const day = utc8.getUTCDate();
  const month = utc8.getUTCMonth() + 1;
  const rawHour = utc8.getUTCHours();
  const minutes = String(utc8.getUTCMinutes()).padStart(2, '0');
  const period = rawHour >= 12 ? 'pm' : 'am';
  const hour12 = rawHour % 12 === 0 ? 12 : rawHour % 12;
  return `${day}/${month}, ${hour12}.${minutes}${period}`;
}

/**
 * Pure SNR map builder.
 * Builds immutable snr-map.v1 payload.
 */
export function buildSnrMap({
  nowSec = Math.floor(Date.now() / 1000),
  quote,
  frames = {},
  deltaLabels = [],
  deltaSignals = []
} = {}) {
  const quotePrice = typeof quote === 'number'
    ? quote
    : (quote?.price || quote?.last || quote?.close);

  if (quotePrice == null || !Number.isFinite(quotePrice)) {
    throw new Error('Valid quote price is required for SNR map building');
  }

  const rawEntities = [];
  // Configured scan windows:
  // - Weekly: +/- 200 pt (macro corridor)
  // - Daily:  +/- 100 pt (swing structure)
  // - H4/H1:  aligned with Daily +/- 100 pt (with buffer for macro confluence)
  const scanDailyMin = quotePrice - 100.0;
  const scanDailyMax = quotePrice + 100.0;
  const scanWeeklyMin = quotePrice - 200.0;
  const scanWeeklyMax = quotePrice + 200.0;

  const wBars = frames.W?.bars || frames.W || [];
  const dBars = frames.D?.bars || frames.D || [];
  const h4Bars = frames.H4?.bars || frames.H4 || [];
  const h1Bars = frames.H1?.bars || frames.H1 || [];

  const closedWBars = getClosedBars(wBars);
  const closedDBars = getClosedBars(dBars);
  const closedH4Bars = getClosedBars(h4Bars);
  const closedH1Bars = getClosedBars(h1Bars);

  // Compile unified Delta signals (plotshape arrows + indicator labels)
  const allDeltaPoints = [];
  const parsedLabels = parseDeltaLabels(deltaLabels);
  for (const d of parsedLabels) {
    if (d.price != null && Number.isFinite(d.price) && d.time != null && Number.isFinite(d.time)) {
      allDeltaPoints.push({
        time: d.time,
        price: d.price,
        type: d.tags?.includes('BULL') ? 'Buy' : 'Sell',
        isBull: d.tags?.includes('BULL'),
        isBear: d.tags?.includes('BEAR'),
        source: 'label'
      });
    }
  }
  if (Array.isArray(deltaSignals)) {
    for (const s of deltaSignals) {
      if (s.price != null && Number.isFinite(s.price) && s.time != null && Number.isFinite(s.time)) {
        const isBull = !!(s.isBull || s.type === 'BULL' || s.type === 'Buy');
        allDeltaPoints.push({
          time: s.time,
          price: s.price,
          type: isBull ? 'Buy' : 'Sell',
          isBull,
          isBear: !isBull,
          timeframe: s.timeframe,
          source: 'plot'
        });
      }
    }
  }

  function matchDeltaConfirmation(targetPrice, targetTime, tolerance = 3.5) {
    if (targetPrice == null || !Number.isFinite(targetPrice)) return { matched: false, delta: null };
    for (const dp of allDeltaPoints) {
      const priceDiff = Math.abs(dp.price - targetPrice);
      const timeDiff = (targetTime != null && Number.isFinite(targetTime) && Number.isFinite(dp.time))
        ? Math.abs(dp.time - targetTime)
        : Infinity;
      if (priceDiff <= tolerance || timeDiff <= 300) {
        return { matched: true, delta: dp };
      }
    }
    return { matched: false, delta: null };
  }

  // Compute Weekly Zone Boundaries (Macro corridor from recent closed weekly bars within +/- 200 pt)
  let weeklyZoneMin = scanWeeklyMin;
  let weeklyZoneMax = scanWeeklyMax;
  if (closedWBars.length > 0) {
    const recentWBars = closedWBars.slice(-12);
    const wLows = recentWBars.map(b => b.low).filter(p => p != null && Number.isFinite(p) && p >= scanWeeklyMin - 15 && p <= scanWeeklyMax + 15);
    const wHighs = recentWBars.map(b => b.high).filter(p => p != null && Number.isFinite(p) && p >= scanWeeklyMin - 15 && p <= scanWeeklyMax + 15);
    if (wLows.length > 0 && wHighs.length > 0) {
      weeklyZoneMin = Math.min(...wLows);
      weeklyZoneMax = Math.max(...wHighs);
    }
  }

  // 1. Weekly Pivots (Strict +/- 200 window, closed bars only - no forced draw if no evidence)
  const wPivots = detectPivots(wBars, 2, 2, scanWeeklyMin, scanWeeklyMax);
  if (wPivots.length > 0) {
    const pPrices = wPivots.map(p => p.price);
    weeklyZoneMin = Math.min(weeklyZoneMin, ...pPrices);
    weeklyZoneMax = Math.max(weeklyZoneMax, ...pPrices);
  }
  weeklyZoneMin = Math.max(scanWeeklyMin - 10, weeklyZoneMin);
  weeklyZoneMax = Math.min(scanWeeklyMax + 10, weeklyZoneMax);

  function isInsideWeeklyZone(price) {
    return price >= (weeklyZoneMin - 2.0) && price <= (weeklyZoneMax + 2.0);
  }

  for (const wp of wPivots) {
    if (wp.time == null || !Number.isFinite(wp.time)) continue;
    const sbrRbs = detectSbrRbs(wp, closedWBars);
    const deltaMatch = matchDeltaConfirmation(wp.price, wp.time);
    const tags = ['W', sbrRbs.action, 'WEEKLY_ZONE'];
    if (deltaMatch.matched) tags.push('DELTA_CONFIRMED');

    const label = `[W - ${sbrRbs.action} @ ${wp.price.toFixed(2)}] (AI)`;
    rawEntities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: wp.price,
      timeframe: 'W',
      reason: sbrRbs.action,
      tags,
      hasDeltaRev: deltaMatch.matched,
      deltaType: deltaMatch.matched ? deltaMatch.delta.type : null,
      inWeeklyZone: true,
      point: { time: wp.time, price: wp.price },
      label,
      overrides: {
        linecolor: STYLES.W.color,
        linewidth: deltaMatch.matched ? 3 : STYLES.W.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.W.color
      }
    });
  }

  // 2. Daily Pivots (Strict +/- 100 window, closed bars only - no forced draw if no evidence)
  const dPivots = detectPivots(dBars, 3, 3, scanDailyMin, scanDailyMax);
  for (const dp of dPivots) {
    if (dp.time == null || !Number.isFinite(dp.time)) continue;
    if (rawEntities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - dp.price) <= 2.0)) continue;
    const sbrRbs = detectSbrRbs(dp, closedDBars);
    const deltaMatch = matchDeltaConfirmation(dp.price, dp.time);
    const inWeekly = isInsideWeeklyZone(dp.price);
    const tags = ['D', sbrRbs.action];
    if (inWeekly) tags.push('WEEKLY_ZONE');
    if (deltaMatch.matched) tags.push('DELTA_CONFIRMED');
    if (dp.isSharp) tags.push('V角');
    if (dp.is2B) tags.push('2B');

    const vTag = dp.isSharp ? ' (V角)' : '';
    const label = `[D - ${sbrRbs.action}${vTag} @ ${dp.price.toFixed(2)}] (AI)`;
    rawEntities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: dp.price,
      timeframe: 'D',
      reason: sbrRbs.action,
      tags,
      hasDeltaRev: deltaMatch.matched,
      deltaType: deltaMatch.matched ? deltaMatch.delta.type : null,
      inWeeklyZone: inWeekly,
      point: { time: dp.time, price: dp.price },
      label,
      overrides: {
        linecolor: STYLES.D.color,
        linewidth: deltaMatch.matched ? 3 : STYLES.D.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.D.color
      }
    });
  }

  // 3. H4 Pivots & Structural Elements (Lookback up to 21 days; prioritize SBR/RBS inside Weekly Zone & Delta confirmations)
  const h4LookbackSec = nowSec - 21 * 86400;
  const rawH4Pivots = detectPivots(h4Bars, 3, 3, scanDailyMin - 20, scanDailyMax + 20)
    .filter(p => p.time != null && Number.isFinite(p.time) && p.time >= h4LookbackSec);

  const scoredH4 = rawH4Pivots.map(p => {
    const sbrRbs = detectSbrRbs(p, closedH4Bars);
    const inWeekly = isInsideWeeklyZone(p.price);
    const deltaMatch = matchDeltaConfirmation(p.price, p.time);
    const isSbrRbs = sbrRbs.action === 'RBS' || sbrRbs.action === 'SBR';

    let score = 0;
    if (isSbrRbs) score += 100;
    if (inWeekly && isSbrRbs) score += 80;
    else if (inWeekly) score += 30;
    if (deltaMatch.matched) score += 150;
    if (p.isSharp) score += 20;
    if (p.is2B) score += 20;
    score += (p.time - h4LookbackSec) / (21 * 86400) * 10;

    return { pivot: p, sbrRbs, inWeekly, deltaMatch, score };
  });

  scoredH4.sort((a, b) => b.score - a.score);

  const selectedH4 = [];
  for (const cand of scoredH4) {
    const p = cand.pivot;
    if (rawEntities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - p.price) <= 2.0)) continue;
    if (selectedH4.some(s => Math.abs(s.pivot.price - p.price) <= 2.0)) continue;
    selectedH4.push(cand);
    if (selectedH4.length >= 6) break;
  }

  for (const item of selectedH4) {
    const { pivot: h4p, sbrRbs, inWeekly, deltaMatch } = item;
    const tags = ['H4', sbrRbs.action];
    if (inWeekly) tags.push('WEEKLY_ZONE');
    if (deltaMatch.matched) tags.push('DELTA_CONFIRMED');
    if (h4p.isSharp) tags.push('V角');
    if (h4p.is2B) tags.push('2B');

    const label = `[H4 - ${sbrRbs.action} @ ${h4p.price.toFixed(2)}] (AI)`;
    rawEntities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: h4p.price,
      timeframe: 'H4',
      reason: sbrRbs.action,
      tags,
      hasDeltaRev: deltaMatch.matched,
      deltaType: deltaMatch.matched ? deltaMatch.delta.type : null,
      inWeeklyZone: inWeekly,
      point: { time: h4p.time, price: h4p.price },
      label,
      overrides: {
        linecolor: STYLES.H4.color,
        linewidth: deltaMatch.matched ? 3 : STYLES.H4.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.H4.color
      }
    });
  }
  const h4Pivots = rawH4Pivots;

  // 4. H1 Pivots (Lookback up to 14 days; prioritize SBR/RBS inside Weekly Zone & Delta confirmations)
  const h1LookbackSec = nowSec - 14 * 86400;
  const rawH1Pivots = detectPivots(h1Bars, 3, 3, scanDailyMin - 15, scanDailyMax + 15)
    .filter(p => p.time != null && Number.isFinite(p.time) && p.time >= h1LookbackSec);

  const scoredH1 = rawH1Pivots.map(p => {
    const sbrRbs = detectSbrRbs(p, closedH1Bars);
    const inWeekly = isInsideWeeklyZone(p.price);
    const deltaMatch = matchDeltaConfirmation(p.price, p.time);
    const isSbrRbs = sbrRbs.action === 'RBS' || sbrRbs.action === 'SBR';

    let score = 0;
    if (isSbrRbs) score += 100;
    if (inWeekly && isSbrRbs) score += 80;
    else if (inWeekly) score += 30;
    if (deltaMatch.matched) score += 150;
    if (p.isSharp) score += 20;
    if (p.is2B) score += 20;
    score += (p.time - h1LookbackSec) / (14 * 86400) * 10;

    return { pivot: p, sbrRbs, inWeekly, deltaMatch, score };
  });

  scoredH1.sort((a, b) => b.score - a.score);

  const selectedH1 = [];
  for (const cand of scoredH1) {
    const p = cand.pivot;
    if (rawEntities.some(e => e.kind === 'horizontal_line' && Math.abs(e.price - p.price) <= 2.0)) continue;
    if (selectedH1.some(s => Math.abs(s.pivot.price - p.price) <= 2.0)) continue;
    selectedH1.push(cand);
    if (selectedH1.length >= 6) break;
  }

  for (const item of selectedH1) {
    const { pivot: h1p, sbrRbs, inWeekly, deltaMatch } = item;
    const tags = ['H1', sbrRbs.action];
    if (inWeekly) tags.push('WEEKLY_ZONE');
    if (deltaMatch.matched) tags.push('DELTA_CONFIRMED');
    if (h1p.isSharp) tags.push('V角');
    if (h1p.is2B) tags.push('2B');

    const label = `[H1 - ${sbrRbs.action} @ ${h1p.price.toFixed(2)}] (AI)`;
    rawEntities.push({
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: h1p.price,
      timeframe: 'H1',
      reason: sbrRbs.action,
      tags,
      hasDeltaRev: deltaMatch.matched,
      deltaType: deltaMatch.matched ? deltaMatch.delta.type : null,
      inWeeklyZone: inWeekly,
      point: { time: h1p.time, price: h1p.price },
      label,
      overrides: {
        linecolor: STYLES.H1.color,
        linewidth: deltaMatch.matched ? 3 : STYLES.H1.width,
        linestyle: 0,
        showPrice: true,
        showLabel: true,
        textcolor: STYLES.H1.color
      }
    });
  }
  const h1Pivots = rawH1Pivots;

  // 5. Engulfing checks across closed bars (EB / ES) - Drawing coordinates use ONLY closed bar close
  for (const { tf, bars } of [
    { tf: 'H1', bars: closedH1Bars },
    { tf: 'H4', bars: closedH4Bars },
    { tf: 'D', bars: closedDBars }
  ]) {
    if (bars.length >= 2) {
      const prevBar = bars[bars.length - 2];
      const currBar = bars[bars.length - 1];
      if (currBar?.time == null || !Number.isFinite(currBar.time) || currBar.close == null || !Number.isFinite(currBar.close)) continue;
      const type = detectEngulfing(prevBar, currBar);
      if (type) {
        const price = Number(currBar.close.toFixed(2));
        const extremePrice = Number((type === 'EB' ? (currBar.low ?? currBar.close) : (currBar.high ?? currBar.close)).toFixed(2));
        const deltaMatch = matchDeltaConfirmation(price, currBar.time);
        const inWeekly = isInsideWeeklyZone(price);
        const tags = [tf, type, 'ENGULFING'];
        if (inWeekly) tags.push('WEEKLY_ZONE');
        if (deltaMatch.matched) tags.push('DELTA_CONFIRMED');

        const label = `[${tf} - ${type} @ ${price.toFixed(2)}] (AI)`;
        rawEntities.push({
          kind: 'horizontal_line',
          shape: 'horizontal_line',
          price,
          timeframe: tf,
          reason: type,
          tags,
          hasDeltaRev: deltaMatch.matched,
          deltaType: deltaMatch.matched ? deltaMatch.delta.type : null,
          inWeeklyZone: inWeekly,
          point: { time: currBar.time, price },
          extremePrice,
          label,
          overrides: {
            linecolor: STYLES[tf]?.color || STYLES.H1.color,
            linewidth: deltaMatch.matched ? 3 : (STYLES[tf]?.width || STYLES.H1.width),
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
    rawEntities.push(tl);
  }

  // 7. Real Ranges / Boxes (Enforce max width 20 points) & 50% Equilibrium Line
  const ranges = detectRanges(h4Bars);
  for (const r of ranges) {
    let rect = { ...r };
    if (rect.high - rect.low > 20.0) {
      const eq = rect.equilibrium ?? Number(((rect.high + rect.low) / 2).toFixed(2));
      rect.high = Number((eq + 10.0).toFixed(2));
      rect.low = Number((eq - 10.0).toFixed(2));
      rect.point = { ...rect.point, price: rect.high };
      rect.point2 = { ...rect.point2, price: rect.low };
      rect.label = `[Range ${rect.low.toFixed(1)} - ${rect.high.toFixed(1)} | Eq ${eq.toFixed(1)}] (AI)`;
    }
    rawEntities.push(rect);
    if (
      rect.equilibrium != null &&
      Number.isFinite(rect.equilibrium) &&
      rect.point?.time != null &&
      Number.isFinite(rect.point.time)
    ) {
      const eqPrice = Number(rect.equilibrium.toFixed(2));
      const eqLabel = `[Range 50% Eq @ ${eqPrice.toFixed(2)}] (AI)`;
      rawEntities.push({
        kind: 'horizontal_line',
        shape: 'horizontal_line',
        price: eqPrice,
        timeframe: 'H4',
        reason: 'RANGE_EQ',
        tags: ['RANGE_EQ', 'RANGE', 'EQUILIBRIUM'],
        point: { time: rect.point.time, price: eqPrice },
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

  // 8. Real Delta Volume Reversal Finder labels & plot signals (within Daily +/- 100 pt window)
  const deltaEntities = parseDeltaLabels(deltaLabels);
  for (const d of deltaEntities) {
    if (d.price >= scanDailyMin && d.price <= scanDailyMax) {
      rawEntities.push({
        ...d,
        point: { time: d.time, price: d.price }
      });
    }
  }
  if (Array.isArray(deltaSignals)) {
    for (const ds of deltaSignals) {
      if (ds.price != null && Number.isFinite(ds.price) && ds.time != null && Number.isFinite(ds.time)) {
        if (ds.price < scanDailyMin || ds.price > scanDailyMax) continue;
        const isBull = !!(ds.isBull || ds.type === 'BULL' || ds.type === 'Buy');
        const labelType = isBull ? 'Delta BuyRev' : 'Delta SellRev';
        const price = Number(ds.price.toFixed(2));
        if (!rawEntities.some(e => Math.abs(e.price - price) <= 1.5 && (e.reason === 'DELTA_REV' || e.tags?.includes('DELTA_REV')))) {
          rawEntities.push({
            kind: 'horizontal_line',
            shape: 'horizontal_line',
            price,
            time: ds.time,
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
            },
            point: { time: ds.time, price }
          });
        }
      }
    }
  }

  // 9. Final deterministic global horizontal-line canonical dedup/clustering pass with a 2.0 price-point threshold
  const nonHorizontal = rawEntities.filter(e => e.kind !== 'horizontal_line');
  const horizontal = rawEntities.filter(e => e.kind === 'horizontal_line');
  const clusteredHorizontal = clusterHorizontalLines(horizontal, 2.0);
  let entities = [...nonHorizontal, ...clusteredHorizontal];

  // 10. Generate compact note ONLY if evidence exists - starting with [📌 XAUUSD AI Brief] (AI)
  let note = null;
  if (entities.length > 0) {
    const anchor = entities.find(e => e.point && Number.isFinite(e.point.time) && Number.isFinite(e.point.price));
    if (anchor) {
      // Keep the note at the current chart edge while retaining an evidence-backed price.
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

      // Check for high-confluence or delta-confirmed levels to highlight in the brief
      const deltaConfirmed = entities.filter(e => e.tags?.includes('DELTA_CONFIRMED') || e.hasDeltaRev);
      if (deltaConfirmed.length > 0) {
        const topDelta = deltaConfirmed[0];
        const tf = topDelta.timeframe || 'MTF';
        const act = topDelta.reason || 'SBR/RBS';
        const dType = topDelta.deltaType ? `★Δ-${topDelta.deltaType}` : '★Δ-Rev';
        if (tf === 'H4') {
          h4Structure += ` [${act} ${dType}]`;
        } else {
          h1Direction += ` [${act} ${dType}]`;
        }
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

      const timeStr = formatBriefTimestamp(nowSec);
      const noteHeader = `[📌 XAUUSD AI Brief (${timeStr})] (AI)`;
      const noteLines = [noteHeader, dailyRegime, h4Structure, h1Direction, condStatement];
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

  // The brief is appended after the first clustering pass. Canonicalize once
  // more at the serialization boundary so no future entity construction can
  // leak a sub-2-point horizontal pair into the persisted receipt.
  entities = [
    ...entities.filter(e => e.kind !== 'horizontal_line'),
    ...clusterHorizontalLines(entities.filter(e => e.kind === 'horizontal_line'), 2.0)
  ];

  const manifest_hash = hashSnrMapEntities({
    generated_at_sec: nowSec,
    quote_price: quotePrice,
    entities
  });

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
