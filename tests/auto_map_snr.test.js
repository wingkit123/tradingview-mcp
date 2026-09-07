import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadOwnershipManifest,
  writeOwnershipManifest,
  executeAutomatedMapping,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_MAP_PATH,
  writeSnrMapReceipt,
  writeJsonAtomic
} from '../scripts/auto_map_snr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_ARTIFACTS_DIR = path.join(__dirname, 'temp_artifacts');

describe('Auto Map SNR — Atomic Transaction Lifecycle & Ownership Isolation', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_ARTIFACTS_DIR)) {
      fs.rmSync(TEST_ARTIFACTS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_ARTIFACTS_DIR, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(TEST_ARTIFACTS_DIR)) {
      fs.rmSync(TEST_ARTIFACTS_DIR, { recursive: true, force: true });
    }
  });

  describe('Manifest Persistence (load / write)', () => {
    it('returns empty manifest defaults when file does not exist', () => {
      const nonExistent = path.join(TEST_ARTIFACTS_DIR, 'no-such-file.json');
      const manifest = loadOwnershipManifest(nonExistent);
      assert.deepEqual(manifest, { entity_ids: [], manifest_hash: null });
    });

    it('persists and loads ownership receipt atomically', () => {
      const targetPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-entities.json');
      const receipt = {
        entity_ids: ['id-101', 'id-102'],
        manifest_hash: 'a'.repeat(64),
        updated_at_utc: '2026-09-02T12:00:00.000Z'
      };
      writeOwnershipManifest(targetPath, receipt);
      const loaded = loadOwnershipManifest(targetPath);
      assert.deepEqual(loaded.entity_ids, ['id-101', 'id-102']);
      assert.equal(loaded.manifest_hash, 'a'.repeat(64));
    });
  });

  describe('Atomic Transaction Execution & User Drawing Safety', () => {
    it('creates new drawings, verifies IDs via listDrawings, and retires ONLY previous manifest IDs', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned.json');
      // Previous manifest had 'agent-id-old'
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-id-old'],
        manifest_hash: '0'.repeat(64)
      });

      const currentShapes = [
        { id: 'manual-user-id-1', name: 'LineToolRectangle' },
        { id: 'manual-user-id-2', name: 'LineToolHorizLine' },
        { id: 'agent-id-old', name: 'LineToolHorizLine' }
      ];

      const drawnShapes = [];
      const removedIds = [];
      const chartStateHistory = [];
      let nextId = 1;

      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: true }),
          launch: async () => {}
        },
        chartCore: {
          getState: async () => ({
            symbol: 'OANDA:XAUUSD',
            resolution: '60',
            chartType: 1
          }),
          setSymbol: async (arg) => { chartStateHistory.push({ op: 'setSymbol', ...arg }); },
          setTimeframe: async (arg) => { chartStateHistory.push({ op: 'setTimeframe', ...arg }); },
          setType: async (arg) => { chartStateHistory.push({ op: 'setType', ...arg }); }
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({
            studies: [{ labels: [{ text: '▲ Delta Bull Reversal', price: 2980, time: 1700000000 }] }]
          })
        },
        drawCore: {
          drawShape: async (shape) => {
            const id = `new-id-${nextId++}`;
            drawnShapes.push({ id, shape });
            currentShapes.push({ id, name: shape.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({
            success: true,
            shapes: [...currentShapes]
          }),
          removeOne: async ({ entity_id }) => {
            removedIds.push(entity_id);
            const idx = currentShapes.findIndex(s => s.id === entity_id);
            if (idx >= 0) currentShapes.splice(idx, 1);
            return { success: true, removed: true };
          }
        },
        disconnect: () => {}
      };

      const result = await executeAutomatedMapping({ deps: mockDeps, ownershipPath });

      assert.equal(result.success, true);
      assert.ok(result.created_entity_ids.length > 0);
      assert.deepEqual(result.retired_entity_ids, ['agent-id-old']);
      assert.deepEqual(removedIds, ['agent-id-old']);

      // Check that user manual drawings were NEVER touched or removed
      assert.equal(removedIds.includes('manual-user-id-1'), false);
      assert.equal(removedIds.includes('manual-user-id-2'), false);

      // Check manifest was updated with new IDs
      const updatedManifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(updatedManifest.entity_ids, result.created_entity_ids);
      assert.equal(updatedManifest.manifest_hash, result.manifest_hash);

      // Check chart state was restored in finally
      const lastTypeCall = chartStateHistory.filter(h => h.op === 'setType').pop();
      const lastTfCall = chartStateHistory.filter(h => h.op === 'setTimeframe').pop();
      assert.equal(lastTypeCall.chart_type, 1);
      assert.equal(lastTfCall.timeframe, '60');
    });

    it('fails closed and aborts retirement if newly created drawings cannot be verified', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-fail.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-id-keep-me'],
        manifest_hash: '1'.repeat(64)
      });

      const removedIds = [];
      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: true })
        },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '1D', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({
            studies: [{ labels: [{ text: '▲ Delta Bull Reversal', price: 2980, time: 1700000000 }] }]
          })
        },
        drawCore: {
          drawShape: async () => ({ success: true, entity_id: 'ghost-id-missing' }),
          // listDrawings does NOT contain 'ghost-id-missing' -> verification fails
          listDrawings: async () => ({
            success: true,
            shapes: [{ id: 'agent-id-keep-me' }]
          }),
          removeOne: async ({ entity_id }) => {
            removedIds.push(entity_id);
          }
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath }),
        /Verification failed/i
      );

      // Verification failure MUST leave previous manifest IDs untouched!
      assert.deepEqual(removedIds, []);
      const unchangedManifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(unchangedManifest.entity_ids, ['agent-id-keep-me']);
    });

    it('fails closed immediately when TradingView healthCheck returns api_available === false without auto-launching', async () => {
      let launchCalled = false;
      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: false }),
          launch: async () => { launchCalled = true; }
        },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 })
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps }),
        /API unavailable|Health check failed/i
      );
      assert.equal(launchCalled, false, 'Must NOT attempt to launch TradingView on health check failure');
    });

    it('fails closed immediately when initial chart state is missing or invalid', async () => {
      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: true })
        },
        chartCore: {
          getState: async () => null // initial state missing
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps }),
        /Initial chart state/i
      );
    });

    it('aborts and blocks manifest replacement if removeOne returns removed !== true or throws', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-false-removal.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-prev-1'],
        manifest_hash: '2'.repeat(64)
      });

      const currentShapes = [{ id: 'agent-prev-1', name: 'LineToolHorizLine' }];
      let nextId = 1;

      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: true })
        },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async (s) => {
            const id = `new-id-${nextId++}`;
            currentShapes.push({ id, name: s.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({
            success: true,
            shapes: [...currentShapes]
          }),
          removeOne: async () => {
            // Removal was NOT confirmed (removed !== true)
            return { success: false, removed: false };
          }
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath }),
        /removal not confirmed|failed to retire/i
      );

      // Manifest MUST NOT be updated to the new receipt when retirement is incomplete!
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['agent-prev-1']);
      assert.equal(manifest.manifest_hash, '2'.repeat(64));
    });

    it('calls getPineLabels with verbose: true', async () => {
      let pineLabelsArgs = null;
      const currentShapes = [];
      let nextId = 1;

      const mockDeps = {
        sleep: async () => {},
        healthCore: {
          healthCheck: async () => ({ api_available: true })
        },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async (args) => {
            pineLabelsArgs = args;
            return { studies: [] };
          }
        },
        drawCore: {
          drawShape: async (s) => {
            const id = `new-id-${nextId++}`;
            currentShapes.push({ id, name: s.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({
            success: true,
            shapes: [...currentShapes]
          }),
          removeOne: async () => ({ success: true, removed: true })
        },
        disconnect: () => {}
      };

      await executeAutomatedMapping({ deps: mockDeps, ownershipPath: path.join(TEST_ARTIFACTS_DIR, 'test-manifest.json') });
      assert.ok(pineLabelsArgs);
      assert.equal(pineLabelsArgs.verbose, true);
      assert.equal(pineLabelsArgs.study_filter, 'Delta Volume Reversal Finder');
    });

    it('exports DEFAULT_MAP_PATH pointing to artifacts/snr-map.v1.json', () => {
      assert.ok(DEFAULT_MAP_PATH.endsWith(path.join('artifacts', 'snr-map.v1.json')));
    });

    it('writes JSON files atomically via temporary file and atomic replacement', () => {
      const testFile = path.join(TEST_ARTIFACTS_DIR, 'atomic-test.json');
      const payload1 = { a: 1, text: 'initial' };
      writeJsonAtomic(testFile, payload1);
      assert.equal(fs.existsSync(testFile), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(testFile, 'utf8')), payload1);

      const payload2 = { a: 2, text: 'overwritten' };
      writeJsonAtomic(testFile, payload2);
      assert.deepEqual(JSON.parse(fs.readFileSync(testFile, 'utf8')), payload2);

      // Verify no dangling temp files remain in directory
      const files = fs.readdirSync(TEST_ARTIFACTS_DIR);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      assert.equal(tmpFiles.length, 0);
    });

    it('emits a valid snr-map.v1.json receipt artifact containing all required metadata and geometry on success', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-receipt.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map.v1.json');

      const currentShapes = [{ id: 'old-agent-1', name: 'LineToolHorizLine' }];
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['old-agent-1'],
        manifest_hash: '9'.repeat(64)
      });

      let nextId = 100;
      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({
            studies: [{ labels: [{ text: '▲ Delta Bull Reversal', price: 2980, time: 1700000000 }] }]
          })
        },
        drawCore: {
          drawShape: async (shape) => {
            const id = `drawn-id-${nextId++}`;
            currentShapes.push({ id, name: shape.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({ success: true, shapes: [...currentShapes] }),
          removeOne: async ({ entity_id }) => {
            const idx = currentShapes.findIndex(s => s.id === entity_id);
            if (idx >= 0) currentShapes.splice(idx, 1);
            return { success: true, removed: true };
          }
        },
        disconnect: () => {}
      };

      const result = await executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath });
      assert.equal(result.success, true);
      assert.equal(fs.existsSync(mapPath), true, 'Map receipt artifact must exist after success');

      const mapReceipt = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      assert.equal(mapReceipt.schema_version, 'snr-map.v1');
      assert.match(mapReceipt.manifest_hash, /^[0-9a-f]{64}$/);
      assert.equal(mapReceipt.symbol, 'OANDA:XAUUSD');
      assert.ok(Number.isFinite(mapReceipt.generated_at_sec));
      assert.equal(mapReceipt.quote_price, 3000.0);
      assert.deepEqual(mapReceipt.created_entity_ids, result.created_entity_ids);
      assert.deepEqual(mapReceipt.retired_entity_ids, ['old-agent-1']);
      assert.ok(Array.isArray(mapReceipt.entities));
      assert.equal(mapReceipt.entities.length, result.created_entity_ids.length);

      // Verify each entity in the receipt contains full geometry / overrides
      for (const ent of mapReceipt.entities) {
        assert.ok(ent.kind, 'Entity must have kind');
        assert.ok(ent.point, 'Entity must have point');
        assert.ok(Number.isFinite(ent.point.time), 'Entity point.time must be finite');
        assert.ok(Number.isFinite(ent.point.price), 'Entity point.price must be finite');
        assert.ok(ent.overrides, 'Entity must have overrides');
      }
    });

    it('ensures snr-map.v1.json artifact remains absent/unchanged when draw verification fails', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-fail-verify.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map.v1.json');

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async () => ({ success: true, entity_id: 'missing-from-list' }),
          listDrawings: async () => ({ success: true, shapes: [] }), // Verification will fail!
          removeOne: async () => ({ success: true, removed: true })
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath }),
        /Verification failed/i
      );

      assert.equal(fs.existsSync(mapPath), false, 'Map receipt artifact must NOT be emitted after failed verification');
    });

    it('ensures snr-map.v1.json artifact remains absent/unchanged when retirement fails', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-fail-retire.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map.v1.json');

      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['retire-me-fail'],
        manifest_hash: '8'.repeat(64)
      });

      const currentShapes = [{ id: 'retire-me-fail', name: 'LineToolHorizLine' }];
      let nextId = 200;

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async (shape) => {
            const id = `new-shape-${nextId++}`;
            currentShapes.push({ id, name: shape.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({ success: true, shapes: [...currentShapes] }),
          removeOne: async () => ({ success: false, removed: false }) // Retirement will fail!
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath }),
        /removal not confirmed|failed to retire/i
      );

      assert.equal(fs.existsSync(mapPath), false, 'Map receipt artifact must NOT be emitted after failed retirement');
    });
  });

  describe('Differential 4H Lifecycle & Crash Resilience', () => {
    it('executes mode "capture-only" without any chart drawing or removal calls', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-cap.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-cap.v1.json');

      let drawCalled = false;
      let removeCalled = false;

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async () => { drawCalled = true; },
          removeOne: async () => { removeCalled = true; }
        },
        disconnect: () => {}
      };

      const res = await executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'capture-only'
      });

      assert.equal(res.success, true);
      assert.equal(res.mode, 'capture-only');
      assert.equal(res.mutation_performed, false);
      assert.equal(drawCalled, false, 'Must not call drawShape in capture-only mode');
      assert.equal(removeCalled, false, 'Must not call removeOne in capture-only mode');
      assert.ok(fs.existsSync(mapPath), 'Must write snr-map.v1.json receipt artifact');

      const receipt = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      assert.equal(receipt.mutation_performed, false);
      assert.equal(receipt.mode, 'capture-only');
    });

    it('executes differential update: preserves kept entities and only appends/deletes differences', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-diff.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-diff.v1.json');

      // Pre-seed manifest with an active entity that matches candidate price (~2980.0)
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['kept-line-id', 'stale-line-id'],
        active_entities: [
          {
            entity_id: 'kept-line-id',
            kind: 'horizontal_line',
            point: { price: 3015.0 },
            price: 3015.0,
            label: '[D - ES @ 3015.00] (AI)'
          },
          {
            entity_id: 'stale-line-id',
            kind: 'horizontal_line',
            point: { price: 2100.0 }, // Far away, will not match candidate
            price: 2100.0,
            label: 'Stale Line'
          }
        ],
        manifest_hash: '3'.repeat(64)
      });

      const currentShapes = [
        { id: 'kept-line-id', name: 'LineToolHorizLine' },
        { id: 'stale-line-id', name: 'LineToolHorizLine' }
      ];
      const newlyDrawn = [];
      const removed = [];
      let nextId = 50;

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async (s) => {
            const id = `drawn-${nextId++}`;
            newlyDrawn.push(id);
            currentShapes.push({ id, name: s.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({ success: true, shapes: [...currentShapes] }),
          removeOne: async ({ entity_id }) => {
            removed.push(entity_id);
            return { success: true, removed: true };
          }
        },
        disconnect: () => {}
      };

      const res = await executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      });

      assert.equal(res.success, true);
      assert.ok(res.kept_entity_ids.includes('kept-line-id'), 'kept-line-id must be kept');
      assert.ok(res.retired_entity_ids.includes('stale-line-id'), 'stale-line-id must be retired');
      assert.ok(removed.includes('stale-line-id'), 'stale-line-id must be removed from chart');
      assert.equal(removed.includes('kept-line-id'), false, 'kept-line-id must NOT be removed from chart');

      // Check updated manifest
      const updatedManifest = loadOwnershipManifest(ownershipPath);
      assert.ok(updatedManifest.entity_ids.includes('kept-line-id'));
      assert.equal(updatedManifest.entity_ids.includes('stale-line-id'), false);
    });

    it('tolerates missing shapes during retirement with soft-delete instead of crashing', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-soft.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-soft.v1.json');

      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['user-deleted-id'],
        active_entities: [
          {
            entity_id: 'user-deleted-id',
            kind: 'horizontal_line',
            point: { price: 2100.0 },
            price: 2100.0
          }
        ],
        manifest_hash: '4'.repeat(64)
      });

      const currentShapes = [];
      let nextId = 1;

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async (s) => {
            const id = `new-${nextId++}`;
            currentShapes.push({ id, name: s.shape });
            return { success: true, entity_id: id };
          },
          listDrawings: async () => ({ success: true, shapes: [...currentShapes] }),
          removeOne: async ({ entity_id }) => {
            // Simulate the exact error that crashed earlier: Shape not found!
            throw new Error(`Shape not found: ${entity_id}`);
          }
        },
        disconnect: () => {}
      };

      // Must NOT crash! Must complete successfully with soft warning!
      const res = await executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      });

      assert.equal(res.success, true);
      assert.ok(res.retired_entity_ids.includes('user-deleted-id'));
    });

    it('rolls back newly created drawings when a draw error occurs midway during append', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-rollback.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['safe-prior-id'],
        manifest_hash: '5'.repeat(64)
      });

      const currentShapes = [{ id: 'safe-prior-id', name: 'LineToolHorizLine' }];
      let drawCallCount = 0;
      let rollbackCalled = false;

      const mockDeps = {
        sleep: async () => {},
        healthCore: { healthCheck: async () => ({ api_available: true }) },
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 }),
          setSymbol: async () => {},
          setTimeframe: async () => {},
          setType: async () => {}
        },
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 2980, high: 2990, low: 2970, close: 2985 },
              { time: 200, open: 2985, high: 3020, low: 2980, close: 3020 },
              { time: 300, open: 3020, high: 3015, low: 2975, close: 2980 },
              { time: 400, open: 2980, high: 2985, low: 2975, close: 2980 }
            ]
          }),
          getPineLabels: async () => ({ studies: [] })
        },
        drawCore: {
          drawShape: async (s) => {
            drawCallCount++;
            if (drawCallCount === 1) {
              // First shape succeeds
              currentShapes.push({ id: 'shape-1-to-be-rolled-back', name: s.shape });
              return { success: true, entity_id: 'shape-1-to-be-rolled-back' };
            }
            // Second shape explodes!
            throw new Error('Network timeout during drawShape');
          },
          listDrawings: async () => ({ success: true, shapes: [...currentShapes] }),
          removeOne: async ({ entity_id }) => {
            if (entity_id === 'shape-1-to-be-rolled-back') {
              rollbackCalled = true;
              const idx = currentShapes.findIndex(s => s.id === entity_id);
              if (idx !== -1) currentShapes.splice(idx, 1);
              return { success: true, removed: true };
            }
            return { success: true, removed: true };
          }
        },
        disconnect: () => {}
      };

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mode: 'diff' }),
        /Network timeout during drawShape/i
      );

      assert.equal(rollbackCalled, true, 'Rollback MUST be called on shape-1-to-be-rolled-back');
      // Previous manifest must remain untouched!
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['safe-prior-id']);
    });
  });
});
