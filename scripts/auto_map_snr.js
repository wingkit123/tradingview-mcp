/**
 * auto_map_snr.js
 * Deterministic XAUUSD SNR mapper engine with atomic differential ownership transactions.
 *
 * Requirements:
 * - Pure SNR map generation via snr_map_v1.js.
 * - Closed-bar analysis across W/D/H4/H1 in Line chart mode.
 * - Captures caller's symbol/resolution/type and restores in finally block.
 * - Lifecycle modes:
 *   - diff (default): Computes Keep / Append / Delete against active manifest.
 *   - capture-only: Pure analysis, writes snr-map.v1.json, zero chart mutations.
 *   - force-refresh: Complete redraw and replacement of all prior entities.
 * - Crash-resilient & Atomic:
 *   1. Rolls back newly drawn shapes if any draw/verification failure occurs.
 *   2. Idempotent soft-removal for drawings already missing (no crash on Shape not found).
 *   3. NEVER deletes drawings by text pattern and NEVER touches manual user drawings.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import * as defaultChartCore from '../src/core/chart.js';
import * as defaultDrawCore from '../src/core/drawing.js';
import * as defaultDataCore from '../src/core/data.js';
import * as defaultHealthCore from '../src/core/health.js';
import { disconnect as defaultDisconnect } from '../src/connection.js';

import { buildSnrMap, SCHEMA_VERSION } from './lib/snr_map_v1.js';
import { computeEntityDiff, DEFAULT_TOLERANCE_PTS } from './lib/diff_engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'artifacts', 'mapper-owned-entities.json');
export const DEFAULT_MAP_PATH = path.join(__dirname, '..', 'artifacts', 'snr-map.v1.json');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Write JSON atomically using temp-file-then-rename.
 */
export function writeJsonAtomic(targetPath, data) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_) {}
    throw err;
  }
}

/**
 * Load ownership manifest of mapper-owned drawing IDs and metadata.
 */
export function loadOwnershipManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      const res = {
        entity_ids: Array.isArray(parsed.entity_ids) ? parsed.entity_ids : [],
        manifest_hash: parsed.manifest_hash || null,
        schema_version: parsed.schema_version || SCHEMA_VERSION,
        updated_at_utc: parsed.updated_at_utc || null
      };
      if (Array.isArray(parsed.active_entities)) {
        res.active_entities = parsed.active_entities;
      }
      return res;
    }
  } catch (err) {
    console.warn(`[auto_map_snr] Failed to load manifest at ${manifestPath}, using empty defaults:`, err.message);
  }
  return { entity_ids: [], manifest_hash: null };
}

/**
 * Persist ownership manifest atomically.
 */
export function writeOwnershipManifest(manifestPath = DEFAULT_MANIFEST_PATH, receipt = {}) {
  const payload = {
    schema_version: receipt.schema_version || SCHEMA_VERSION,
    symbol: receipt.symbol || 'OANDA:XAUUSD',
    entity_ids: receipt.entity_ids || [],
    active_entities: receipt.active_entities || [],
    retired_entity_ids: receipt.retired_entity_ids || [],
    manifest_hash: receipt.manifest_hash || null,
    updated_at_utc: receipt.updated_at_utc || new Date().toISOString()
  };
  writeJsonAtomic(manifestPath, payload);
}

/**
 * Persist SNR map receipt artifact atomically.
 */
export function writeSnrMapReceipt(mapPath = DEFAULT_MAP_PATH, receipt = {}) {
  writeJsonAtomic(mapPath, receipt);
}

/**
 * Roll back newly created drawings on chart upon mid-transaction error.
 */
async function rollbackCreatedShapes(draw, createdIds = []) {
  if (!createdIds || createdIds.length === 0) return;
  try {
    const list = await draw.listDrawings();
    const existingSet = new Set((list?.shapes || []).map(s => s.id));
    for (const id of createdIds) {
      if (existingSet.has(id)) {
        try {
          await draw.removeOne({ entity_id: id });
        } catch (_) {}
      }
    }
  } catch (_) {
    for (const id of createdIds) {
      try {
        await draw.removeOne({ entity_id: id });
      } catch (_) {}
    }
  }
}

/**
 * Execute automated SNR mapping with atomic ownership transaction.
 */
export async function executeAutomatedMapping({
  deps = {},
  ownershipPath = DEFAULT_MANIFEST_PATH,
  mapPath,
  mode = 'diff',
  tolerance = DEFAULT_TOLERANCE_PTS
} = {}) {
  const resolvedMapPath = mapPath || (
    ownershipPath === DEFAULT_MANIFEST_PATH
      ? DEFAULT_MAP_PATH
      : path.join(path.dirname(ownershipPath), 'snr-map.v1.json')
  );

  const health = deps.healthCore || defaultHealthCore;
  const chart = deps.chartCore || defaultChartCore;
  const draw = deps.drawCore || defaultDrawCore;
  const data = deps.dataCore || defaultDataCore;
  const disconnect = deps.disconnect || defaultDisconnect;
  const sleepFn = deps.sleep || sleep;

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting Deterministic XAUUSD SNR Mapper (Mode: ${mode})...`);

  // Ensure TV API is available (fail-closed, never auto-launch)
  const check = await health.healthCheck();
  if (!check?.api_available) {
    throw new Error('TradingView API unavailable - aborting automated SNR mapping (fail-closed)');
  }

  // 1. Load prior ownership manifest
  const previousManifest = loadOwnershipManifest(ownershipPath);

  // 2. Capture initial chart state to restore in finally (fail-closed if missing)
  const initialState = await chart.getState();
  if (!initialState || !initialState.symbol) {
    throw new Error('Initial chart state unavailable - aborting automated SNR mapping (fail-closed)');
  }

  const originalSymbol = initialState.symbol;
  const originalResolution = initialState.resolution || '60';
  const originalChartType = initialState.chartType ?? 1;

  try {
    // Switch to OANDA:XAUUSD if needed
    if (originalSymbol !== 'OANDA:XAUUSD') {
      await chart.setSymbol({ symbol: 'OANDA:XAUUSD' });
      await sleepFn(1000);
    }

    // Set chart type to Line (type 2) for closed-bar structural capture
    await chart.setType({ chart_type: '2' });
    await sleepFn(500);

    // Fetch quote
    const quote = await data.getQuote({});
    const nowSec = Math.floor(Date.now() / 1000);

    // Fetch MTF Bars (Line chart mode)
    await chart.setTimeframe({ timeframe: '1W' });
    await sleepFn(800);
    const wBars = (await data.getOhlcv({ count: 100 }))?.bars || [];

    await chart.setTimeframe({ timeframe: '1D' });
    await sleepFn(800);
    const dBars = (await data.getOhlcv({ count: 150 }))?.bars || [];

    await chart.setTimeframe({ timeframe: '240' });
    await sleepFn(800);
    const h4Bars = (await data.getOhlcv({ count: 150 }))?.bars || [];

    await chart.setTimeframe({ timeframe: '60' });
    await sleepFn(800);
    const h1Bars = (await data.getOhlcv({ count: 200 }))?.bars || [];

    // Fetch Delta indicator labels with verbose: true
    let deltaLabels = [];
    try {
      deltaLabels = await data.getPineLabels({ study_filter: 'Delta Volume Reversal Finder', verbose: true });
    } catch (e) {
      console.warn('[auto_map_snr] Delta indicator labels unavailable:', e.message);
    }

    // 3. Build pure evidence-backed SNR map payload
    const map = buildSnrMap({
      nowSec,
      quote,
      frames: { W: wBars, D: dBars, H4: h4Bars, H1: h1Bars },
      deltaLabels
    });

    console.log(`[auto_map_snr] Map generated: ${map.entities.length} entities, manifest hash: ${map.manifest.manifest_hash}`);

    // Mode: capture-only -> Zero chart modifications
    if (mode === 'capture-only') {
      const mapReceipt = {
        schema_version: map.manifest.schema_version,
        manifest_hash: map.manifest.manifest_hash,
        symbol: map.manifest.symbol || 'OANDA:XAUUSD',
        generated_at_sec: map.manifest.generated_at_sec,
        quote_price: map.manifest.quote_price,
        mode: 'capture-only',
        mutation_performed: false,
        created_entity_ids: [],
        retired_entity_ids: [],
        kept_entity_ids: [],
        entity_count: map.entities.length,
        entities: map.entities
      };
      writeSnrMapReceipt(resolvedMapPath, mapReceipt);
      return {
        success: true,
        mode: 'capture-only',
        mutation_performed: false,
        created_entity_ids: [],
        retired_entity_ids: [],
        manifest_hash: map.manifest.manifest_hash,
        entity_count: map.entities.length,
        map_path: resolvedMapPath
      };
    }

    // 4. Compute Diff vs Previous Manifest
    let diff;
    if (mode === 'force-refresh') {
      diff = {
        keep: [],
        append: map.entities,
        delete: (previousManifest.active_entities?.length
          ? previousManifest.active_entities
          : (previousManifest.entity_ids || []).map(id => ({ entity_id: id }))
        ),
        summary: {
          keep_count: 0,
          append_count: map.entities.length,
          delete_count: previousManifest.entity_ids?.length || 0
        }
      };
    } else {
      // diff mode
      if (previousManifest.active_entities && previousManifest.active_entities.length > 0) {
        diff = computeEntityDiff(map.entities, previousManifest.active_entities, { tolerance });
      } else if (previousManifest.entity_ids && previousManifest.entity_ids.length > 0) {
        // Legacy manifest fallback: retire previous IDs and append all current
        diff = {
          keep: [],
          append: map.entities,
          delete: previousManifest.entity_ids.map(id => ({ entity_id: id })),
          summary: {
            keep_count: 0,
            append_count: map.entities.length,
            delete_count: previousManifest.entity_ids.length
          }
        };
      } else {
        diff = {
          keep: [],
          append: map.entities,
          delete: [],
          summary: {
            keep_count: 0,
            append_count: map.entities.length,
            delete_count: 0
          }
        };
      }
    }

    console.log(`[auto_map_snr] Diff plan: Append ${diff.append.length}, Keep ${diff.keep.length}, Delete ${diff.delete.length}`);

    const newlyCreatedIds = [];
    const activeEntities = [];

    // Keep entities carry over directly
    for (const k of diff.keep) {
      activeEntities.push({
        entity_id: k.entity_id,
        ...k.candidate
      });
    }

    // 5. Draw all new APPEND entities
    try {
      for (const entity of diff.append) {
        const overrides = entity.overrides || {};
        if (entity.label && !overrides.text) {
          overrides.text = entity.label;
        }
        const res = await draw.drawShape({
          shape: entity.shape || entity.kind,
          point: entity.point,
          point2: entity.point2,
          overrides: JSON.stringify(overrides),
          text: entity.label || ''
        });

        if (!res?.entity_id) {
          throw new Error(`Failed to create drawing entity: ${JSON.stringify(entity)}`);
        }
        newlyCreatedIds.push(res.entity_id);
        activeEntities.push({
          entity_id: res.entity_id,
          ...entity
        });
      }

      // 6. Verification step: confirm all newly created IDs exist in listDrawings
      if (newlyCreatedIds.length > 0) {
        const drawingsList = await draw.listDrawings();
        const existingIds = new Set((drawingsList.shapes || []).map(s => s.id));

        for (const createdId of newlyCreatedIds) {
          if (!existingIds.has(createdId)) {
            throw new Error(`Verification failed: newly created drawing ID "${createdId}" not found in chart drawings`);
          }
        }
      }
    } catch (createErr) {
      await rollbackCreatedShapes(draw, newlyCreatedIds);
      throw createErr;
    }

    // 7. Deletion step: safely retire DELETE entities (STRICT SOP: NEVER touch user drawings without (AI) tag)
    const retiredEntityIds = [];
    for (const delItem of diff.delete) {
      const prevId = delItem.entity_id;
      if (!prevId || newlyCreatedIds.includes(prevId)) continue;

      // SOP Guard: verify shape contains (AI) in text before allowing deletion
      try {
        const prop = await draw.getProperties({ entity_id: prevId });
        const text = prop?.properties?.text || prop?.text || '';
        if (!/\(ai\)/i.test(text)) {
          console.warn(`[SOP Guard] Refusing to delete shape "${prevId}": Missing (AI) tag in text "${text}". Preserving user manual drawing.`);
          continue;
        }
      } catch (_) {}

      try {
        const res = await draw.removeOne({ entity_id: prevId });
        if (res && res.removed === false) {
          // Explicitly failed removal of a shape that still exists
          await rollbackCreatedShapes(draw, newlyCreatedIds);
          throw new Error(`Failed to retire previous entity ID "${prevId}": removal not confirmed (removed !== true)`);
        }
        retiredEntityIds.push(prevId);
      } catch (remErr) {
        if (remErr.message && /Shape not found/i.test(remErr.message)) {
          // Object was already deleted (e.g. manually) - soft warning, proceed safely
          console.warn(`[auto_map_snr] Entity "${prevId}" already absent from chart, skipping retirement crash.`);
          retiredEntityIds.push(prevId);
        } else {
          await rollbackCreatedShapes(draw, newlyCreatedIds);
          throw remErr;
        }
      }
    }

    // 8. Write new ownership receipt atomically
    const allActiveIds = activeEntities.map(e => e.entity_id);
    const receipt = {
      schema_version: map.manifest.schema_version,
      symbol: 'OANDA:XAUUSD',
      entity_ids: allActiveIds,
      active_entities: activeEntities,
      retired_entity_ids: retiredEntityIds,
      manifest_hash: map.manifest.manifest_hash,
      updated_at_utc: new Date().toISOString()
    };
    writeOwnershipManifest(ownershipPath, receipt);

    // 9. Write fully canonical map receipt artifact atomically
    const mapReceipt = {
      schema_version: map.manifest.schema_version,
      manifest_hash: map.manifest.manifest_hash,
      symbol: map.manifest.symbol || 'OANDA:XAUUSD',
      generated_at_sec: map.manifest.generated_at_sec,
      quote_price: map.manifest.quote_price,
      mode,
      mutation_performed: newlyCreatedIds.length > 0 || retiredEntityIds.length > 0,
      created_entity_ids: newlyCreatedIds,
      retired_entity_ids: retiredEntityIds,
      kept_entity_ids: diff.keep.map(k => k.entity_id),
      diff_summary: diff.summary,
      entity_count: activeEntities.length,
      entities: activeEntities
    };
    writeSnrMapReceipt(resolvedMapPath, mapReceipt);

    console.log(`[auto_map_snr] Transaction complete: Appended ${newlyCreatedIds.length}, Kept ${diff.keep.length}, Retired ${retiredEntityIds.length}. Active total: ${activeEntities.length}`);

    return {
      success: true,
      mode,
      mutation_performed: newlyCreatedIds.length > 0 || retiredEntityIds.length > 0,
      created_entity_ids: newlyCreatedIds,
      retired_entity_ids: retiredEntityIds,
      kept_entity_ids: diff.keep.map(k => k.entity_id),
      diff_summary: diff.summary,
      manifest_hash: map.manifest.manifest_hash,
      entity_count: activeEntities.length,
      map_path: resolvedMapPath
    };
  } finally {
    // 10. Restore original chart state
    try {
      if (originalChartType != null) {
        await chart.setType({ chart_type: originalChartType });
        await sleepFn(300);
      }
      if (originalResolution) {
        await chart.setTimeframe({ timeframe: originalResolution });
        await sleepFn(300);
      }
      if (originalSymbol && originalSymbol !== 'OANDA:XAUUSD') {
        await chart.setSymbol({ symbol: originalSymbol });
        await sleepFn(300);
      }
    } catch (e) {
      console.warn('[auto_map_snr] Error restoring chart state in finally:', e.message);
    }

    try {
      if (typeof disconnect === 'function') {
        disconnect();
      }
    } catch (e) {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let cliMode = 'diff';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      cliMode = args[i + 1];
      i++;
    } else if (args[i] === '--capture-only') {
      cliMode = 'capture-only';
    } else if (args[i] === '--diff') {
      cliMode = 'diff';
    } else if (args[i] === '--force-refresh') {
      cliMode = 'force-refresh';
    }
  }

  executeAutomatedMapping({ mode: cliMode })
    .then((res) => {
      console.log('Automated SNR Mapping Success:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Automated SNR Mapping Error:', err);
      process.exit(1);
    });
}
