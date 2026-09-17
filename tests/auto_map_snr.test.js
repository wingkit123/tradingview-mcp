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
  writeJsonAtomic,
  acquireMapperLock,
  releaseMapperLock,
  verifyTimeframeCadence,
  verifyChartIdentity,
  rollbackCreatedShapes
} from '../scripts/auto_map_snr.js';
import { hashSnrMapEntities } from '../scripts/lib/snr_map_v1.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_ARTIFACTS_DIR = path.join(__dirname, 'temp_artifacts');

function generateBarsForTf(timeframe, basePrice = 3000) {
  const norm = String(timeframe).toUpperCase();
  const stepSec = (norm === '1W' || norm === 'W') ? 604800 :
                  (norm === '1D' || norm === 'D') ? 86400 :
                  (norm === '240' || norm === '4H' || norm === 'H4') ? 14400 : 3600;
  const baseTime = 1700000000;
  return [
    { time: baseTime + 0 * stepSec, open: basePrice - 20, high: basePrice - 10, low: basePrice - 30, close: basePrice - 15 },
    { time: baseTime + 1 * stepSec, open: basePrice - 15, high: basePrice + 20, low: basePrice - 20, close: basePrice + 20 },
    { time: baseTime + 2 * stepSec, open: basePrice + 20, high: basePrice + 15, low: basePrice - 25, close: basePrice - 20 },
    { time: baseTime + 3 * stepSec, open: basePrice - 20, high: basePrice - 15, low: basePrice - 25, close: basePrice - 20 }
  ];
}

function createMockDeps(overrides = {}) {
  let currentTf = '60';
  let currentChartType = 1;
  let nextId = 1;
  const currentShapes = overrides.initialShapes ? [...overrides.initialShapes] : [];
  const drawnShapes = [];
  const removedIds = [];
  const chartStateHistory = [];

  const baseDeps = {
    sleep: async () => {},
    healthCore: {
      healthCheck: async () => ({ api_available: true }),
      launch: async () => {}
    },
    chartCore: {
      getState: async () => ({
        symbol: 'OANDA:XAUUSD',
        resolution: currentTf,
        chartType: currentChartType
      }),
      setSymbol: async (arg) => { chartStateHistory.push({ op: 'setSymbol', ...arg }); },
      setTimeframe: async (arg) => {
        currentTf = arg.timeframe;
        chartStateHistory.push({ op: 'setTimeframe', ...arg });
      },
      setType: async (arg) => {
        currentChartType = Number(arg.chart_type);
        chartStateHistory.push({ op: 'setType', ...arg });
      },
      saveAndVerify: async () => ({ supported: true, status: 'verified', evidence: 'test' })
    },
    dataCore: {
      getQuote: async () => ({ price: 3000.0 }),
      getOhlcv: async () => ({
        bars: generateBarsForTf(currentTf)
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
      getProperties: async ({ entity_id }) => ({
        properties: { text: { value: `[AI SNR ${entity_id}] (AI)` } }
      }),
      snapshotShape: async ({ entity_id }) => ({
        success: true,
        snapshot: {
          entity_id,
          name: 'LineToolHorizLine',
          shape: 'horizontal_line',
          point: { time: 1700000000, price: 3000 },
          overrides: { text: `[AI SNR ${entity_id}] (AI)` },
          text: `[AI SNR ${entity_id}] (AI)`
        }
      }),
      removeOne: async ({ entity_id }) => {
        removedIds.push(entity_id);
        const idx = currentShapes.findIndex(s => s.id === entity_id);
        if (idx >= 0) currentShapes.splice(idx, 1);
        return { success: true, removed: true };
      },
      // Test-only capability marker. The real connector intentionally does
      // not expose restoreShape until its restore transaction is implemented.
      restoreShape: async () => ({ success: true, restored: true })
    },
    disconnect: () => {}
  };

  return {
    ...baseDeps,
    ...overrides,
    chartCore: { ...baseDeps.chartCore, ...overrides.chartCore },
    dataCore: { ...baseDeps.dataCore, ...overrides.dataCore },
    drawCore: { ...baseDeps.drawCore, ...overrides.drawCore },
    healthCore: { ...baseDeps.healthCore, ...overrides.healthCore },
    _tracker: { currentShapes, drawnShapes, removedIds, chartStateHistory }
  };
}

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

    it('fails closed when a self-contained ownership manifest hash does not recompute', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'hash-mismatch-owned.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['owned-shape'],
        active_entities: [{
          entity_id: 'owned-shape',
          kind: 'horizontal_line',
          shape: 'horizontal_line',
          point: { time: 1700000000, price: 3000 },
          price: 3000,
          label: '[Owned] (AI)'
        }],
        generated_at_sec: 1700000000,
        quote_price: 3000,
        manifest_hash: 'a'.repeat(64)
      });
      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'owned-shape', name: 'LineToolHorizLine' }]
      });

      await assert.rejects(
        () => executeAutomatedMapping({
          deps: mockDeps,
          ownershipPath,
          mapPath: path.join(TEST_ARTIFACTS_DIR, 'hash-mismatch-map.json'),
          mode: 'diff'
        }),
        /manifest_hash mismatch/i
      );
      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.length, 0);
    });

    it('fails closed before any drawing mutation when an existing ownership manifest is corrupt', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'corrupt-owned.json');
      fs.writeFileSync(ownershipPath, '{ this is not valid json', 'utf8');
      const mockDeps = createMockDeps();

      await assert.rejects(
        () => executeAutomatedMapping({
          deps: mockDeps,
          ownershipPath,
          mapPath: path.join(TEST_ARTIFACTS_DIR, 'corrupt-owned-map.json'),
          mode: 'diff'
        }),
        /ownership manifest.*invalid|manifest.*corrupt|manifest.*parse/i
      );

      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.length, 0);
    });
  });

  describe('Cross-Process Single-Writer Lock Lifecycle & Contention', () => {
    it('acquires and releases cross-process mapper lock cleanly', () => {
      const lockPath = path.join(TEST_ARTIFACTS_DIR, 'test.lock');
      const handle = acquireMapperLock(lockPath);
      assert.ok(handle);
      assert.equal(handle.lockPath, lockPath);
      assert.equal(fs.existsSync(lockPath), true);

      releaseMapperLock(handle);
      assert.equal(fs.existsSync(lockPath), false);
    });

    it('rejects concurrent lock acquisition and fails closed with contention error', () => {
      const lockPath = path.join(TEST_ARTIFACTS_DIR, 'contention.lock');
      const handle1 = acquireMapperLock(lockPath);
      assert.ok(handle1);

      // Attempt second acquisition on same lockfile while first is active
      assert.throws(
        () => acquireMapperLock(lockPath),
        /Mapper lock contention|lock file.*already exists|Contention detected/i
      );

      releaseMapperLock(handle1);
    });

    it('recovers from stale lock files whose timestamp exceeds staleMs', () => {
      const lockPath = path.join(TEST_ARTIFACTS_DIR, 'stale.lock');
      // Write stale lock from 5 minutes ago with non-existent PID
      const stalePayload = {
        pid: 999999999,
        createdAt: Date.now() - 300000,
        hostname: 'dead-host',
        created_at_utc: new Date(Date.now() - 300000).toISOString()
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload), 'utf8');

      // Acquire with staleMs = 60000 -> Should clean up stale lock and succeed
      const handle = acquireMapperLock(lockPath, { staleMs: 60000 });
      assert.ok(handle);
      releaseMapperLock(handle);
    });

    it('does not reclaim a lock held by a live process merely because it is old', () => {
      const lockPath = path.join(TEST_ARTIFACTS_DIR, 'live-old.lock');
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - 10 * 60 * 1000,
        created_at_utc: new Date(Date.now() - 10 * 60 * 1000).toISOString()
      }), 'utf8');

      assert.throws(
        () => acquireMapperLock(lockPath, { staleMs: 60000 }),
        /currently held|Contention detected/i
      );
      fs.unlinkSync(lockPath);
    });
  });

  describe('Cadence Verification & Rejection (Condition-Based Readiness)', () => {
    it('validates correct cadences for 1W, 1D, 240, and 60 timeframes', () => {
      const wBars = generateBarsForTf('1W');
      const dBars = generateBarsForTf('1D');
      const h4Bars = generateBarsForTf('240');
      const h1Bars = generateBarsForTf('60');

      assert.equal(verifyTimeframeCadence('1W', wBars).verified, true);
      assert.equal(verifyTimeframeCadence('1D', dBars).verified, true);
      assert.equal(verifyTimeframeCadence('240', h4Bars).verified, true);
      assert.equal(verifyTimeframeCadence('60', h1Bars).verified, true);
    });

    it('rejects non-monotonic or descending bar timestamps', () => {
      const corruptBars = [
        { time: 1000, open: 10, high: 20, low: 5, close: 15 },
        { time: 900, open: 15, high: 25, low: 10, close: 20 }, // Descending!
        { time: 1200, open: 20, high: 30, low: 15, close: 25 }
      ];
      assert.throws(
        () => verifyTimeframeCadence('60', corruptBars),
        /non-monotonic/i
      );
    });

    it('rejects wrong-timeframe data (e.g. feeding 1H bars to 1W)', () => {
      const h1Bars = generateBarsForTf('60'); // 3600s interval
      assert.throws(
        () => verifyTimeframeCadence('1W', h1Bars),
        /Cadence verification failed for 1W.*expected median cadence ~604800s/i
      );
    });

    it('rejects insufficient closed bars (< 2 closed bars)', () => {
      const shortBars = [
        { time: 1000, open: 10, high: 20, low: 5, close: 15 },
        { time: 2000, open: 15, high: 25, low: 10, close: 20 }
      ];
      assert.throws(
        () => verifyTimeframeCadence('60', shortBars),
        /insufficient.*bars/i
      );
    });

    it('fails closed before chart mutation when cadence verification fails in executeAutomatedMapping', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'cadence-fail.json');
      let drawCalled = false;

      const mockDeps = createMockDeps({
        dataCore: {
          getQuote: async () => ({ price: 3000.0 }),
          getOhlcv: async () => ({
            bars: [
              { time: 100, open: 10, high: 20, low: 5, close: 15 },
              { time: 200, open: 15, high: 25, low: 10, close: 20 },
              { time: 300, open: 20, high: 30, low: 15, close: 25 }
            ] // 100s delta is invalid for 1W!
          })
        },
        drawCore: {
          drawShape: async () => { drawCalled = true; }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'cadence-fail-map.json') }),
        /Cadence verification failed for 1W/i
      );
      assert.equal(drawCalled, false, 'Must not perform chart mutations when cadence verification fails');
    });

    it('fails closed when the chart resolution does not actually switch to the requested timeframe', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'resolution-fail.json');
      let drawCalled = false;
      const mockDeps = createMockDeps({
        chartCore: {
          setTimeframe: async () => {},
        },
        dataCore: {
          getOhlcv: async () => ({ bars: generateBarsForTf('1W') }),
        },
        drawCore: {
          drawShape: async () => { drawCalled = true; }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({
          deps: mockDeps,
          ownershipPath,
          mapPath: path.join(TEST_ARTIFACTS_DIR, 'resolution-fail-map.json')
        }),
        /resolution mismatch|Timeframe readiness failed/i
      );
      assert.equal(drawCalled, false, 'Must not perform chart mutations when resolution verification fails');
    });
  });

  describe('Exact Configured Chart Identity Checks', () => {
    it('verifies exact symbol and optional chart/layout identity', () => {
      const state = { symbol: 'OANDA:XAUUSD', chartId: 'chart-123', layoutId: 'layout-456' };
      const res = verifyChartIdentity(state, {
        expectedSymbol: 'OANDA:XAUUSD',
        expectedChartId: 'chart-123',
        expectedLayoutId: 'layout-456'
      });
      assert.equal(res.verified, true);
    });

    it('fails closed when symbol mismatches expected target', () => {
      const state = { symbol: 'FX:EURUSD' };
      assert.throws(
        () => verifyChartIdentity(state, { expectedSymbol: 'OANDA:XAUUSD' }),
        /Chart symbol mismatch.*expected "OANDA:XAUUSD"/i
      );
    });

    it('fails closed when configured chart ID or layout ID mismatches', () => {
      const state = { symbol: 'OANDA:XAUUSD', chartId: 'wrong-id' };
      assert.throws(
        () => verifyChartIdentity(state, { expectedSymbol: 'OANDA:XAUUSD', expectedChartId: 'expected-id' }),
        /Chart ID mismatch/i
      );
    });

    it('fails closed when an expected chart ID is unavailable from the active target', () => {
      assert.throws(
        () => verifyChartIdentity({ symbol: 'OANDA:XAUUSD' }, { expectedChartId: 'chart-123' }),
        /Chart ID mismatch.*chart-123.*undefined/i
      );
    });

    it('verifies the exact configured chart URL when supplied', () => {
      const expectedUrl = 'https://www.tradingview.com/chart/chart-123/?symbol=OANDA%3AXAUUSD';
      const verified = verifyChartIdentity({
        symbol: 'OANDA:XAUUSD',
        chartId: 'chart-123',
        url: expectedUrl
      }, {
        expectedSymbol: 'OANDA:XAUUSD',
        expectedChartId: 'chart-123',
        expectedChartUrl: expectedUrl
      });
      assert.equal(verified.url, expectedUrl);
      assert.throws(
        () => verifyChartIdentity({
          symbol: 'OANDA:XAUUSD',
          chartId: 'chart-123',
          url: 'https://www.tradingview.com/chart/other/'
        }, {
          expectedSymbol: 'OANDA:XAUUSD',
          expectedChartId: 'chart-123',
          expectedChartUrl: expectedUrl
        }),
        /Chart URL mismatch/i
      );
    });
  });

  describe('Atomic Transaction Execution & User Drawing Safety', () => {
    it('creates new drawings, verifies IDs via listDrawings, and retires ONLY previous manifest IDs', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-id-old'],
        manifest_hash: '0'.repeat(64)
      });

      const initialShapes = [
        { id: 'manual-user-id-1', name: 'LineToolRectangle' },
        { id: 'manual-user-id-2', name: 'LineToolHorizLine' },
        { id: 'agent-id-old', name: 'LineToolHorizLine' }
      ];

      const mockDeps = createMockDeps({ initialShapes });
      const result = await executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'transaction-success-map.json') });

      assert.equal(result.success, true);
      assert.ok(result.created_entity_ids.length > 0);
      assert.deepEqual(result.retired_entity_ids, ['agent-id-old']);
      assert.deepEqual(mockDeps._tracker.removedIds, ['agent-id-old']);

      // Check that user manual drawings were NEVER touched or removed
      assert.equal(mockDeps._tracker.removedIds.includes('manual-user-id-1'), false);
      assert.equal(mockDeps._tracker.removedIds.includes('manual-user-id-2'), false);

      // Check manifest was updated with new IDs
      const updatedManifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(updatedManifest.entity_ids, result.created_entity_ids);
      assert.equal(updatedManifest.manifest_hash, result.manifest_hash);

      // Check chart state: timeframe restored, and chart type stays on Line chart (2) as requested
      const lastTypeCall = mockDeps._tracker.chartStateHistory.filter(h => h.op === 'setType').pop();
      const lastTfCall = mockDeps._tracker.chartStateHistory.filter(h => h.op === 'setTimeframe').pop();
      assert.equal(Number(lastTypeCall.chart_type), 2);
      assert.equal(lastTfCall.timeframe, '60');
    });

    it('restores original chart type when keepLineChart is false', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'restore-type-ownership.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: [],
        manifest_hash: '0'.repeat(64)
      });

      const mockDeps = createMockDeps({});
      const result = await executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath: path.join(TEST_ARTIFACTS_DIR, 'restore-type-map.json'),
        keepLineChart: false
      });

      assert.equal(result.success, true);
      const lastTypeCall = mockDeps._tracker.chartStateHistory.filter(h => h.op === 'setType').pop();
      assert.equal(lastTypeCall.chart_type, 1);
    });

    it('fails closed before capture when Line chart mode cannot be read back', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'line-chart-confirmation-fail.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['prior-owned-id'],
        manifest_hash: 'f'.repeat(64)
      });

      const mockDeps = createMockDeps({
        chartCore: {
          getState: async () => ({ symbol: 'OANDA:XAUUSD', resolution: '60', chartType: 1 })
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'line-chart-confirmation-fail-map.json') }),
        /Line chart confirmation failed/i
      );
      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.includes('prior-owned-id'), false);
    });

    it('blocks mutation before bar capture when the connector cannot verify chart save', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'save-capability-fail.json');
      const mockDeps = createMockDeps({ chartCore: { saveAndVerify: undefined } });
      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'save-capability-fail-map.json') }),
        /cannot verify chart save/i
      );
      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.length, 0);
    });

    it('fails closed and aborts retirement if newly created drawings cannot be verified in listDrawings', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-fail.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-id-keep-me'],
        manifest_hash: '1'.repeat(64)
      });

      const mockDeps = createMockDeps({
        drawCore: {
          drawShape: async () => ({ success: true, entity_id: 'ghost-id-missing' }),
          listDrawings: async () => ({ success: true, shapes: [{ id: 'agent-id-keep-me' }] }),
          removeOne: async () => ({ success: true, removed: true })
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'drawing-verification-fail-map.json') }),
        /Verification failed/i
      );

      // Verification failure MUST leave previous manifest IDs untouched!
      const unchangedManifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(unchangedManifest.entity_ids, ['agent-id-keep-me']);
    });

    it('fails closed immediately when TradingView healthCheck returns api_available === false without auto-launching', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'health-fail.json');
      let launchCalled = false;
      const mockDeps = createMockDeps({
        healthCore: {
          healthCheck: async () => ({ api_available: false }),
          launch: async () => { launchCalled = true; }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'health-fail-map.json') }),
        /API unavailable|Health check failed/i
      );
      assert.equal(launchCalled, false, 'Must NOT attempt to launch TradingView on health check failure');
    });

    it('fails closed immediately when initial chart state is missing or invalid', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'initial-state-fail.json');
      const mockDeps = createMockDeps({
        chartCore: {
          getState: async () => null
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'initial-state-fail-map.json') }),
        /Initial chart state/i
      );
    });

    it('aborts, rolls back created shapes, and blocks manifest replacement if removeOne returns removed !== true', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-false-removal.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-prev-1'],
        manifest_hash: '2'.repeat(64)
      });

      let rollbackCalled = false;
      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'agent-prev-1', name: 'LineToolHorizLine' }],
        drawCore: {
          removeOne: async ({ entity_id }) => {
            if (entity_id.startsWith('new-id-')) {
              rollbackCalled = true;
              const idx = mockDeps._tracker.currentShapes.findIndex(s => s.id === entity_id);
              if (idx >= 0) mockDeps._tracker.currentShapes.splice(idx, 1);
              return { success: true, removed: true };
            }
            return { success: false, removed: false };
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'retire-fail-map.json') }),
        /removal not confirmed|failed to retire/i
      );

      assert.equal(rollbackCalled, true, 'Must rollback created shapes on removal failure');
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['agent-prev-1']);
      assert.equal(manifest.manifest_hash, '2'.repeat(64));
    });

    it('restores a snapshotted target when removal reports failure after deleting it', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-uncertain-removal.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'uncertain-removal-map.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-prev-uncertain'],
        active_entities: [{
          entity_id: 'agent-prev-uncertain',
          kind: 'horizontal_line',
          shape: 'horizontal_line',
          point: { time: 1700000000, price: 2500 },
          price: 2500,
          label: '[Uncertain] (AI)'
        }],
        generated_at_sec: 1700000000,
        quote_price: 3000,
        manifest_hash: null
      });

      let mockDeps;
      mockDeps = createMockDeps({
        initialShapes: [{ id: 'agent-prev-uncertain', name: 'LineToolHorizLine' }],
        drawCore: {
          removeOne: async ({ entity_id }) => {
            const idx = mockDeps._tracker.currentShapes.findIndex(s => s.id === entity_id);
            if (idx >= 0) mockDeps._tracker.currentShapes.splice(idx, 1);
            if (entity_id === 'agent-prev-uncertain') {
              return { success: false, removed: false };
            }
            return { success: true, removed: true };
          },
          restoreShape: async (snapshot) => {
            const restoredId = 'restored-agent-prev-uncertain';
            mockDeps._tracker.currentShapes.push({
              id: restoredId,
              name: snapshot.name || 'LineToolHorizLine',
              text: snapshot.text || '[Uncertain] (AI)'
            });
            return {
              success: true,
              restored: true,
              original_entity_id: snapshot.entity_id,
              restored_entity_id: restoredId
            };
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath, mode: 'diff' }),
        /removal not confirmed/i
      );

      assert.equal(mockDeps._tracker.currentShapes.some(s => s.id === 'restored-agent-prev-uncertain'), true);
      const restoredManifest = loadOwnershipManifest(ownershipPath);
      assert.equal(restoredManifest.entity_ids.includes('restored-agent-prev-uncertain'), true);
      const failureReceipt = JSON.parse(fs.readFileSync(
        path.join(TEST_ARTIFACTS_DIR, 'uncertain-removal-map.failure.json'),
        'utf8'
      ));
      assert.equal(failureReceipt.mutation_performed, true);
      assert.equal(failureReceipt.rollback_verified, true);
    });

    it('fails before drawing and leaves prior manifest intact when retirement properties cannot be read', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'getproperties-fail.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-prev-fail-prop'],
        manifest_hash: '7'.repeat(64)
      });

      let rollbackCalled = false;
      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'agent-prev-fail-prop', name: 'LineToolHorizLine' }],
        drawCore: {
          getProperties: async ({ entity_id }) => {
            if (entity_id === 'agent-prev-fail-prop') {
              throw new Error('CDP Connection Disconnected during getProperties');
            }
            return { properties: { text: { value: `[AI SNR ${entity_id}] (AI)` } } };
          },
          removeOne: async ({ entity_id }) => {
            if (entity_id.startsWith('new-id-')) {
              rollbackCalled = true;
              const idx = mockDeps._tracker.currentShapes.findIndex(s => s.id === entity_id);
              if (idx >= 0) mockDeps._tracker.currentShapes.splice(idx, 1);
            }
            return { success: true, removed: true };
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'properties-fail-map.json') }),
        /Failed to read properties|retirement target.*unavailable/i
      );

      assert.equal(rollbackCalled, false, 'No new shapes should exist when retirement preflight fails');
      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['agent-prev-fail-prop']);
    });

    it('rolls back created shapes and leaves prior manifest intact when chart identity changes mid-run', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'identity-change.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['agent-prev-id-change'],
        manifest_hash: '6'.repeat(64)
      });

      let stateCalls = 0;
      let activeResolution = '60';
      let rollbackCalled = false;
      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'agent-prev-id-change', name: 'LineToolHorizLine' }],
        chartCore: {
          getState: async () => {
            stateCalls++;
            if (stateCalls >= 8) {
              // Chart symbol switched unexpectedly to EURUSD!
              return { symbol: 'FX:EURUSD', resolution: activeResolution, chartType: 2 };
            }
            return { symbol: 'OANDA:XAUUSD', resolution: activeResolution, chartType: stateCalls === 2 ? 2 : 1 };
          },
          setTimeframe: async (arg) => {
            activeResolution = arg.timeframe;
          }
        },
        dataCore: {
          getOhlcv: async () => ({ bars: generateBarsForTf(activeResolution) })
        },
        drawCore: {
          removeOne: async ({ entity_id }) => {
            if (entity_id.startsWith('new-id-')) {
              rollbackCalled = true;
              const idx = mockDeps._tracker.currentShapes.findIndex(s => s.id === entity_id);
              if (idx >= 0) mockDeps._tracker.currentShapes.splice(idx, 1);
            }
            return { success: true, removed: true };
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'identity-change-map.json') }),
        /Chart symbol mismatch/i
      );

      assert.equal(rollbackCalled, true, 'Must rollback created shapes on mid-run identity change');
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['agent-prev-id-change']);
    });

    it('emits a valid snr-map.v1.json receipt artifact with target & timeframe verification on success', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-receipt.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map.v1.json');

      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['old-agent-1'],
        manifest_hash: '9'.repeat(64)
      });

      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'old-agent-1', name: 'LineToolHorizLine' }]
      });

      const result = await executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath });
      assert.equal(result.success, true);
      assert.equal(fs.existsSync(mapPath), true, 'Map receipt artifact must exist after success');

      const mapReceipt = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      assert.equal(mapReceipt.schema_version, 'snr-map.v1');
      assert.match(mapReceipt.manifest_hash, /^[0-9a-f]{64}$/);
      assert.equal(mapReceipt.manifest_hash, hashSnrMapEntities(mapReceipt));
      assert.equal(mapReceipt.symbol, 'OANDA:XAUUSD');
      assert.ok(Number.isFinite(mapReceipt.generated_at_sec));
      assert.equal(mapReceipt.quote_price, 3000.0);
      assert.deepEqual(mapReceipt.created_entity_ids, result.created_entity_ids);
      assert.deepEqual(mapReceipt.retired_entity_ids, ['old-agent-1']);
      assert.ok(Array.isArray(mapReceipt.entities));
      assert.equal(mapReceipt.entities.length, result.created_entity_ids.length);

      // Verify verification sections
      assert.ok(mapReceipt.target_verification);
      assert.equal(mapReceipt.target_verification.verified, true);
      assert.ok(mapReceipt.timeframe_verification);
      assert.equal(mapReceipt.timeframe_verification.W.verified, true);
      assert.equal(mapReceipt.timeframe_verification.D.verified, true);
      assert.equal(mapReceipt.timeframe_verification.H4.verified, true);
      assert.equal(mapReceipt.timeframe_verification.H1.verified, true);

      assert.equal(mapReceipt.chart_save.status, 'verified');
      assert.equal(mapReceipt.chart_save.verified_by, 'same_cdp_connector');
      assert.deepEqual(mapReceipt.chart_save.pre_commit, { supported: true, status: 'verified', evidence: 'test' });
      assert.deepEqual(mapReceipt.chart_save.post_commit, { supported: true, status: 'verified', evidence: 'test' });

      const updatedManifest = loadOwnershipManifest(ownershipPath);
      assert.equal(updatedManifest.generated_at_sec, mapReceipt.generated_at_sec);
      assert.equal(updatedManifest.quote_price, mapReceipt.quote_price);
      assert.equal(updatedManifest.manifest_hash, hashSnrMapEntities({
        schema_version: updatedManifest.schema_version,
        symbol: updatedManifest.symbol,
        generated_at_sec: updatedManifest.generated_at_sec,
        quote_price: updatedManifest.quote_price,
        entities: updatedManifest.active_entities
      }));
    });

    it('restores both prior artifacts when the second manifest write fails', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'manifest-transaction.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'map-transaction.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['prior-id'],
        manifest_hash: 'a'.repeat(64)
      });
      writeSnrMapReceipt(mapPath, { status: 'OK', manifest_hash: 'b'.repeat(64) });
      const ownershipBefore = fs.readFileSync(ownershipPath, 'utf8');
      const mapBefore = fs.readFileSync(mapPath, 'utf8');
      const mockDeps = createMockDeps({
        writeSnrMapReceipt: () => { throw new Error('receipt write failed'); }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath }),
        /receipt write failed/i
      );
      assert.equal(fs.readFileSync(ownershipPath, 'utf8'), ownershipBefore);
      assert.equal(fs.readFileSync(mapPath, 'utf8'), mapBefore);
      assert.deepEqual(mockDeps._tracker.currentShapes, []);
    });
  });

  describe('Differential 4H Lifecycle & Crash Resilience', () => {
    it('executes mode "capture-only" without any chart drawing or removal calls', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-cap.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-cap.v1.json');

      let drawCalled = false;
      let removeCalled = false;

      const mockDeps = createMockDeps({
        drawCore: {
          drawShape: async () => { drawCalled = true; },
          removeOne: async () => { removeCalled = true; }
        }
      });

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

      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['kept-line-id', 'stale-line-id'],
        active_entities: [
          {
            entity_id: 'kept-line-id',
            kind: 'horizontal_line',
            point: { price: 2980.0 },
            price: 2980.0,
            label: '[D - ES @ 2980.00] (AI)'
          },
          {
            entity_id: 'stale-line-id',
            kind: 'horizontal_line',
            point: { price: 2100.0 },
            price: 2100.0,
            label: 'Stale Line (AI)'
          }
        ],
        manifest_hash: '3'.repeat(64)
      });

      const initialShapes = [
        { id: 'kept-line-id', name: 'LineToolHorizLine' },
        { id: 'stale-line-id', name: 'LineToolHorizLine' }
      ];

      const mockDeps = createMockDeps({ initialShapes });
      const res = await executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      });

      assert.equal(res.success, true);
      assert.ok(res.kept_entity_ids.includes('kept-line-id'), 'kept-line-id must be kept');
      assert.ok(res.retired_entity_ids.includes('stale-line-id'), 'stale-line-id must be retired');
      assert.ok(mockDeps._tracker.removedIds.includes('stale-line-id'));
      assert.equal(mockDeps._tracker.removedIds.includes('kept-line-id'), false);

      const updatedManifest = loadOwnershipManifest(ownershipPath);
      assert.ok(updatedManifest.entity_ids.includes('kept-line-id'));
      assert.equal(updatedManifest.entity_ids.includes('stale-line-id'), false);
    });

    it('blocks retirement before any create when the connector lacks restore capability', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-no-restore.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-no-restore.v1.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['old-ai-id'],
        active_entities: [{
          entity_id: 'old-ai-id',
          kind: 'horizontal_line',
          point: { price: 2100.0 },
          price: 2100.0,
          label: '[old] (AI)'
        }],
        manifest_hash: '5'.repeat(64)
      });

      const mockDeps = createMockDeps({
        initialShapes: [{ id: 'old-ai-id', name: 'LineToolHorizLine' }]
      });
      delete mockDeps.drawCore.restoreShape;

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath, mode: 'diff' }),
        /requires verified draw\.snapshotShape and draw\.restoreShape capabilities/i
      );
      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.length, 0);
    });

    it('fails closed before drawing when a manifest-owned retirement target is missing from the live chart', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-soft.json');
      const mapPath = path.join(TEST_ARTIFACTS_DIR, 'snr-map-soft.v1.json');

      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['user-deleted-id'],
        active_entities: [
          {
            entity_id: 'user-deleted-id',
            kind: 'horizontal_line',
            point: { price: 2100.0 },
            price: 2100.0,
            label: '[legacy owned line] (AI)'
          }
        ],
        manifest_hash: '4'.repeat(64)
      });

      const mockDeps = createMockDeps({
        drawCore: {
          getProperties: async () => {
            throw new Error('Shape not found: user-deleted-id');
          },
          removeOne: async () => {
            throw new Error('Shape not found: user-deleted-id');
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({
          deps: mockDeps,
          ownershipPath,
          mapPath,
          mode: 'diff'
        }),
        /Shape not found|retirement target.*missing|failed to read properties/i
      );

      assert.equal(mockDeps._tracker.drawnShapes.length, 0);
      assert.equal(mockDeps._tracker.removedIds.length, 0);
      const unchangedManifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(unchangedManifest.entity_ids, ['user-deleted-id']);
    });

    it('rolls back newly created drawings when a draw error occurs midway during append', async () => {
      const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mapper-owned-rollback.json');
      writeOwnershipManifest(ownershipPath, {
        entity_ids: ['safe-prior-id'],
        manifest_hash: '5'.repeat(64)
      });

      let drawCallCount = 0;
      let rollbackCalled = false;

      let mockDeps;
      mockDeps = createMockDeps({
        initialShapes: [{ id: 'safe-prior-id', name: 'LineToolHorizLine' }],
        drawCore: {
          drawShape: async (s) => {
            drawCallCount++;
            if (drawCallCount === 1) {
              mockDeps._tracker.currentShapes.push({ id: 'shape-1-to-be-rolled-back', name: s.shape });
              return { success: true, entity_id: 'shape-1-to-be-rolled-back' };
            }
            throw new Error('Network timeout during drawShape');
          },
          removeOne: async ({ entity_id }) => {
            if (entity_id === 'shape-1-to-be-rolled-back') {
              rollbackCalled = true;
              const idx = mockDeps._tracker.currentShapes.findIndex(s => s.id === entity_id);
              if (idx >= 0) mockDeps._tracker.currentShapes.splice(idx, 1);
            }
            return { success: true, removed: true };
          }
        }
      });

      await assert.rejects(
        () => executeAutomatedMapping({ deps: mockDeps, ownershipPath, mapPath: path.join(TEST_ARTIFACTS_DIR, 'draw-timeout-map.json'), mode: 'diff' }),
        /Network timeout during drawShape/i
      );

      assert.equal(rollbackCalled, true, 'Rollback MUST be called on shape-1-to-be-rolled-back');
      const manifest = loadOwnershipManifest(ownershipPath);
      assert.deepEqual(manifest.entity_ids, ['safe-prior-id']);
    });
  });
});
