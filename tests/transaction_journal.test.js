import test, { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { TransactionJournal } from '../scripts/lib/transaction_journal.js';
import { snapshotShape, restoreShape, mapToolNameToShape } from '../src/core/drawing.js';
import {
  executeAutomatedMapping,
  loadOwnershipManifest,
  writeOwnershipManifest,
  writeSnrMapReceipt,
  verifyChartInventory
} from '../scripts/auto_map_snr.js';
import { hashSnrMapEntities } from '../scripts/lib/snr_map_v1.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_ARTIFACTS_DIR = path.join(__dirname, 'fixtures', 'test_journal_artifacts');

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

function createTestDeps(options = {}) {
  let nextId = 100;
  let currentChartType = 1;
  let currentTf = '60';
  const currentShapes = (options.initialShapes || []).map(s => ({
    id: s.id,
    name: s.name || 'LineToolHorizLine',
    text: s.text || `[AI SNR ${s.id}] (AI)`
  }));
  const drawnShapes = [];
  const removedIds = [];
  const restoredSnapshots = [];
  let saveCount = 0;
  let stateCount = 0;

  return {
    sleep: async () => {},
    healthCore: {
      healthCheck: async () => ({ api_available: true, cdp_connected: true })
    },
    chartCore: {
      getState: async () => {
        stateCount++;
        if (options.getStateFailAt && stateCount >= options.getStateFailAt) {
          throw new Error('CDP Connection Lost: Target closed');
        }
        if (options.identityMismatchAt && stateCount >= options.identityMismatchAt) {
          return { symbol: 'FX:EURUSD', resolution: currentTf, chartType: currentChartType };
        }
        return { symbol: 'OANDA:XAUUSD', resolution: currentTf, chartType: currentChartType };
      },
      setType: async (arg) => {
        currentChartType = Number(arg.chart_type);
        return { success: true, chart_type: currentChartType };
      },
      setTimeframe: async (arg) => {
        currentTf = arg.timeframe;
        return { success: true, timeframe: currentTf };
      },
      setSymbol: async () => ({ success: true, symbol: 'OANDA:XAUUSD' }),
      saveAndVerify: async () => {
        saveCount++;
        if (options.saveFailAt && saveCount === options.saveFailAt) {
          throw new Error('Chart save was not explicitly verified by the active CDP target');
        }
        if (options.saveUnverifiedAt && saveCount === options.saveUnverifiedAt) {
          return { supported: true, status: 'unverified' };
        }
        return { supported: true, status: 'verified', evidence: 'test' };
      }
    },
    dataCore: {
      getQuote: async () => ({ price: 3000.0 }),
      getOhlcv: async () => ({
        bars: generateBarsForTf(currentTf)
      }),
      getPineLabels: async () => ({ studies: [] })
    },
    drawCore: {
      drawShape: async (shape) => {
        if (options.drawFail) throw new Error('Simulated draw failure');
        const id = `new-shape-${nextId++}`;
        drawnShapes.push({ id, shape });
        currentShapes.push({ id, name: shape.shape, text: shape.text || shape.label || `[New ${id}] (AI)` });
        return { success: true, entity_id: id };
      },
      listDrawings: async () => ({
        success: true,
        shapes: currentShapes.map(s => ({ id: s.id, name: s.name }))
      }),
      getProperties: async ({ entity_id }) => {
        const shape = currentShapes.find(s => s.id === entity_id);
        if (!shape) throw new Error(`Shape not found: ${entity_id}`);
        return {
          entity_id,
          properties: { text: { value: shape.text || `[AI SNR ${entity_id}] (AI)` } }
        };
      },
      snapshotShape: async ({ entity_id }) => {
        const shape = currentShapes.find(s => s.id === entity_id);
        if (!shape) throw new Error(`Shape not found: ${entity_id}`);
        return {
          success: true,
          snapshot: {
            entity_id,
            name: shape.name,
            shape: 'horizontal_line',
            point: { time: 1700000000, price: 3000 },
            overrides: { text: shape.text }
          }
        };
      },
      restoreShape: async (input) => {
        const snapshot = input?.snapshot || input;
        restoredSnapshots.push(snapshot);
        const restoredId = `restored-${snapshot.entity_id || nextId++}`;
        currentShapes.push({
          id: restoredId,
          name: snapshot.name || 'LineToolHorizLine',
          text: snapshot.overrides?.text || snapshot.text || `[Restored ${restoredId}] (AI)`
        });
        return {
          success: true,
          restored: true,
          original_entity_id: snapshot.entity_id,
          restored_entity_id: restoredId
        };
      },
      removeOne: async ({ entity_id }) => {
        if (options.removeFailOn && options.removeFailOn === entity_id) {
          return { success: false, removed: false };
        }
        if (options.removeThrowOn && options.removeThrowOn === entity_id) {
          throw new Error(`CDP disconnect during removal of ${entity_id}`);
        }
        removedIds.push(entity_id);
        const idx = currentShapes.findIndex(s => s.id === entity_id);
        if (idx >= 0) currentShapes.splice(idx, 1);
        return { success: true, removed: true };
      }
    },
    disconnect: () => {},
    _tracker: { currentShapes, drawnShapes, removedIds, restoredSnapshots }
  };
}

describe('Connector Snapshot & Restore — src/core/drawing.js', () => {
  it('mapToolNameToShape maps TradingView tool names to standard shapes', () => {
    assert.equal(mapToolNameToShape('LineToolHorizLine'), 'horizontal_line');
    assert.equal(mapToolNameToShape('LineToolRectangle'), 'rectangle');
    assert.equal(mapToolNameToShape('LineToolTrendLine'), 'trend_line');
    assert.equal(mapToolNameToShape('LineToolText'), 'text');
    assert.equal(mapToolNameToShape('LineToolVertLine'), 'vertical_line');
    assert.equal(mapToolNameToShape('custom_shape'), 'custom_shape');
    assert.equal(mapToolNameToShape(null), null);
  });

  it('snapshotShape captures complete shape definition via mock evaluate', async () => {
    const mockEvaluate = async (expr) => {
      if (expr.includes('getShapeById')) {
        return {
          id: 'test-shape-1',
          name: 'LineToolHorizLine',
          points: [{ time: 1700000000, price: 3000 }],
          properties: { text: '[Test] (AI)' }
        };
      }
      return null;
    };
    const mockGetChartApi = async () => 'window.tvWidget';
    const res = await snapshotShape({
      entity_id: 'test-shape-1',
      _deps: { evaluate: mockEvaluate, getChartApi: mockGetChartApi }
    });
    assert.equal(res.success, true);
    assert.equal(res.snapshot.entity_id, 'test-shape-1');
    assert.equal(res.snapshot.shape, 'horizontal_line');
    assert.deepEqual(res.snapshot.point, { time: 1700000000, price: 3000 });
  });

  it('snapshotShape fails closed when entity_id is missing', async () => {
    await assert.rejects(
      () => snapshotShape({}),
      /entity_id is required/i
    );
  });

  it('snapshotShape fails closed when the tool type cannot be recovered', async () => {
    const mockEvaluate = async (expr) => {
      if (expr.includes('getShapeById')) {
        return {
          id: 'untyped-shape',
          name: null,
          points: [{ time: 1700000000, price: 3000 }],
          properties: { text: '[Untyped] (AI)' }
        };
      }
      return null;
    };
    await assert.rejects(
      () => snapshotShape({
        entity_id: 'untyped-shape',
        _deps: { evaluate: mockEvaluate, getChartApi: async () => 'window.tvWidget' }
      }),
      /recoverable TradingView tool name/i
    );
  });

  it('restoreShape recreates shape with drawShape', async () => {
    const mockEvaluate = async (expr) => {
      if (expr.includes('createShape')) return 'restored-tv-id-1';
      if (expr.includes('getAllShapes')) return ['restored-tv-id-1'];
      return null;
    };
    const mockGetChartApi = async () => 'window.tvWidget';
    const snapshot = {
      entity_id: 'orig-id',
      shape: 'horizontal_line',
      point: { time: 1700000000, price: 3000 },
      overrides: { text: '[Restored] (AI)' }
    };
    const res = await restoreShape({
      snapshot,
      _deps: { evaluate: mockEvaluate, getChartApi: mockGetChartApi }
    });
    assert.equal(res.success, true);
    assert.equal(res.restored, true);
    assert.equal(res.original_entity_id, 'orig-id');
    assert.equal(res.restored_entity_id, 'restored-tv-id-1');
  });

  it('restoreShape fails closed when anchor point coordinates are missing', async () => {
    await assert.rejects(
      () => restoreShape({ snapshot: { entity_id: 'x', shape: 'horizontal_line' } }),
      /Cannot restore shape without anchor point/i
    );
  });

  it('restoreShape fails closed when the shape type cannot be recovered', async () => {
    await assert.rejects(
      () => restoreShape({ snapshot: { entity_id: 'x', point: { time: 1700000000, price: 3000 } } }),
      /recoverable TradingView shape type/i
    );
  });
});

describe('TransactionJournal & Rollback Ownership Preservation', () => {
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

  it('restores deleted shape and reconciles ownership manifest when second deletion fails', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'mid-delete-fail-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'mid-delete-fail-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['old-ai-1', 'old-ai-2'],
      active_entities: [
        { entity_id: 'old-ai-1', kind: 'horizontal_line', price: 2900, label: '[Old 1] (AI)' },
        { entity_id: 'old-ai-2', kind: 'horizontal_line', price: 2910, label: '[Old 2] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'old-ai-1', name: 'LineToolHorizLine', text: '[Old 1] (AI)' },
        { id: 'old-ai-2', name: 'LineToolHorizLine', text: '[Old 2] (AI)' }
      ],
      removeFailOn: 'old-ai-2' // First removal succeeds, second fails
    });

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /removal not confirmed|failed to retire/i
    );

    // Rollback must have restored old-ai-1
    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    assert.equal(mockDeps._tracker.restoredSnapshots[0].entity_id, 'old-ai-1');

    // Newly created shapes must have been removed
    const createdIds = mockDeps._tracker.drawnShapes.map(d => d.id);
    for (const createdId of createdIds) {
      assert.equal(mockDeps._tracker.currentShapes.some(s => s.id === createdId), false);
    }

    // Ownership manifest on disk must be reconciled with the restored shape ID and old-ai-2
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-old-ai-1'), true);
    assert.equal(manifest.entity_ids.includes('old-ai-2'), true);
    assert.equal(manifest.active_entities.some(e => e.entity_id === 'restored-old-ai-1'), true);
    assert.equal(manifest.generated_at_sec, 1700000000);
    assert.equal(manifest.quote_price, 3000);
    assert.equal(manifest.manifest_hash, hashSnrMapEntities({
      schema_version: manifest.schema_version,
      symbol: manifest.symbol,
      generated_at_sec: manifest.generated_at_sec,
      quote_price: manifest.quote_price,
      entities: manifest.active_entities
    }));

    const failureReceipt = JSON.parse(fs.readFileSync(
      path.join(TEST_ARTIFACTS_DIR, 'mid-delete-fail-map.failure.json'),
      'utf8'
    ));
    assert.equal(failureReceipt.mutation_performed, true);
    assert.equal(failureReceipt.rollback_attempted, true);
    assert.equal(failureReceipt.rollback_verified, true);
  });

  it('restores deleted shape and preserves ownership when chart.saveAndVerify fails', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'save-fail-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'save-fail-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['retire-me'],
      active_entities: [
        { entity_id: 'retire-me', kind: 'horizontal_line', price: 2950, label: '[Retire Me] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'retire-me', name: 'LineToolHorizLine', text: '[Retire Me] (AI)' }
      ],
      saveFailAt: 2 // Save fails after deletions
    });

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /Chart save was not explicitly verified/i
    );

    // Rollback restored the deleted shape
    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    assert.equal(mockDeps._tracker.currentShapes.some(s => s.id === 'restored-retire-me'), true);

    // Manifest reflects restored shape ID
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-retire-me'), true);
  });

  it('restores deleted shape and preserves ownership when identity check fails mid-run', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'identity-fail-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'identity-fail-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['ident-shape'],
      active_entities: [
        { entity_id: 'ident-shape', kind: 'horizontal_line', price: 2920, label: '[Ident Shape] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'ident-shape', name: 'LineToolHorizLine', text: '[Ident Shape] (AI)' }
      ],
      identityMismatchAt: 8 // Identity switches to EURUSD before manifest commit
    });

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /Chart symbol mismatch/i
    );

    // Rollback restored deleted shape
    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-ident-shape'), true);
  });

  it('restores deleted shape and preserves ownership when CDP disconnects during commit gate', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'cdp-disc-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'cdp-disc-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['disc-shape'],
      active_entities: [
        { entity_id: 'disc-shape', kind: 'horizontal_line', price: 2930, label: '[Disc Shape] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'disc-shape', name: 'LineToolHorizLine', text: '[Disc Shape] (AI)' }
      ],
      getStateFailAt: 8 // Disconnect when reading state before commit
    });

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /CDP Connection Lost/i
    );

    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-disc-shape'), true);
  });

  it('restores deleted shape and preserves ownership when manifest write fails', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'write-fail-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'write-fail-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['write-shape'],
      active_entities: [
        { entity_id: 'write-shape', kind: 'horizontal_line', price: 2940, label: '[Write Shape] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'write-shape', name: 'LineToolHorizLine', text: '[Write Shape] (AI)' }
      ]
    });
    mockDeps.writeSnrMapReceipt = () => { throw new Error('Disk full during receipt write'); };

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /Disk full during receipt write/i
    );

    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-write-shape'), true);
  });

  it('verifyChartInventory fails closed if expected active drawing is absent from chart', async () => {
    const mockDraw = {
      listDrawings: async () => ({
        success: true,
        shapes: [{ id: 'shape-1', name: 'LineToolHorizLine' }]
      }),
      getProperties: async ({ entity_id }) => ({
        properties: { text: { value: `[AI SNR ${entity_id}] (AI)` } }
      })
    };

    await assert.rejects(
      () => verifyChartInventory(mockDraw, {
        expectedActive: [{ entity_id: 'shape-1' }, { entity_id: 'missing-shape' }],
        expectedAbsent: []
      }),
      /Inventory verification failed: active entity "missing-shape" is missing/i
    );
  });

  it('verifyChartInventory fails closed if retired entity persists on chart', async () => {
    const mockDraw = {
      listDrawings: async () => ({
        success: true,
        shapes: [
          { id: 'shape-1', name: 'LineToolHorizLine' },
          { id: 'retired-shape', name: 'LineToolHorizLine' }
        ]
      }),
      getProperties: async ({ entity_id }) => ({
        properties: { text: { value: `[AI SNR ${entity_id}] (AI)` } }
      })
    };

    await assert.rejects(
      () => verifyChartInventory(mockDraw, {
        expectedActive: [{ entity_id: 'shape-1' }],
        expectedAbsent: ['retired-shape']
      }),
      /Inventory verification failed: retired entity "retired-shape" is still present/i
    );
  });

  it('verifyChartInventory fails closed if active entity is missing (AI) marker', async () => {
    const mockDraw = {
      listDrawings: async () => ({
        success: true,
        shapes: [{ id: 'unmarked-shape', name: 'LineToolHorizLine' }]
      }),
      getProperties: async ({ entity_id }) => ({
        properties: { text: { value: 'Manual User Note Without Marker' } }
      })
    };

    await assert.rejects(
      () => verifyChartInventory(mockDraw, {
        expectedActive: [{ entity_id: 'unmarked-shape', label: 'Manual User Note Without Marker' }],
        expectedAbsent: []
      }),
      /Inventory verification failed: active entity "unmarked-shape" is missing exact \(AI\) marker/i
    );
  });

  it('fails closed and rolls back when transaction-bound post-commit chart save verification fails', async () => {
    const ownershipPath = path.join(TEST_ARTIFACTS_DIR, 'post-save-fail-manifest.json');
    const mapPath = path.join(TEST_ARTIFACTS_DIR, 'post-save-fail-map.json');

    writeOwnershipManifest(ownershipPath, {
      entity_ids: ['post-save-shape'],
      active_entities: [
        { entity_id: 'post-save-shape', kind: 'horizontal_line', price: 2960, label: '[Post Save] (AI)' }
      ],
      generated_at_sec: 1700000000,
      quote_price: 3000
    });

    const mockDeps = createTestDeps({
      initialShapes: [
        { id: 'post-save-shape', name: 'LineToolHorizLine', text: '[Post Save] (AI)' }
      ],
      saveUnverifiedAt: 2 // Second save call (post-commit verification) fails verification
    });

    await assert.rejects(
      () => executeAutomatedMapping({
        deps: mockDeps,
        ownershipPath,
        mapPath,
        mode: 'diff'
      }),
      /Transaction-bound post-commit chart save was not verified/i
    );

    // Rollback restored deleted shape
    assert.equal(mockDeps._tracker.restoredSnapshots.length, 1);
    const manifest = loadOwnershipManifest(ownershipPath);
    assert.equal(manifest.entity_ids.includes('restored-post-save-shape'), true);
  });
});
