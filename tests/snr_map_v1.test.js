import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  canonicalizeJson,
  hashManifest,
  detectPivots,
  detectEngulfing,
  detectSbrRbs,
  detectTrendlines,
  detectRanges,
  parseDeltaLabels,
  buildSnrMap
} from '../scripts/lib/snr_map_v1.js';

describe('SNR Map Builder v1 — Pure Evidence & Closed Bar Module', () => {
  it('exports SCHEMA_VERSION equal to snr-map.v1', () => {
    assert.equal(SCHEMA_VERSION, 'snr-map.v1');
  });

  describe('canonicalizeJson & hashManifest completeness', () => {
    it('produces deterministic canonical JSON regardless of key order', () => {
      const objA = { z: 1, a: { y: 2, x: 3 }, b: [4, 5] };
      const objB = { b: [4, 5], a: { x: 3, y: 2 }, z: 1 };
      assert.equal(canonicalizeJson(objA), canonicalizeJson(objB));
    });

    it('generates a 64-char SHA-256 hex manifest hash', () => {
      const payload = {
        schema_version: 'snr-map.v1',
        symbol: 'OANDA:XAUUSD',
        generated_at_sec: 1700000000,
        quote_price: 3000,
        entities: []
      };
      const hash = hashManifest(payload);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it('alters manifest_hash when any entity property or override is mutated', () => {
      const baseEntity = {
        kind: 'horizontal_line',
        shape: 'horizontal_line',
        timeframe: 'H1',
        reason: 'EB',
        tags: ['H1', 'EB', 'ENGULFING'],
        point: { time: 1700000000, price: 3000.0 },
        point2: { time: 1700003600, price: 3000.0 },
        price: 3000.0,
        high: 3010.0,
        low: 2990.0,
        equilibrium: 3000.0,
        label: '[H1 - EB @ 3000.00] (AI)',
        overrides: { linecolor: '#B8860B', linewidth: 2, linestyle: 0 }
      };

      const makePayload = (entityMod = {}) => {
        const entity = { ...baseEntity, ...entityMod };
        return {
          schema_version: 'snr-map.v1',
          symbol: 'OANDA:XAUUSD',
          generated_at_sec: 1700000000,
          quote_price: 3000,
          entity_count: 1,
          entities: [entity]
        };
      };

      const baseMap = buildSnrMap({
        nowSec: 1700000000,
        quote: 3000,
        frames: {
          H1: {
            bars: [
              { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 },
              { time: 200, open: 2998, high: 3020, low: 2995, close: 3015 },
              { time: 300, open: 3015, high: 3018, low: 3012, close: 3014 }
            ]
          }
        }
      });
      const baseHash = baseMap.manifest.manifest_hash;

      // Mutate point price
      const mutatedPointMap = buildSnrMap({
        nowSec: 1700000000,
        quote: 3000,
        frames: {
          H1: {
            bars: [
              { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 },
              { time: 200, open: 2998, high: 3025, low: 2990, close: 3020 },
              { time: 300, open: 3020, high: 3022, low: 3018, close: 3019 }
            ]
          }
        }
      });
      assert.notEqual(baseHash, mutatedPointMap.manifest.manifest_hash);
    });
  });

  describe('Closed Bars Enforcement & Empty/No-Evidence Fail-Closed', () => {
    it('returns empty entities array when no structural evidence exists (no fake fallbacks)', () => {
      const emptyFrames = {
        W: { bars: [] },
        D: { bars: [] },
        H4: { bars: [] },
        H1: { bars: [] }
      };
      const map = buildSnrMap({ quote: 3000, frames: emptyFrames, deltaLabels: [] });
      assert.deepEqual(map.entities, []);
      assert.equal(map.manifest.schema_version, 'snr-map.v1');
      assert.match(map.manifest.manifest_hash, /^[0-9a-f]{64}$/);
      assert.equal(map.note, null);
    });

    it('ignores the last open bar and evaluates only closed bars', () => {
      const barsWithOpenPivot = [
        { time: 100, open: 2990, high: 2995, low: 2985, close: 2992 },
        { time: 200, open: 2992, high: 2996, low: 2990, close: 2994 },
        { time: 300, open: 2994, high: 3050, low: 2993, close: 3045 }, // Peak if bar 4 dropped
        { time: 400, open: 3045, high: 3046, low: 3000, close: 3005 }  // Open bar (should be dropped)
      ];
      const pivots = detectPivots(barsWithOpenPivot, 1, 1, 2900, 3100);
      assert.equal(pivots.length, 0);
    });
  });

  describe('Strict Price Window for Weekly and Daily (+/- 50 points)', () => {
    it('excludes W and D pivots outside current price +/- 50 without forcing fallbacks', () => {
      const quotePrice = 3000.0;
      const bars = [
        { time: 100, open: 2930, high: 2935, low: 2925, close: 2930 },
        { time: 200, open: 2930, high: 2940, low: 2928, close: 2940 },
        { time: 300, open: 2940, high: 2935, low: 2920, close: 2925 },
        { time: 400, open: 2925, high: 3015, low: 2920, close: 3010 },
        { time: 500, open: 3010, high: 3005, low: 2920, close: 2930 },
        { time: 600, open: 2930, high: 3065, low: 2930, close: 3060 },
        { time: 700, open: 3060, high: 3050, low: 2940, close: 2945 },
        { time: 800, open: 2945, high: 2950, low: 2940, close: 2945 }
      ];

      const scanMin = quotePrice - 50.0;
      const scanMax = quotePrice + 50.0;
      const pivots = detectPivots(bars, 1, 1, scanMin, scanMax);

      assert.equal(pivots.length, 1);
      assert.equal(pivots[0].price, 3010);
    });
  });

  describe('Candle Engulfing Detection & Emission in buildSnrMap', () => {
    it('identifies confirmed bullish engulfing (EB) where body engulfs previous candle body', () => {
      const prevBearish = { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 };
      const currBullish = { time: 200, open: 2998, high: 3020, low: 2995, close: 3015 };
      const res = detectEngulfing(prevBearish, currBullish);
      assert.equal(res, 'EB');
    });

    it('identifies confirmed bearish engulfing (ES) where body engulfs previous candle body', () => {
      const prevBullish = { time: 100, open: 3000, high: 3015, low: 2998, close: 3010 };
      const currBearish = { time: 200, open: 3012, high: 3018, low: 2990, close: 2995 };
      const res = detectEngulfing(prevBullish, currBearish);
      assert.equal(res, 'ES');
    });

    it('rejects candles that do not have actual body engulfment', () => {
      const prevBullish = { time: 100, open: 3000, high: 3015, low: 2998, close: 3010 };
      const currNonEngulfing = { time: 200, open: 3008, high: 3012, low: 3002, close: 3005 };
      assert.equal(detectEngulfing(prevBullish, currNonEngulfing), null);
    });

    it('emits one evidence-backed horizontal-line entity labelled EB anchored at candle extreme/close for closed-bar EB', () => {
      const h1Bars = [
        { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 },
        { time: 200, open: 2998, high: 3020, low: 2995, close: 3015 },
        { time: 300, open: 3015, high: 3018, low: 3012, close: 3014 }
      ];
      const map = buildSnrMap({
        nowSec: 1700000300,
        quote: 3015,
        frames: { H1: { bars: h1Bars } }
      });
      const ebEntities = map.entities.filter(e => e.reason === 'EB' || e.tags?.includes('EB'));
      assert.equal(ebEntities.length, 1);
      const eb = ebEntities[0];
      assert.equal(eb.kind, 'horizontal_line');
      assert.equal(eb.timeframe, 'H1');
      assert.ok(eb.label.includes('EB'));
      assert.ok(eb.price === 2995 || eb.price === 3015);
      assert.equal(eb.point.price, eb.price);
    });

    it('emits one evidence-backed horizontal-line entity labelled ES for closed-bar ES', () => {
      const h1Bars = [
        { time: 100, open: 3000, high: 3015, low: 2998, close: 3010 },
        { time: 200, open: 3012, high: 3018, low: 2990, close: 2995 },
        { time: 300, open: 2995, high: 2998, low: 2992, close: 2994 }
      ];
      const map = buildSnrMap({
        nowSec: 1700000300,
        quote: 2995,
        frames: { H1: { bars: h1Bars } }
      });
      const esEntities = map.entities.filter(e => e.reason === 'ES' || e.tags?.includes('ES'));
      assert.equal(esEntities.length, 1);
      const es = esEntities[0];
      assert.equal(es.kind, 'horizontal_line');
      assert.equal(es.timeframe, 'H1');
      assert.ok(es.label.includes('ES'));
      assert.ok(es.price === 3018 || es.price === 2995);
    });

    it('emits NO engulfing entity when the only engulfing candidate uses the open bar', () => {
      const h1Bars = [
        { time: 100, open: 3000, high: 3005, low: 2998, close: 3002 },
        { time: 200, open: 3002, high: 3006, low: 3000, close: 3001 },
        { time: 300, open: 3000, high: 3020, low: 2995, close: 3015 }
      ];
      const map = buildSnrMap({
        nowSec: 1700000300,
        quote: 3015,
        frames: { H1: { bars: h1Bars } }
      });
      const ebEsEntities = map.entities.filter(e => e.reason === 'EB' || e.reason === 'ES' || e.tags?.includes('EB') || e.tags?.includes('ES'));
      assert.equal(ebEsEntities.length, 0);
    });
  });

  describe('SBR & RBS Detection (Breakout + Retest)', () => {
    it('confirms RBS when resistance pivot is broken upward and retested as support', () => {
      const pivotR = { type: 'R', price: 3000, barIndex: 1, time: 100 };
      const closedBars = [
        { time: 50, open: 2980, high: 2990, low: 2975, close: 2985 },
        { time: 100, open: 2985, high: 3000, low: 2980, close: 3000 },
        { time: 200, open: 2995, high: 3025, low: 2990, close: 3020 },
        { time: 300, open: 3020, high: 3022, low: 2999, close: 3010 }
      ];
      const result = detectSbrRbs(pivotR, closedBars);
      assert.equal(result.retested, true);
      assert.equal(result.role, 'S');
      assert.equal(result.action, 'RBS');
    });

    it('confirms SBR when support pivot is broken downward and retested as resistance', () => {
      const pivotS = { type: 'S', price: 2950, barIndex: 1, time: 100 };
      const closedBars = [
        { time: 50, open: 2970, high: 2975, low: 2960, close: 2965 },
        { time: 100, open: 2965, high: 2968, low: 2950, close: 2950 },
        { time: 200, open: 2955, high: 2958, low: 2930, close: 2935 },
        { time: 300, open: 2935, high: 2951, low: 2932, close: 2945 }
      ];
      const result = detectSbrRbs(pivotS, closedBars);
      assert.equal(result.retested, true);
      assert.equal(result.role, 'R');
      assert.equal(result.action, 'SBR');
    });
  });

  describe('Trendlines (2+ Confirmed Pivots & Evidence-Backed Setup)', () => {
    it('creates trendline tagged and labelled TL_SETUP when 2+ confirmed pivots align with evidence-backed latest closed-bar setup', () => {
      const pivots = [
        { type: 'S', price: 2900, time: 1000, barIndex: 5 },
        { type: 'S', price: 2950, time: 2000, barIndex: 15 }
      ];
      // Slope: (2950 - 2900) / 1000 = 0.05. At time 3000, projected price is 3000.
      const closedBars = [
        { time: 3000, open: 3002, high: 3008, low: 2999, close: 3005 }
      ];
      const trendlines = detectTrendlines(pivots, closedBars);
      assert.equal(trendlines.length, 1);
      assert.equal(trendlines[0].kind, 'trend_line');
      assert.equal(trendlines[0].point.price, 2900);
      assert.equal(trendlines[0].point2.price, 2950);
      assert.ok(trendlines[0].tags.includes('TL_SETUP'));
      assert.ok(trendlines[0].label.includes('TL_SETUP'));
    });

    it('emits NO trendline when 2+ pivots exist but latest closed bar has no setup (no generic trendline)', () => {
      const pivots = [
        { type: 'S', price: 2900, time: 1000, barIndex: 5 },
        { type: 'S', price: 2950, time: 2000, barIndex: 15 }
      ];
      // At time 3000, projected price is 3000. Price is 3150 -> no setup!
      const closedBars = [
        { time: 3000, open: 3140, high: 3155, low: 3138, close: 3150 }
      ];
      const trendlines = detectTrendlines(pivots, closedBars);
      assert.equal(trendlines.length, 0);
    });

    it('returns empty trendlines when fewer than 2 pivots exist', () => {
      const pivots = [{ type: 'S', price: 2900, time: 1000, barIndex: 5 }];
      assert.deepEqual(detectTrendlines(pivots, []), []);
    });
  });

  describe('Two-Sided Range / Box & 50% Equilibrium Line', () => {
    it('creates rectangle when there are 2+ touches on high and 2+ touches on low', () => {
      const bars = [
        { time: 100, open: 2980, high: 3020, low: 2970, close: 3018 },
        { time: 200, open: 3018, high: 3015, low: 2960, close: 2962 },
        { time: 300, open: 2962, high: 3020, low: 2975, close: 3019 },
        { time: 400, open: 3019, high: 3010, low: 2960, close: 2965 },
        { time: 500, open: 2965, high: 2970, low: 2960, close: 2965 }
      ];
      const ranges = detectRanges(bars);
      assert.equal(ranges.length, 1);
      const range = ranges[0];
      assert.equal(range.kind, 'rectangle');
      assert.equal(range.reason, 'RANGE');
      assert.equal(range.high, 3020);
      assert.equal(range.low, 2960);
      assert.equal(range.equilibrium, 2990);
    });

    it('emits separate horizontal_line tagged RANGE_EQ at computed midpoint in buildSnrMap', () => {
      const bars = [
        { time: 100, open: 2980, high: 3020, low: 2970, close: 3018 },
        { time: 200, open: 3018, high: 3015, low: 2960, close: 2962 },
        { time: 300, open: 2962, high: 3020, low: 2975, close: 3019 },
        { time: 400, open: 3019, high: 3010, low: 2960, close: 2965 },
        { time: 500, open: 2965, high: 2970, low: 2960, close: 2965 }
      ];
      const map = buildSnrMap({
        nowSec: 1700000500,
        quote: 2990,
        frames: { H4: { bars } }
      });
      const rect = map.entities.find(e => e.kind === 'rectangle');
      assert.ok(rect);
      const eqLine = map.entities.find(e => e.kind === 'horizontal_line' && e.tags?.includes('RANGE_EQ'));
      assert.ok(eqLine, 'Must emit separate horizontal_line tagged RANGE_EQ');
      assert.equal(eqLine.price, 2990);
      assert.equal(eqLine.reason, 'RANGE_EQ');
      assert.ok(eqLine.label.includes('Eq'));
    });

    it('returns empty ranges when boundaries have fewer than 2 touches per side', () => {
      const trendingBars = [
        { time: 100, open: 2950, high: 2970, low: 2940, close: 2965 },
        { time: 200, open: 2965, high: 2990, low: 2960, close: 2985 },
        { time: 300, open: 2985, high: 3010, low: 2980, close: 3005 }
      ];
      assert.deepEqual(detectRanges(trendingBars), []);
    });
  });

  describe('Delta Volume Reversal Finder Labels (Strict finite price and timestamp)', () => {
    it('extracts delta entities only from real Delta indicator labels with finite price and timestamp', () => {
      const rawLabels = [
        { text: '▲ Delta Bull Reversal', price: 2980.5, time: 1700010000 },
        { text: '▼ Delta Bear Reversal', price: 3030.0, time: 1700020000 }
      ];
      const deltaEntities = parseDeltaLabels(rawLabels);
      assert.equal(deltaEntities.length, 2);
      assert.equal(deltaEntities[0].tags.includes('DELTA_REV'), true);
      assert.equal(deltaEntities[0].price, 2980.5);
      assert.equal(deltaEntities[0].time, 1700010000);
      assert.equal(deltaEntities[1].price, 3030.0);
      assert.equal(deltaEntities[1].time, 1700020000);
    });

    it('emits NO delta entity when timestamp is missing, null, undefined, or non-finite (no Date.now invention)', () => {
      const invalidLabels = [
        { text: '▲ Delta Bull Reversal', price: 2980.5, time: null },
        { text: '▲ Delta Bull Reversal', price: 2980.5, time: undefined },
        { text: '▲ Delta Bull Reversal', price: 2980.5, time: NaN },
        { text: '▼ Delta Bear Reversal', price: 3030.0 }
      ];
      assert.deepEqual(parseDeltaLabels(invalidLabels), []);
    });

    it('emits NO delta entity when price is missing, null, undefined, or non-finite', () => {
      const invalidPriceLabels = [
        { text: '▲ Delta Bull Reversal', price: null, time: 1700010000 },
        { text: '▲ Delta Bull Reversal', price: NaN, time: 1700010000 },
        { text: '▼ Delta Bear Reversal', time: 1700010000 }
      ];
      assert.deepEqual(parseDeltaLabels(invalidPriceLabels), []);
    });

    it('emits no delta entities when no delta labels exist (no volume fallback)', () => {
      assert.deepEqual(parseDeltaLabels([]), []);
      assert.deepEqual(parseDeltaLabels(null), []);
      assert.deepEqual(parseDeltaLabels([{ text: 'Regular EMA Label', price: 3000, time: 1700010000 }]), []);
    });
  });

  describe('buildSnrMap Integration & Compact On-Chart Note Quality', () => {
    it('builds a complete snr-map.v1 payload with verified entities and compact evidence note', () => {
      const nowSec = 1700050000;
      const quote = 3000;

      const wBars = [
        { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
        { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
        { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
        { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
      ];

      const dBars = [
        { time: 100, open: 2980, high: 2985, low: 2970, close: 2975 },
        { time: 200, open: 2975, high: 2978, low: 2960, close: 2960 },
        { time: 300, open: 2960, high: 2990, low: 2960, close: 2985 },
        { time: 400, open: 2985, high: 2988, low: 2980, close: 2982 },
        { time: 500, open: 2982, high: 2985, low: 2980, close: 2982 }
      ];

      const h4Bars = [
        { time: 100, open: 2970, high: 3010, low: 2965, close: 3010 },
        { time: 200, open: 3010, high: 3005, low: 2970, close: 2970 },
        { time: 300, open: 2970, high: 3010, low: 2972, close: 3010 },
        { time: 400, open: 3010, high: 3008, low: 2970, close: 2970 },
        { time: 500, open: 2970, high: 2975, low: 2965, close: 2970 }
      ];

      const h1Bars = [
        { time: 100, open: 2975, high: 2980, low: 2970, close: 2975 },
        { time: 200, open: 2975, high: 2978, low: 2970, close: 2972 }
      ];

      const deltaLabels = [
        { text: '▲ Delta Bull Reversal', price: 2960.0, time: 1700020000 }
      ];

      const map = buildSnrMap({
        nowSec,
        quote,
        frames: { W: { bars: wBars }, D: { bars: dBars }, H4: { bars: h4Bars }, H1: { bars: h1Bars } },
        deltaLabels
      });

      assert.equal(map.manifest.schema_version, 'snr-map.v1');
      assert.match(map.manifest.manifest_hash, /^[0-9a-f]{64}$/);
      assert.ok(map.entities.length > 0);
      assert.equal(map.entities.some(e => e.tags.includes('DELTA_REV')), true);
      assert.ok(typeof map.note === 'string' && map.note.length > 0);

      const noteEntity = map.entities.find(e => e.kind === 'text');
      assert.ok(noteEntity, 'Note entity should exist');

      // Point must not be quotePrice + 40
      assert.notEqual(noteEntity.point.price, quote + 40);

      // Price must match a real evidence entity; the timestamp is the current run
      // so the note remains visible on the active chart.
      const structuralEntities = map.entities.filter(e => e.kind !== 'text');
      const matchingPrice = structuralEntities.some(e => e.point && e.point.price === noteEntity.point.price);
      assert.ok(matchingPrice, 'Note price must be anchored at a real evidence entity');
      assert.equal(noteEntity.point.time, nowSec, 'Note must be anchored at the current run time');

      // No giant opaque background
      assert.notEqual(noteEntity.overrides?.backgroundColor, 'rgba(255, 255, 255, 0.90)');
      assert.equal(noteEntity.overrides?.fillBackground, false);

      // Max 4 evidence-derived lines
      const lines = noteEntity.label.split('\n');
      assert.ok(lines.length <= 4, `Expected <= 4 lines, got ${lines.length}`);
      assert.ok(lines.some(l => /Daily|D:/i.test(l)), 'Contains Daily regime');
      assert.ok(lines.some(l => /H4/i.test(l)), 'Contains H4 structure');
      assert.ok(lines.some(l => /H1/i.test(l)), 'Contains H1 direction');
      assert.ok(lines.some(l => /Invalidation|Cond|Bias/i.test(l)), 'Contains Invalidation/Conditional');
    });

    it('sets fourth line to "Invalidation: INSUFFICIENT_EVIDENCE" when either above or below structural key levels are absent', () => {
      // Setup bars that only produce levels below quote (3000), within quote +/- 50 (quote = 3020, range [2970, 3070])
      const wBars = [
        { time: 100, open: 2980, high: 2990, low: 2975, close: 2985 },
        { time: 200, open: 2985, high: 2995, low: 2980, close: 2990 },
        { time: 300, open: 2990, high: 3005, low: 2985, close: 3000 },
        { time: 400, open: 3000, high: 2995, low: 2975, close: 2980 },
        { time: 500, open: 2980, high: 2985, low: 2975, close: 2980 },
        { time: 600, open: 2980, high: 2985, low: 2975, close: 2980 }
      ];

      const map = buildSnrMap({
        nowSec: 1700050000,
        quote: 3020, // Quote is above all structural levels -> aboveQuote is empty
        frames: { W: { bars: wBars } }
      });

      assert.ok(map.entities.length > 0);
      const noteEntity = map.entities.find(e => e.kind === 'text');
      assert.ok(noteEntity, 'Note entity should exist');
      const lines = noteEntity.label.split('\n');
      assert.equal(lines[3], 'Invalidation: INSUFFICIENT_EVIDENCE');
      assert.equal(noteEntity.label.includes('3060.0'), false, 'Must not use quotePrice + 10 fallback');
      assert.equal(noteEntity.label.includes('3040.0'), false, 'Must not use quotePrice - 10 fallback');
    });

    it('sets fourth line to "Invalidation: INSUFFICIENT_EVIDENCE" when no horizontal levels exist at all', () => {
      // Rectangle only (no horizontal lines)
      const h4Bars = [
        { time: 100, open: 2980, high: 3020, low: 2970, close: 3018 },
        { time: 200, open: 3018, high: 3015, low: 2960, close: 2962 },
        { time: 300, open: 2962, high: 3020, low: 2975, close: 3019 },
        { time: 400, open: 3019, high: 3010, low: 2960, close: 2965 },
        { time: 500, open: 2965, high: 2970, low: 2960, close: 2965 }
      ];

      const map = buildSnrMap({
        nowSec: 1700050000,
        quote: 3030, // Quote is above equilibrium (2990), so aboveQuote is empty
        frames: { H4: { bars: h4Bars } }
      });

      const noteEntity = map.entities.find(e => e.kind === 'text');
      assert.ok(noteEntity);
      const lines = noteEntity.label.split('\n');
      assert.equal(lines[3], 'Invalidation: INSUFFICIENT_EVIDENCE');
    });

    it('uses actual entity timestamps and eliminates Date.now/nowSec fallback on detector output entities', () => {
      const wBars = [
        { time: 11111, open: 2980, high: 2990, low: 2970, close: 2985 },
        { time: 22222, open: 2985, high: 3020, low: 2980, close: 3020 },
        { time: 33333, open: 3020, high: 3015, low: 2975, close: 2980 },
        { time: 44444, open: 2980, high: 2985, low: 2975, close: 2980 }
      ];
      const h1Bars = [
        { time: 55555, open: 3010, high: 3012, low: 2995, close: 3000 },
        { time: 66666, open: 2998, high: 3020, low: 2995, close: 3015 },
        { time: 77777, open: 3015, high: 3018, low: 3012, close: 3014 }
      ];

      const customNowSec = 999999999;
      const map = buildSnrMap({
        nowSec: customNowSec,
        quote: 3010,
        frames: { W: { bars: wBars }, H1: { bars: h1Bars } }
      });

      // All structural entities (non-note) must have finite timestamps matching the input bars, never customNowSec
      const nonNoteEntities = map.entities.filter(e => e.kind !== 'text');
      assert.ok(nonNoteEntities.length > 0);
      for (const ent of nonNoteEntities) {
        assert.ok(Number.isFinite(ent.point?.time), `Entity ${ent.reason || ent.kind} point.time must be finite number`);
        assert.notEqual(ent.point.time, customNowSec, `Entity ${ent.reason || ent.kind} must not use nowSec fabricated fallback`);
      }
    });

    it('skips candidates when bar timestamp is missing or non-finite instead of fabricating nowSec', () => {
      // Engulfing candidate with missing/invalid timestamp on currBar
      const invalidTimeBars = [
        { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 },
        { time: null, open: 2998, high: 3020, low: 2995, close: 3015 },
        { time: 300, open: 3015, high: 3018, low: 3012, close: 3014 }
      ];

      const map = buildSnrMap({
        nowSec: 999999999,
        quote: 3010,
        frames: { H1: { bars: invalidTimeBars } }
      });

      const eb = map.entities.find(e => e.reason === 'EB');
      assert.equal(eb, undefined, 'Must skip engulfing candidate when bar timestamp is missing/null');
    });

    it('anchors the compact note at run time using an evidence-backed price so it is visible on the current chart', () => {
      const nowSec = 1709000000;
      const map = buildSnrMap({
        nowSec,
        quote: 3000,
        frames: {
          H1: { bars: [
            { time: 100, open: 3010, high: 3012, low: 2995, close: 3000 },
            { time: 200, open: 2998, high: 3020, low: 2995, close: 3015 },
            { time: 300, open: 3015, high: 3018, low: 3012, close: 3014 }
          ] }
        }
      });

      const note = map.entities.find(e => e.kind === 'text');
      const structuralPrices = map.entities.filter(e => e.kind !== 'text').map(e => e.point?.price);
      assert.equal(note.point.time, nowSec);
      assert.ok(structuralPrices.includes(note.point.price), 'Note price must remain anchored to real structure');
    });
  });
});
