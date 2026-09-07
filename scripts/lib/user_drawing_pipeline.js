/**
 * user_drawing_pipeline.js
 * Pure, offline, versioned user-drawing normalization & alignment diagnostics.
 *
 * Requirements:
 * - Deterministic SHA-256 snapshot ID via stable canonical JSON.
 * - Normalized drawing geometry, styles, conservative tag grammar, and structured errors.
 * - Bounded lifecycle state-machine against closed bars up to asOfUtc.
 * - Interval distance and ATR-relative zone alignment.
 */

import crypto from 'node:crypto';

export const SCHEMA_VERSION = 'drawing_snapshot.v1';
export const PARSER_VERSION = 'tag_parser.v1';

/**
 * Structured pipeline error generator.
 */
export function createPipelineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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
 * Compute deterministic SHA-256 snapshot ID from canonical payload.
 */
export function computeSnapshotId(payloadWithoutSnapshotId) {
  const canonical = canonicalizeJson(payloadWithoutSnapshotId);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Conservative tag parser: recognizes ONLY standard structural tokens.
 * Never classifies arbitrary narrative text.
 */
const RECOGNIZED_TAG_PATTERNS = [
  { tag: 'liquidity sweep', regex: /\bliquidity\s+sweep\b/i },
  { tag: 'BOS', regex: /\bBOS\b/i },
  { tag: 'CHOCH', regex: /\bCHOCH\b/i },
  { tag: 'SBR', regex: /\bSBR\b/i },
  { tag: 'RBS', regex: /\bRBS\b/i },
  { tag: 'POI', regex: /\bPOI\b/i },
  { tag: 'SSL', regex: /\bSSL\b/i },
  { tag: 'BSL', regex: /\bBSL\b/i },
];

export function parseTags(text) {
  if (!text || typeof text !== 'string') return [];
  const matched = [];
  for (const { tag, regex } of RECOGNIZED_TAG_PATTERNS) {
    if (regex.test(text)) {
      matched.push(tag);
    }
  }
  return matched;
}

/**
 * Normalize drawing kind to supported vocabulary.
 */
export function normalizeKind(rawKind, rawName) {
  const k = (rawKind || '').toLowerCase().trim();
  const n = (rawName || '').toLowerCase().trim();
  const tokens = `${k} ${n}`;

  if (tokens.includes('fib') || tokens.includes('retracement') || tokens.includes('extension')) {
    if (tokens.includes('extension')) return 'fib_extension';
    return 'fib_retracement';
  }
  if (tokens.includes('rect') || tokens.includes('box') || tokens.includes('linetoolrectangle')) {
    return 'rectangle';
  }
  if (/\bray\b/.test(tokens) || tokens.includes('linetoolray') || tokens.includes('linetoolhorizray')) {
    return 'ray';
  }
  if (
    /\btrend_?line\b/.test(tokens) ||
    tokens.includes('linetooltrendline') ||
    tokens.includes('horizontal_line') ||
    tokens.includes('vertical_line') ||
    tokens.includes('linetoolhorizline') ||
    tokens.includes('linetoolvertline') ||
    /\bline\b/.test(tokens)
  ) {
    return 'trend_line';
  }
  if (
    /\btext\b/.test(tokens) ||
    /\blabel\b/.test(tokens) ||
    /\bcallout\b/.test(tokens) ||
    /\bnote\b/.test(tokens) ||
    tokens.includes('linetooltext') ||
    tokens.includes('linetoollabel')
  ) {
    return 'text';
  }
  return 'unknown';
}

/**
 * Normalize individual anchor coordinate with strict timestamp & price validation.
 */
export function normalizeAnchor(pt, index, errors) {
  const rawIndex = pt?.index !== undefined && pt?.index !== null && Number.isFinite(Number(pt.index)) ? Number(pt.index) : null;
  const rawPrice = pt?.price !== undefined && pt?.price !== null && Number.isFinite(Number(pt.price)) ? Number(pt.price) : null;
  const rawTime = pt?.time !== undefined && pt?.time !== null ? pt.time : (pt?.time_t !== undefined ? pt.time_t : null);

  let timeUtc = null;
  if (rawTime !== null && rawTime !== undefined) {
    const numTime = Number(rawTime);
    if (Number.isFinite(numTime) && numTime > 0) {
      const ms = numTime > 1e11 ? numTime : numTime * 1000;
      try {
        const d = new Date(ms);
        if (!isNaN(d.getTime())) {
          timeUtc = d.toISOString();
        }
      } catch (e) {}
    } else if (typeof rawTime === 'string') {
      const d = new Date(rawTime);
      if (!isNaN(d.getTime())) {
        timeUtc = d.toISOString();
      }
    }
  }

  if (rawPrice === null) {
    errors.push({
      code: 'INVALID_ANCHOR_PRICE',
      message: `Anchor at point index ${index} has missing or non-finite price`,
      field: `points[${index}].price`
    });
  }

  if (rawTime === null || timeUtc === null) {
    errors.push({
      code: 'INVALID_ANCHOR_TIME',
      message: `Anchor at point index ${index} has missing or unconvertible timestamp`,
      field: `points[${index}].time`
    });
  }

  return {
    index: rawIndex,
    price: rawPrice,
    time: rawTime !== null && rawTime !== undefined && Number.isFinite(Number(rawTime)) ? Number(rawTime) : rawTime,
    time_utc: timeUtc
  };
}

/**
 * Normalize single drawing structure.
 */
export function normalizeDrawing(rawDrawing) {
  const errors = [];
  const sourceId = String(rawDrawing?.id || rawDrawing?.source_id || rawDrawing?.entity_id || '');
  const kind = normalizeKind(rawDrawing?.type || rawDrawing?.kind, rawDrawing?.name);

  const rawPoints = rawDrawing?.points || rawDrawing?.anchors || rawDrawing?.coordinates || [];
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
    errors.push({
      code: 'MISSING_ANCHORS',
      message: 'Drawing has no anchor points',
      field: 'points'
    });
  }

  const anchors = Array.isArray(rawPoints) ? rawPoints.map((pt, i) => normalizeAnchor(pt, i, errors)) : [];

  const validPrices = anchors.map(a => a.price).filter(p => p !== null && Number.isFinite(p));
  let priceBounds = null;
  if (validPrices.length > 0 && errors.length === 0) {
    priceBounds = {
      low: Math.min(...validPrices),
      high: Math.max(...validPrices)
    };
  }

  const validTimes = anchors.map(a => a.time).filter(t => t !== null && Number.isFinite(t));
  let timeBounds = null;
  if (validTimes.length > 0) {
    const minTime = Math.min(...validTimes);
    const maxTime = Math.max(...validTimes);
    const minAnchor = anchors.find(a => a.time === minTime);
    const maxAnchor = anchors.find(a => a.time === maxTime);
    timeBounds = {
      start_time: minTime,
      end_time: maxTime,
      start_time_utc: minAnchor?.time_utc || null,
      end_time_utc: maxAnchor?.time_utc || null
    };
  }

  const rawText = rawDrawing?.text || rawDrawing?.annotation?.raw_text || rawDrawing?.properties?.text || '';
  const normalizedText = typeof rawText === 'string' ? rawText.trim() : '';
  const tags = parseTags(normalizedText);

  const style = {
    color: rawDrawing?.color || rawDrawing?.properties?.color || null,
    linecolor: rawDrawing?.linecolor || rawDrawing?.properties?.linecolor || null,
    backgroundColor: rawDrawing?.backgroundColor || rawDrawing?.properties?.backgroundColor || null,
    linewidth: rawDrawing?.linewidth || rawDrawing?.properties?.linewidth || null,
    linestyle: rawDrawing?.linestyle || rawDrawing?.properties?.linestyle || null,
    fontsize: rawDrawing?.fontsize || rawDrawing?.properties?.fontsize || rawDrawing?.properties?.fontSize || null
  };

  const geometry = {
    anchors,
    price_bounds: priceBounds,
    time_bounds: timeBounds
  };

  if (kind.startsWith('fib')) {
    const fibLevels = {};
    const rawLevels = rawDrawing?.properties?.levels || rawDrawing?.levels || [];
    if (Array.isArray(rawLevels)) {
      for (const lvl of rawLevels) {
        if (lvl && lvl.coeff !== undefined && lvl.coeff !== null && lvl.price !== undefined && lvl.price !== null) {
          const numPrice = Number(lvl.price);
          if (Number.isFinite(numPrice)) {
            fibLevels[String(lvl.coeff)] = numPrice;
          }
        }
      }
    }
    const recognizedGolden = [0.5, 0.618, 0.786];
    const goldenLevelsPresent = recognizedGolden.filter(g => {
      if (Array.isArray(rawLevels)) {
        return rawLevels.some(l => l && Number(l.coeff) === g && Number.isFinite(Number(l.price)));
      }
      return false;
    });

    geometry.fib_levels = fibLevels;
    geometry.golden_levels_present = goldenLevelsPresent;
  }

  const sourceStatus = errors.length === 0 ? 'valid' : 'malformed';

  return {
    source_id: sourceId,
    kind,
    provenance: {
      ownership: 'UNCLASSIFIED'
    },
    geometry,
    style,
    annotation: {
      raw_text: rawText,
      normalized_text: normalizedText,
      tags,
      parser_version: PARSER_VERSION
    },
    source_status: sourceStatus,
    errors
  };
}

/**
 * Normalize complete drawing snapshot.
 */
export function normalizeDrawingSnapshot(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    throw createPipelineError('ERR_INVALID_PAYLOAD', 'Raw snapshot payload must be a non-null object');
  }

  // Symbol validation
  const symbol = options.chart?.symbol || raw.chart?.symbol || raw.symbol;
  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    throw createPipelineError('ERR_MISSING_SYMBOL', 'Chart symbol is required and must be a non-empty string');
  }

  // Timeframe
  const timeframe = String(options.chart?.timeframe || raw.chart?.timeframe || raw.timeframe || '60');

  // Timezone validation
  const rawTimezone = options.chart?.timezone || raw.chart?.timezone || raw.timezone;
  if (!rawTimezone || typeof rawTimezone !== 'string' || rawTimezone.trim() === '') {
    throw createPipelineError('ERR_MISSING_TIMEZONE', 'Chart timezone is required and must be a non-empty string');
  }
  const timezone = rawTimezone.trim();

  // Visible Range
  const visibleRange = options.chart?.visible_range || raw.chart?.visible_range || raw.visible_range || null;

  // Captured at UTC
  const rawCapturedAt = options.capturedAtUtc || raw.captured_at_utc || raw.capturedAtUtc || raw.timestamp;
  let capturedAtUtc = null;
  if (rawCapturedAt) {
    const d = new Date(rawCapturedAt);
    if (isNaN(d.getTime())) {
      throw createPipelineError('ERR_INVALID_CAPTURED_AT', `Invalid capturedAtUtc value: ${rawCapturedAt}`);
    }
    capturedAtUtc = d.toISOString();
  } else {
    throw createPipelineError('ERR_MISSING_CAPTURED_AT', 'captured_at_utc is required in snapshot options or raw payload');
  }

  // Source Model Version
  const sourceModelVersion = options.sourceModelVersion || raw.source_model_version || raw.sourceModelVersion;
  if (!sourceModelVersion || typeof sourceModelVersion !== 'string' || sourceModelVersion.trim() === '') {
    throw createPipelineError('ERR_MISSING_SOURCE_MODEL_VERSION', 'source_model_version is required and must be a non-empty string');
  }

  const rawDrawings = raw.drawings || raw.userDrawings || raw.shapes || (Array.isArray(raw) ? raw : []);
  const normalizedDrawings = rawDrawings.map(normalizeDrawing);

  const payloadWithoutSnapshotId = {
    schema_version: SCHEMA_VERSION,
    captured_at_utc: capturedAtUtc,
    chart: {
      symbol: symbol.trim(),
      timeframe,
      timezone,
      visible_range: visibleRange ? {
        from: visibleRange.from !== undefined ? visibleRange.from : null,
        to: visibleRange.to !== undefined ? visibleRange.to : null
      } : null
    },
    source_model_version: sourceModelVersion.trim(),
    drawings: normalizedDrawings
  };

  const snapshotId = computeSnapshotId(payloadWithoutSnapshotId);

  return {
    schema_version: SCHEMA_VERSION,
    snapshot_id: snapshotId,
    captured_at_utc: capturedAtUtc,
    chart: payloadWithoutSnapshotId.chart,
    source_model_version: payloadWithoutSnapshotId.source_model_version,
    drawings: normalizedDrawings
  };
}

/**
 * 1D closed interval distance calculation.
 * Returns 0 if intervals touch or overlap, otherwise positive Euclidean separation.
 */
export function intervalDistance(aLow, aHigh, bLow, bHigh) {
  if (
    typeof aLow !== 'number' || !Number.isFinite(aLow) ||
    typeof aHigh !== 'number' || !Number.isFinite(aHigh) ||
    typeof bLow !== 'number' || !Number.isFinite(bLow) ||
    typeof bHigh !== 'number' || !Number.isFinite(bHigh)
  ) {
    throw new TypeError('All interval bounds must be finite numbers');
  }

  const aMin = Math.min(aLow, aHigh);
  const aMax = Math.max(aLow, aHigh);
  const bMin = Math.min(bLow, bHigh);
  const bMax = Math.max(bLow, bHigh);

  if (aMax >= bMin && bMax >= aMin) {
    return 0;
  }
  if (aMax < bMin) {
    return bMin - aMax;
  }
  return aMin - bMax;
}

/**
 * Align drawing price bounds to reference zone relative to ATR and epsilon.
 */
export function alignDrawingToZone(drawing, zone, { atr, epsilon } = {}) {
  if (atr === undefined || atr === null || typeof atr !== 'number' || !Number.isFinite(atr) || atr <= 0) {
    const err = new Error('ATR must be a positive finite number');
    err.code = 'ERR_INVALID_ATR';
    throw err;
  }
  if (epsilon === undefined || epsilon === null || typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0) {
    const err = new Error('Epsilon must be a non-negative finite number');
    err.code = 'ERR_INVALID_EPSILON';
    throw err;
  }

  let dLow, dHigh;
  if (drawing?.geometry?.price_bounds) {
    dLow = drawing.geometry.price_bounds.low;
    dHigh = drawing.geometry.price_bounds.high;
  } else if (drawing?.price_bounds) {
    dLow = drawing.price_bounds.low !== undefined ? drawing.price_bounds.low : drawing.price_bounds.min;
    dHigh = drawing.price_bounds.high !== undefined ? drawing.price_bounds.high : drawing.price_bounds.max;
  } else if (drawing?.low !== undefined && drawing?.high !== undefined) {
    dLow = drawing.low;
    dHigh = drawing.high;
  } else {
    const err = new Error('Drawing must contain valid price bounds');
    err.code = 'ERR_INVALID_DRAWING_GEOMETRY';
    throw err;
  }

  let zLow, zHigh;
  if (Array.isArray(zone) && zone.length >= 2) {
    zLow = zone[0];
    zHigh = zone[1];
  } else if (zone && typeof zone === 'object') {
    zLow = zone.low !== undefined ? zone.low : zone.min;
    zHigh = zone.high !== undefined ? zone.high : zone.max;
  } else {
    const err = new Error('Zone must contain low and high bounds');
    err.code = 'ERR_INVALID_ZONE';
    throw err;
  }

  const dist = intervalDistance(dLow, dHigh, zLow, zHigh);
  const normalizedDist = dist / atr;
  const isAligned = normalizedDist <= epsilon;

  return {
    aligned: isAligned,
    is_aligned: isAligned,
    interval_distance: dist,
    normalized_distance: normalizedDist,
    atr,
    epsilon
  };
}

/**
 * Helper to parse timestamps to Unix seconds.
 */
function parseUtcTimestamp(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 1e11 ? Math.floor(val / 1000) : val;
  }
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    return Math.floor(d.getTime() / 1000);
  }
  return null;
}

/**
 * Time-bounded lifecycle state machine for normalized drawings against closed bars.
 * Returns only: UNKNOWN | UNTOUCHED | TOUCHED | MITIGATED | BROKEN | EXPIRED
 */
export function classifyLifecycle(normalizedDrawing, closedBars, asOfUtc, lifecyclePolicyArg) {
  const policy = lifecyclePolicyArg || normalizedDrawing?.lifecycle_policy;
  if (!policy || typeof policy !== 'object') {
    return 'UNKNOWN';
  }

  const side = (policy.side || '').toLowerCase();
  const invalidation = (policy.invalidation || policy.invalidation_rule || '').toLowerCase();

  if (!['buy', 'bullish', 'long', 'sell', 'bearish', 'short'].includes(side)) {
    return 'UNKNOWN';
  }
  if (!invalidation) {
    return 'UNKNOWN';
  }

  const bounds = normalizedDrawing?.geometry?.price_bounds;
  if (!bounds || bounds.low === null || bounds.high === null || !Number.isFinite(bounds.low) || !Number.isFinite(bounds.high)) {
    return 'UNKNOWN';
  }

  const low = Math.min(bounds.low, bounds.high);
  const high = Math.max(bounds.low, bounds.high);

  const asOfTs = parseUtcTimestamp(asOfUtc);
  if (asOfTs === null) {
    return 'UNKNOWN';
  }

  if (!Array.isArray(closedBars) || closedBars.length === 0) {
    return 'UNTOUCHED';
  }

  // Filter closed bars at or before asOfUtc
  const eligibleBars = closedBars.filter(bar => {
    const bTime = parseUtcTimestamp(bar.time || bar.time_utc || bar.timestamp);
    return bTime !== null && bTime <= asOfTs;
  });

  if (eligibleBars.length === 0) {
    return 'UNTOUCHED';
  }

  let state = 'UNTOUCHED';
  const isBullish = ['buy', 'bullish', 'long'].includes(side);

  for (const bar of eligibleBars) {
    const o = Number(bar.open);
    const h = Number(bar.high);
    const l = Number(bar.low);
    const c = Number(bar.close);

    if (isBullish) {
      // Invalidation check (BROKEN)
      if (invalidation === 'close_beyond' && c < low) {
        return 'BROKEN';
      }
      if (invalidation === 'wick_beyond' && l < low) {
        return 'BROKEN';
      }

      // Interaction check
      if (l <= high && h >= low) {
        if (policy.mitigation === 'penetrate_50') {
          const mid = (low + high) / 2;
          if (l <= mid) {
            state = 'MITIGATED';
          } else if (state !== 'MITIGATED') {
            state = 'TOUCHED';
          }
        } else if (policy.mitigation === 'touch') {
          state = 'MITIGATED';
        } else if (state !== 'MITIGATED') {
          state = 'TOUCHED';
        }
      }
    } else {
      // Bearish
      if (invalidation === 'close_beyond' && c > high) {
        return 'BROKEN';
      }
      if (invalidation === 'wick_beyond' && h > high) {
        return 'BROKEN';
      }

      if (h >= low && l <= high) {
        if (policy.mitigation === 'penetrate_50') {
          const mid = (low + high) / 2;
          if (h >= mid) {
            state = 'MITIGATED';
          } else if (state !== 'MITIGATED') {
            state = 'TOUCHED';
          }
        } else if (policy.mitigation === 'touch') {
          state = 'MITIGATED';
        } else if (state !== 'MITIGATED') {
          state = 'TOUCHED';
        }
      }
    }
  }

  return state;
}
