import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  SCHEMA_VERSION,
  normalizeDrawingSnapshot,
  classifyLifecycle,
  intervalDistance,
  alignDrawingToZone,
} from '../scripts/lib/user_drawing_pipeline.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('User Drawing Pipeline v1 — Schema & Interface Specification', () => {
  it('exports SCHEMA_VERSION equal to drawing_snapshot.v1', () => {
    assert.equal(SCHEMA_VERSION, 'drawing_snapshot.v1');
  });

  describe('normalizeDrawingSnapshot — validation & fail-closed behavior', () => {
    it('fails closed with structured error when raw input is missing or invalid', () => {
      assert.throws(
        () => normalizeDrawingSnapshot(null),
        (err) => {
          assert.equal(err.code, 'ERR_INVALID_PAYLOAD');
          return true;
        }
      );

      assert.throws(
        () => normalizeDrawingSnapshot(undefined),
        (err) => {
          assert.equal(err.code, 'ERR_INVALID_PAYLOAD');
          return true;
        }
      );
    });

    it('fails closed when symbol is missing or empty', () => {
      const payload = {
        timeframe: '60',
        timezone: 'UTC',
        timestamp: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: []
      };

      assert.throws(
        () => normalizeDrawingSnapshot(payload),
        (err) => {
          assert.equal(err.code, 'ERR_MISSING_SYMBOL');
          return true;
        }
      );
    });

    it('fails closed when captured_at_utc is missing or invalid', () => {
      const payload = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        source_model_version: 'tv_chart_model.v1',
        drawings: []
      };

      assert.throws(
        () => normalizeDrawingSnapshot(payload, { capturedAtUtc: 'not-a-date' }),
        (err) => {
          assert.equal(err.code, 'ERR_INVALID_CAPTURED_AT');
          return true;
        }
      );
    });

    it('fails closed when timezone is missing or empty', () => {
      const payload = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timestamp: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: []
      };

      assert.throws(
        () => normalizeDrawingSnapshot(payload),
        (err) => {
          assert.equal(err.code, 'ERR_MISSING_TIMEZONE');
          return true;
        }
      );
    });

    it('fails closed when source_model_version is missing or invalid', () => {
      const payload = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        drawings: []
      };

      assert.throws(
        () => normalizeDrawingSnapshot(payload, { sourceModelVersion: '' }),
        (err) => {
          assert.equal(err.code, 'ERR_MISSING_SOURCE_MODEL_VERSION');
          return true;
        }
      );
    });
  });

  describe('Deterministic snapshot ID & canonicalization', () => {
    it('produces identical snapshot_id for identical inputs regardless of key ordering', () => {
      const payloadA = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'd1',
            type: 'trend_line',
            points: [{ price: 2350, time: 1700000000, index: 10 }]
          }
        ]
      };

      const payloadB = {
        drawings: [
          {
            points: [{ index: 10, time: 1700000000, price: 2350 }],
            type: 'trend_line',
            id: 'd1'
          }
        ],
        source_model_version: 'tv_chart_model.v1',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        timezone: 'UTC',
        timeframe: '60',
        symbol: 'XAUUSD'
      };

      const normA = normalizeDrawingSnapshot(payloadA);
      const normB = normalizeDrawingSnapshot(payloadB);

      assert.equal(normA.snapshot_id, normB.snapshot_id);
      assert.match(normA.snapshot_id, /^[0-9a-f]{64}$/);
    });

    it('changes snapshot_id if any drawing property or coordinate changes', () => {
      const basePayload = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'd1',
            type: 'trend_line',
            points: [{ price: 2350, time: 1700000000, index: 10 }]
          }
        ]
      };

      const alteredPayload = {
        ...basePayload,
        drawings: [
          {
            id: 'd1',
            type: 'trend_line',
            points: [{ price: 2350.5, time: 1700000000, index: 10 }]
          }
        ]
      };

      const norm1 = normalizeDrawingSnapshot(basePayload);
      const norm2 = normalizeDrawingSnapshot(alteredPayload);

      assert.notEqual(norm1.snapshot_id, norm2.snapshot_id);
    });
  });

  describe('Mixed geometry normalization & error resilience', () => {
    it('normalizes lines, rectangles, rays, labels, and fibonacci accurately', () => {
      const raw = {
        symbol: 'XAUUSD',
        timeframe: '15',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'line_1',
            type: 'trend_line',
            points: [
              { price: 2300, time: 1700000000, index: 1 },
              { price: 2350, time: 1700036000, index: 2 }
            ]
          },
          {
            id: 'rect_1',
            type: 'rectangle',
            points: [
              { price: 2380.0, time: 1700050000, index: 3 },
              { price: 2400.0, time: 1700100000, index: 4 }
            ]
          },
          {
            id: 'fib_1',
            type: 'fib_retracement',
            points: [
              { price: 2300.0, time: 1700000000, index: 1 },
              { price: 2400.0, time: 1700100000, index: 4 }
            ],
            properties: {
              levels: [
                { coeff: 0.5, price: 2350.0 },
                { coeff: 0.618, price: 2361.8 },
                { coeff: 0.786, price: 2378.6 }
              ]
            }
          },
          {
            id: 'text_1',
            type: 'text',
            text: 'H1 BOS structure zone',
            points: [{ price: 2390.0, time: 1700060000, index: 5 }]
          },
          {
            id: 'unknown_1',
            type: 'custom_spline_curve',
            points: [{ price: 2375.0, time: 1700040000, index: 6 }]
          }
        ]
      };

      const result = normalizeDrawingSnapshot(raw);
      assert.equal(result.schema_version, 'drawing_snapshot.v1');
      assert.equal(result.drawings.length, 5);

      // Line check
      const line = result.drawings[0];
      assert.equal(line.kind, 'trend_line');
      assert.deepEqual(line.provenance, { ownership: 'UNCLASSIFIED' });
      assert.equal(line.source_status, 'valid');
      assert.equal(line.geometry.anchors.length, 2);
      assert.equal(line.geometry.anchors[0].time_utc, '2023-11-14T22:13:20.000Z');

      // Rectangle check
      const rect = result.drawings[1];
      assert.equal(rect.kind, 'rectangle');
      assert.deepEqual(rect.provenance, { ownership: 'UNCLASSIFIED' });
      assert.equal(rect.geometry.price_bounds.low, 2380.0);
      assert.equal(rect.geometry.price_bounds.high, 2400.0);
      assert.equal(rect.geometry.time_bounds.start_time, 1700050000);
      assert.equal(rect.geometry.time_bounds.end_time, 1700100000);

      // Fib check
      const fib = result.drawings[2];
      assert.equal(fib.kind, 'fib_retracement');
      assert.deepEqual(fib.provenance, { ownership: 'UNCLASSIFIED' });
      assert.ok(fib.geometry.fib_levels);
      assert.equal(fib.geometry.fib_levels['0.5'], 2350.0);
      assert.equal(fib.geometry.fib_levels['0.618'], 2361.8);
      assert.equal(fib.geometry.fib_levels['0.786'], 2378.6);
      assert.deepEqual(fib.geometry.golden_levels_present, [0.5, 0.618, 0.786]);

      // Text check
      const text = result.drawings[3];
      assert.equal(text.kind, 'text');
      assert.deepEqual(text.provenance, { ownership: 'UNCLASSIFIED' });
      assert.deepEqual(text.annotation.tags, ['BOS']);

      // Unknown check
      const unk = result.drawings[4];
      assert.equal(unk.kind, 'unknown');
      assert.deepEqual(unk.provenance, { ownership: 'UNCLASSIFIED' });
      assert.equal(unk.source_status, 'valid');
    });

    it('preserves only explicitly supplied fibonacci levels without synthesizing prices from anchors', () => {
      // Fib with no supplied levels
      const rawNoLevels = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'fib_empty',
            type: 'fib_retracement',
            points: [
              { price: 2300.0, time: 1700000000, index: 1 },
              { price: 2400.0, time: 1700100000, index: 4 }
            ]
          }
        ]
      };

      const resEmpty = normalizeDrawingSnapshot(rawNoLevels);
      const fibEmpty = resEmpty.drawings[0];
      assert.deepEqual(fibEmpty.geometry.fib_levels, {});
      assert.deepEqual(fibEmpty.geometry.golden_levels_present, []);

      // Fib with only 0.618 level supplied
      const rawPartial = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'fib_partial',
            type: 'fib_retracement',
            points: [
              { price: 2300.0, time: 1700000000, index: 1 },
              { price: 2400.0, time: 1700100000, index: 4 }
            ],
            properties: {
              levels: [
                { coeff: 0.618, price: 2361.8 },
                { coeff: 1.618, price: 2461.8 }
              ]
            }
          }
        ]
      };

      const resPartial = normalizeDrawingSnapshot(rawPartial);
      const fibPartial = resPartial.drawings[0];
      assert.deepEqual(fibPartial.geometry.fib_levels, {
        '0.618': 2361.8,
        '1.618': 2461.8
      });
      assert.equal(fibPartial.geometry.fib_levels['0.5'], undefined);
      assert.equal(fibPartial.geometry.fib_levels['0.786'], undefined);
      assert.deepEqual(fibPartial.geometry.golden_levels_present, [0.618]);
    });

    it('preserves drawing text containing [AI-SNR] and assigns UNCLASSIFIED provenance without filtering', () => {
      const raw = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'ai_drawing_1',
            type: 'rectangle',
            text: '[AI-SNR] H1 Key POI Zone',
            points: [
              { price: 2350.0, time: 1700000000, index: 1 },
              { price: 2360.0, time: 1700036000, index: 2 }
            ]
          },
          {
            id: 'ai_drawing_2',
            type: 'text',
            text: '(AI) Scalp Target at 2380',
            points: [{ price: 2380.0, time: 1700040000, index: 3 }]
          }
        ]
      };

      const result = normalizeDrawingSnapshot(raw);
      assert.equal(result.drawings.length, 2);
      assert.equal(result.drawings[0].annotation.raw_text, '[AI-SNR] H1 Key POI Zone');
      assert.deepEqual(result.drawings[0].provenance, { ownership: 'UNCLASSIFIED' });
      assert.equal(result.drawings[1].annotation.raw_text, '(AI) Scalp Target at 2380');
      assert.deepEqual(result.drawings[1].provenance, { ownership: 'UNCLASSIFIED' });
    });

    it('does not silently drop malformed drawings and records errors without inventing timestamps', () => {
      const raw = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 'malformed_1',
            type: 'rectangle',
            points: [
              { price: null, time: null, index: null }
            ]
          }
        ]
      };

      const result = normalizeDrawingSnapshot(raw);
      assert.equal(result.drawings.length, 1);
      const malformed = result.drawings[0];
      assert.equal(malformed.source_status, 'malformed');
      assert.ok(malformed.errors.length > 0);
      assert.equal(malformed.geometry.anchors[0].time, null);
      assert.equal(malformed.geometry.anchors[0].time_utc, null);
      assert.equal(malformed.geometry.price_bounds, null);
    });
  });

  describe('Conservative Tag Parser', () => {
    it('extracts only supported structural tags and ignores narrative text', () => {
      const raw = {
        symbol: 'XAUUSD',
        timeframe: '60',
        timezone: 'UTC',
        captured_at_utc: '2026-08-31T12:00:00.000Z',
        source_model_version: 'tv_chart_model.v1',
        drawings: [
          {
            id: 't1',
            type: 'text',
            text: 'Key H1 POI with CHOCH and SBR level after BSL liquidity sweep',
            points: [{ price: 2300, time: 1700000000, index: 1 }]
          },
          {
            id: 't2',
            type: 'text',
            text: 'RBS confirmed after SSL sweep and BOS',
            points: [{ price: 2310, time: 1700000000, index: 1 }]
          },
          {
            id: 't3',
            type: 'text',
            text: 'I think price will bounce strongly here for a massive rally toward moon',
            points: [{ price: 2320, time: 1700000000, index: 1 }]
          }
        ]
      };

      const result = normalizeDrawingSnapshot(raw);
      const tags1 = result.drawings[0].annotation.tags;
      const tags2 = result.drawings[1].annotation.tags;
      const tags3 = result.drawings[2].annotation.tags;

      assert.deepEqual(tags1.sort(), ['BSL', 'CHOCH', 'POI', 'SBR', 'liquidity sweep'].sort());
      assert.deepEqual(tags2.sort(), ['BOS', 'RBS', 'SSL'].sort());
      assert.deepEqual(tags3, []);
    });
  });

  describe('classifyLifecycle — time-bounded state machine', () => {
    const drawing = {
      kind: 'rectangle',
      geometry: {
        price_bounds: { low: 2300, high: 2320 },
        time_bounds: { start_time: 1700000000, end_time: 1700010000 }
      }
    };

    it('returns UNKNOWN when lifecycle_policy is missing or invalid', () => {
      const bars = [{ time: 1700020000, open: 2350, high: 2360, low: 2340, close: 2355 }];
      assert.equal(classifyLifecycle(drawing, bars, 1700050000), 'UNKNOWN');
      assert.equal(classifyLifecycle(drawing, bars, 1700050000, {}), 'UNKNOWN');
      assert.equal(classifyLifecycle(drawing, bars, 1700050000, { side: 'buy' }), 'UNKNOWN');
    });

    it('uses only closed bars at or before asOfUtc and ignores future bars', () => {
      const policy = { side: 'buy', invalidation: 'close_beyond' };
      const bars = [
        { time: 1700020000, open: 2350, high: 2360, low: 2330, close: 2350 }, // Untouched
        { time: 1700030000, open: 2330, high: 2330, low: 2290, close: 2280 }  // Breaks in future bar
      ];

      // asOfUtc before bar 2 -> UNTOUCHED
      const stateBefore = classifyLifecycle(drawing, bars, 1700025000, policy);
      assert.equal(stateBefore, 'UNTOUCHED');

      // asOfUtc after bar 2 -> BROKEN
      const stateAfter = classifyLifecycle(drawing, bars, 1700035000, policy);
      assert.equal(stateAfter, 'BROKEN');
    });

    it('correctly transitions through TOUCHED, MITIGATED, and BROKEN states', () => {
      const policy = { side: 'buy', invalidation: 'close_beyond' };

      // Touched: low penetrates into [2300, 2320], close stays above 2300
      const touchedBars = [
        { time: 1700020000, open: 2330, high: 2340, low: 2310, close: 2325 }
      ];
      assert.equal(classifyLifecycle(drawing, touchedBars, 1700025000, policy), 'TOUCHED');

      // Mitigated: test into zone with mitigation policy
      const mitigationPolicy = { side: 'buy', invalidation: 'close_beyond', mitigation: 'penetrate_50' };
      const mitigatedBars = [
        { time: 1700020000, open: 2330, high: 2340, low: 2305, close: 2325 }
      ];
      assert.equal(classifyLifecycle(drawing, mitigatedBars, 1700025000, mitigationPolicy), 'MITIGATED');

      // Broken: close penetrates below 2300
      const brokenBars = [
        { time: 1700020000, open: 2310, high: 2315, low: 2280, close: 2290 }
      ];
      assert.equal(classifyLifecycle(drawing, brokenBars, 1700025000, policy), 'BROKEN');
    });
  });

  describe('intervalDistance & alignDrawingToZone', () => {
    it('calculates 1D interval distance correctly', () => {
      // Overlapping
      assert.equal(intervalDistance(10, 20, 15, 25), 0);
      assert.equal(intervalDistance(15, 25, 10, 20), 0);

      // Touching
      assert.equal(intervalDistance(10, 20, 20, 30), 0);
      assert.equal(intervalDistance(20, 30, 10, 20), 0);

      // Disjoint
      assert.equal(intervalDistance(10, 20, 25, 35), 5);
      assert.equal(intervalDistance(25, 35, 10, 20), 5);

      // Handles flipped bounds safely
      assert.equal(intervalDistance(20, 10, 35, 25), 5);
    });

    it('rejects invalid inputs in intervalDistance', () => {
      assert.throws(() => intervalDistance(NaN, 10, 15, 20), /finite number/);
      assert.throws(() => intervalDistance(10, 'abc', 15, 20), /finite number/);
    });

    it('alignDrawingToZone computes normalized distance and checks alignment against ATR/epsilon', () => {
      const drawing = {
        geometry: {
          price_bounds: { low: 2300, high: 2320 }
        }
      };

      const alignedZone = { low: 2322, high: 2330 }; // Distance = 2.0
      const atr = 10.0;
      const epsilon = 0.25; // 2.0 / 10.0 = 0.2 <= 0.25 -> aligned

      const resAligned = alignDrawingToZone(drawing, alignedZone, { atr, epsilon });
      assert.equal(resAligned.is_aligned, true);
      assert.equal(resAligned.aligned, true);
      assert.equal(resAligned.interval_distance, 2.0);
      assert.equal(resAligned.normalized_distance, 0.2);

      const unalignedZone = { low: 2330, high: 2340 }; // Distance = 10.0 / 10.0 = 1.0 > 0.25
      const resUnaligned = alignDrawingToZone(drawing, unalignedZone, { atr, epsilon });
      assert.equal(resUnaligned.is_aligned, false);
      assert.equal(resUnaligned.aligned, false);
      assert.equal(resUnaligned.interval_distance, 10.0);
      assert.equal(resUnaligned.normalized_distance, 1.0);
    });

    it('rejects invalid ATR or epsilon in alignDrawingToZone', () => {
      const drawing = { geometry: { price_bounds: { low: 100, high: 110 } } };
      const zone = { low: 120, high: 130 };

      assert.throws(
        () => alignDrawingToZone(drawing, zone, { atr: 0, epsilon: 0.1 }),
        (err) => err.code === 'ERR_INVALID_ATR' || /ATR/.test(err.message)
      );

      assert.throws(
        () => alignDrawingToZone(drawing, zone, { atr: -5, epsilon: 0.1 }),
        (err) => err.code === 'ERR_INVALID_ATR' || /ATR/.test(err.message)
      );

      assert.throws(
        () => alignDrawingToZone(drawing, zone, { atr: 10, epsilon: -0.1 }),
        (err) => err.code === 'ERR_INVALID_EPSILON' || /epsilon/.test(err.message)
      );
    });
  });

  describe('Fixture & Manifest Verification', () => {
    it('verifies fixture file SHA-256 and expected snapshot ID against manifest', () => {
      const rawPath = join(FIXTURES_DIR, 'user-drawings-v1.raw.json');
      const manifestPath = join(FIXTURES_DIR, 'user-drawings-v1.manifest.json');

      assert.ok(existsSync(rawPath), 'user-drawings-v1.raw.json exists');
      assert.ok(existsSync(manifestPath), 'user-drawings-v1.manifest.json exists');

      const rawContent = readFileSync(rawPath, 'utf8');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

      const calculatedFixtureSha256 = crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');
      assert.equal(calculatedFixtureSha256, manifest.fixture_sha256, 'fixture SHA-256 matches manifest');

      const rawData = JSON.parse(rawContent);
      const normalized = normalizeDrawingSnapshot(rawData);

      assert.equal(normalized.schema_version, manifest.schema_version);
    });
  });

  describe('study_user_drawings.js Source Contracts — Controlled Session & Fail-Closed Extraction', () => {
    const scriptPath = join(__dirname, '..', 'scripts', 'study_user_drawings.js');

    it('contains no healthCore.launch, kill_existing, or sleep auto-launch fallback', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      assert.doesNotMatch(scriptContent, /healthCore\.launch/);
      assert.doesNotMatch(scriptContent, /kill_existing/);
      assert.doesNotMatch(scriptContent, /\bsleep\b/);
    });

    it('enforces controlled-session-only health check without auto-launch fallback', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      assert.match(scriptContent, /healthCore\.healthCheck/);
      assert.match(scriptContent, /connection[- ]unavailable|unavailable/i);
    });

    it('contains explicit fail-closed failure messaging in browser evaluate payload for model, dataSource, and points', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      // Model check throws
      assert.match(scriptContent, /if\s*\(!model\)\s*throw new Error/);
      // Data source for id check throws with shape id
      assert.match(scriptContent, /!ds/);
      // Points method / points extraction check throws with shape id
      assert.match(scriptContent, /!ds\.points/);
      // No points returned check throws with shape id
      assert.match(scriptContent, /No points returned for shape id/);
      // Does not fall back to p.points
      assert.doesNotMatch(scriptContent, /p\?\.points/);
      assert.doesNotMatch(scriptContent, /p\.points/);
    });
  });
});

