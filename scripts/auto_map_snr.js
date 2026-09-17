/**
 * auto_map_snr.js
 * Deterministic XAUUSD SNR mapper engine with atomic differential ownership transactions.
 *
 * Requirements:
 * - Pure SNR map generation via snr_map_v1.js.
 * - Condition-based timeframe readiness & closed-bar cadence verification for W/D/H4/H1.
 * - Exact chart identity verification (fail-closed if unavailable/mismatched).
 * - Cross-process single-writer lock covering the full mapper lifecycle.
 * - Captures caller's symbol/resolution/type and restores in finally block.
 * - Lifecycle modes:
 *   - diff (default): Computes Keep / Append / Delete against active manifest.
 *   - capture-only: Pure analysis, writes snr-map.v1.json, zero chart mutations.
 *   - force-refresh: Complete redraw and replacement of all prior entities.
 * - Crash-resilient & Atomic:
 *   1. Cross-process lock prevents concurrent mutation.
 *   2. Rolls back newly drawn shapes on pre-commit failures.
 *   3. Fails closed for corrupt manifests, missing retirement targets, and unconfirmed deletes.
 *   4. Blocks destructive retirement unless the connector exposes a verified restore capability.
 *   5. NEVER deletes drawings by text pattern and NEVER touches manual user drawings.
 *   6. Leaves prior ownership manifest intact upon mid-transaction abort.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import * as defaultChartCore from '../src/core/chart.js';
import * as defaultDrawCore from '../src/core/drawing.js';
import * as defaultDataCore from '../src/core/data.js';
import * as defaultHealthCore from '../src/core/health.js';
import { disconnect as defaultDisconnect } from '../src/connection.js';
import { normalizeResolution } from '../src/wait.js';

import { buildSnrMap, hashSnrMapEntities, SCHEMA_VERSION } from './lib/snr_map_v1.js';
import { computeEntityDiff, DEFAULT_TOLERANCE_PTS } from './lib/diff_engine.js';
import { TransactionJournal } from './lib/transaction_journal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_MANIFEST_PATH = path.join(__dirname, '..', 'artifacts', 'mapper-owned-entities.json');
export const DEFAULT_MAP_PATH = path.join(__dirname, '..', 'artifacts', 'snr-map.v1.json');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
/**
 * Cadence interval expectations per timeframe (in seconds).
 */
export const TIMEFRAME_CADENCE = {
  W: { nominalSec: 604800, minMedianSec: 345600, maxMedianSec: 864000 },
  '1W': { nominalSec: 604800, minMedianSec: 345600, maxMedianSec: 864000 },
  D: { nominalSec: 86400, minMedianSec: 64800, maxMedianSec: 345600 },
  '1D': { nominalSec: 86400, minMedianSec: 64800, maxMedianSec: 345600 },
  H4: { nominalSec: 14400, minMedianSec: 10800, maxMedianSec: 18000 },
  '240': { nominalSec: 14400, minMedianSec: 10800, maxMedianSec: 18000 },
  '4H': { nominalSec: 14400, minMedianSec: 10800, maxMedianSec: 18000 },
  H1: { nominalSec: 3600, minMedianSec: 3000, maxMedianSec: 4200 },
  '60': { nominalSec: 3600, minMedianSec: 3000, maxMedianSec: 4200 },
  '1H': { nominalSec: 3600, minMedianSec: 3000, maxMedianSec: 4200 }
};

/**
 * Cross-process single-writer lock acquisition.
 */
export function acquireMapperLock(lockPath = `${DEFAULT_MANIFEST_PATH}.lock`, { staleMs = 120000 } = {}) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = {
    pid: process.pid,
    createdAt: Date.now(),
    hostname: os.hostname(),
    created_at_utc: new Date().toISOString()
  };

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const data = JSON.parse(raw);
      const isStale = (Date.now() - (data.createdAt || 0)) > staleMs;

      let isAlive = false;
      if (data.pid && typeof data.pid === 'number') {
        try {
          process.kill(data.pid, 0);
          isAlive = true;
        } catch (err) {
          isAlive = err.code === 'EPERM';
        }
      }

      if (isAlive) {
        throw new Error(`Mapper lock is currently held by PID ${data.pid} (acquired at ${data.created_at_utc || data.createdAt}). Contention detected.`);
      }

      if (!isStale) {
        throw new Error(`Mapper lock owner is not alive, but lock file is not stale yet (${lockPath}). Refusing to take over.`);
      }

      // Only a stale lock owned by a dead process may be reclaimed.
      console.warn(`[acquireMapperLock] Cleaning up stale/dead lock file from PID ${data.pid}`);
      try { fs.unlinkSync(lockPath); } catch (_) {}
    } catch (e) {
      if (/Contention detected/i.test(e.message)) {
        throw e;
      }
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    return { lockPath, fd, pid: process.pid };
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(`Mapper lock contention: lock file "${lockPath}" already exists.`);
    }
    throw err;
  }
}

/**
 * Cross-process single-writer lock release.
 */
export function releaseMapperLock(lockHandle) {
  if (!lockHandle || !lockHandle.lockPath) return;
  try {
    if (lockHandle.fd != null) {
      try { fs.closeSync(lockHandle.fd); } catch (_) {}
    }
    if (fs.existsSync(lockHandle.lockPath)) {
      try {
        const content = fs.readFileSync(lockHandle.lockPath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed.pid === process.pid || parsed.pid === lockHandle.pid) {
          fs.unlinkSync(lockHandle.lockPath);
        }
      } catch (_) {
        try { fs.unlinkSync(lockHandle.lockPath); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn(`[releaseMapperLock] Failed to release lock at ${lockHandle.lockPath}:`, err.message);
  }
}

/**
 * Verify closed-bar cadence for a given timeframe.
 * Rejects wrong-timeframe data, corrupted timestamps, or insufficient bars.
 */
export function verifyTimeframeCadence(timeframe, rawBars = []) {
  const normTf = String(timeframe).toUpperCase();
  const spec = TIMEFRAME_CADENCE[normTf] || TIMEFRAME_CADENCE[timeframe];
  if (!spec) {
    throw new Error(`Unsupported timeframe for cadence verification: ${timeframe}`);
  }

  const bars = Array.isArray(rawBars) ? rawBars : (rawBars?.bars || []);
  if (bars.length < 3) {
    throw new Error(`Cadence verification failed for ${timeframe}: insufficient bars (${bars.length} < 3)`);
  }

  // Use closed bars (exclude forming last bar)
  const closed = bars.slice(0, -1);
  if (closed.length < 2) {
    throw new Error(`Cadence verification failed for ${timeframe}: insufficient closed bars (${closed.length} < 2)`);
  }

  const deltas = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const tCurrent = closed[i].time;
    const tNext = closed[i + 1].time;
    if (tCurrent == null || !Number.isFinite(tCurrent) || tNext == null || !Number.isFinite(tNext)) {
      throw new Error(`Cadence verification failed for ${timeframe}: non-finite bar timestamp detected`);
    }
    const dt = tNext - tCurrent;
    if (dt <= 0) {
      throw new Error(`Cadence verification failed for ${timeframe}: non-monotonic bar timestamps (${tCurrent} -> ${tNext})`);
    }
    deltas.push(dt);
  }

  // Compute median interval delta
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianDelta = deltas.length % 2 === 0
    ? (deltas[mid - 1] + deltas[mid]) / 2
    : deltas[mid];

  if (medianDelta < spec.minMedianSec || medianDelta > spec.maxMedianSec) {
    throw new Error(
      `Cadence verification failed for ${timeframe}: expected median cadence ~${spec.nominalSec}s [${spec.minMedianSec}s-${spec.maxMedianSec}s], received median ${medianDelta}s (data from wrong timeframe or corrupted)`
    );
  }

  return {
    verified: true,
    timeframe,
    bar_count: closed.length,
    median_cadence_sec: medianDelta,
    nominal_sec: spec.nominalSec
  };
}

/**
 * Verify chart identity against expected configuration.
 */
export function verifyChartIdentity(actualState, {
  expectedSymbol = 'OANDA:XAUUSD',
  expectedChartId = null,
  expectedChartUrl = null,
  expectedLayoutId = null
} = {}) {
  if (!actualState || typeof actualState !== 'object') {
    throw new Error('Initial chart state unavailable - aborting automated SNR mapping (fail-closed)');
  }
  if (!actualState.symbol) {
    throw new Error('Initial chart state has no symbol - aborting automated SNR mapping (fail-closed)');
  }

  const actualSymbol = String(actualState.symbol).toUpperCase();
  const expSymbol = String(expectedSymbol).toUpperCase();
  if (actualSymbol !== expSymbol) {
    throw new Error(`Chart symbol mismatch: expected "${expectedSymbol}", found "${actualState.symbol}". Aborting (fail-closed).`);
  }

  if (expectedChartId && actualState.chartId !== expectedChartId) {
    throw new Error(`Chart ID mismatch: expected "${expectedChartId}", found "${actualState.chartId}". Aborting (fail-closed).`);
  }

  const actualChartUrl = actualState.url || actualState.tab_url || null;
  if (expectedChartUrl && actualChartUrl !== expectedChartUrl) {
    throw new Error(`Chart URL mismatch: expected "${expectedChartUrl}", found "${actualChartUrl}". Aborting (fail-closed).`);
  }

  if (expectedLayoutId && actualState.layoutId !== expectedLayoutId) {
    throw new Error(`Chart Layout ID mismatch: expected "${expectedLayoutId}", found "${actualState.layoutId}". Aborting (fail-closed).`);
  }

  return {
    verified: true,
    symbol: actualState.symbol,
    resolution: actualState.resolution,
    chartType: actualState.chartType,
    chartId: actualState.chartId || null,
    url: actualChartUrl,
    layoutId: actualState.layoutId || null
  };
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
    console.log(`[writeJsonAtomic] Succeeded writing ${content.length} bytes to ${targetPath}`);
  } catch (err) {
    console.error(`[writeJsonAtomic] Failed to rename temp file to ${targetPath}:`, err.message);
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
export function loadOwnershipManifest(manifestPath = DEFAULT_MANIFEST_PATH, { failOnInvalid = false } = {}) {
  if (!fs.existsSync(manifestPath)) {
    return { entity_ids: [], manifest_hash: null };
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.entity_ids) || !parsed.entity_ids.every(id => typeof id === 'string' && id.length > 0)) {
      throw new Error('entity_ids must be an array of non-empty strings');
    }
    if (new Set(parsed.entity_ids).size !== parsed.entity_ids.length) {
      throw new Error('entity_ids contains duplicates');
    }
    if (parsed.manifest_hash != null && !/^[0-9a-f]{64}$/i.test(parsed.manifest_hash)) {
      throw new Error('manifest_hash must be a 64-character SHA-256 hex string');
    }
    if (parsed.active_entities != null && !Array.isArray(parsed.active_entities)) {
      throw new Error('active_entities must be an array when present');
    }
    if (Array.isArray(parsed.active_entities)) {
      const activeIds = parsed.active_entities.map(entity => entity?.entity_id);
      if (!activeIds.every(id => typeof id === 'string' && id.length > 0)) {
        throw new Error('active_entities contains a record without entity_id');
      }
      if (new Set(activeIds).size !== activeIds.length ||
          activeIds.length !== parsed.entity_ids.length ||
          activeIds.some(id => !parsed.entity_ids.includes(id))) {
        throw new Error('active_entities and entity_ids do not describe the same ownership set');
      }
      for (const entity of parsed.active_entities) {
        if (!/\(AI\)/.test(String(entity.label || ''))) {
          throw new Error(`active entity "${entity.entity_id}" is missing the exact (AI) marker`);
        }
      }
      if (parsed.manifest_hash && Number.isFinite(parsed.generated_at_sec) && Number.isFinite(parsed.quote_price)) {
        const recomputedHash = hashSnrMapEntities({
          schema_version: parsed.schema_version || SCHEMA_VERSION,
          symbol: parsed.symbol || 'OANDA:XAUUSD',
          generated_at_sec: parsed.generated_at_sec,
          quote_price: parsed.quote_price,
          entities: parsed.active_entities
        });
        if (recomputedHash.toLowerCase() !== String(parsed.manifest_hash).toLowerCase()) {
          throw new Error(`manifest_hash mismatch: stored ${parsed.manifest_hash}, recomputed ${recomputedHash}`);
        }
      }
    }

    const res = {
      entity_ids: parsed.entity_ids,
      manifest_hash: parsed.manifest_hash || null,
      schema_version: parsed.schema_version || SCHEMA_VERSION,
      updated_at_utc: parsed.updated_at_utc || null
    };
    if (Number.isFinite(parsed.generated_at_sec)) {
      res.generated_at_sec = parsed.generated_at_sec;
    }
    if (Number.isFinite(parsed.quote_price)) {
      res.quote_price = parsed.quote_price;
    }
    if (parsed.symbol) {
      res.symbol = parsed.symbol;
    }
    if (Array.isArray(parsed.active_entities)) {
      res.active_entities = parsed.active_entities;
    }
    return res;
  } catch (err) {
    const message = `Ownership manifest is invalid at ${manifestPath}: ${err.message}`;
    if (failOnInvalid) throw new Error(message);
    console.warn(`[auto_map_snr] ${message}; using empty defaults for capture-only.`);
    return { entity_ids: [], manifest_hash: null };
  }
}

function readVisibleAiText(properties = {}, fallbackLabel = '') {
  return typeof properties?.properties?.text === 'string'
    ? properties.properties.text
    : (properties?.properties?.text?.value || properties?.text || fallbackLabel || '');
}

/**
 * Verify every planned retirement while the chart is still untouched. A later
 * create must never happen if an owned deletion target cannot be proven live
 * and visibly AI-owned.
 */
async function preflightRetirementTargets(draw, deleteItems = []) {
  for (const delItem of deleteItems) {
    const entityId = delItem?.entity_id;
    if (!entityId) {
      throw new Error('Retirement target is missing an ownership entity_id');
    }
    let properties;
    try {
      properties = await draw.getProperties({ entity_id: entityId });
    } catch (err) {
      throw new Error(`Retirement target "${entityId}" is unavailable before mutation: ${err.message}`);
    }
    const text = readVisibleAiText(properties, delItem?.entity?.label);
    if (!/\(AI\)/.test(text)) {
      throw new Error(`Retirement target "${entityId}" is not visibly AI-owned; missing exact (AI) marker`);
    }
  }
}

async function preflightKeptTargets(draw, diff) {
  const kept = [];
  for (const keepItem of (diff.keep || [])) {
    const entityId = keepItem?.entity_id;
    if (!entityId) {
      if (keepItem?.candidate) diff.append.push(keepItem.candidate);
      continue;
    }
    let properties;
    try {
      properties = await draw.getProperties({ entity_id: entityId });
    } catch (err) {
      console.warn(`[auto_map_snr] Kept target "${entityId}" is unavailable on live chart (${err.message}). Promoting to append to redraw.`);
      if (keepItem?.candidate) {
        diff.append.push(keepItem.candidate);
      }
      continue;
    }
    const text = readVisibleAiText(properties, keepItem?.candidate?.label);
    if (!/\(AI\)/.test(text)) {
      console.warn(`[auto_map_snr] Kept target "${entityId}" is missing exact (AI) marker. Promoting to append to redraw.`);
      if (keepItem?.candidate) {
        diff.append.push(keepItem.candidate);
      }
      continue;
    }
    kept.push(keepItem);
  }
  diff.keep = kept;
}

async function isDrawingPresent(draw, entityId) {
  const drawingsList = await draw.listDrawings();
  return (drawingsList?.shapes || []).some(shape => shape?.id === entityId);
}

function assertCandidateAiLabel(entity) {
  if (!/\(AI\)/.test(String(entity?.label || ''))) {
    throw new Error(`AI candidate is missing the exact (AI) marker: ${JSON.stringify(entity)}`);
  }
}

/**
 * Audit live chart inventory against expected active and retired entity sets.
 * Fails closed if any active entity is absent/unmarked or if any retired entity persists.
 */
export async function verifyChartInventory(draw, { expectedActive = [], expectedAbsent = [] } = {}) {
  const drawingsList = await draw.listDrawings();
  const currentShapes = drawingsList?.shapes || [];
  const currentIds = new Set(currentShapes.map(s => s.id));

  for (const entity of expectedActive) {
    const id = entity.entity_id || entity.id;
    if (!id) continue;
    if (!currentIds.has(id)) {
      throw new Error(`Inventory verification failed: active entity "${id}" is missing from chart drawings`);
    }
    const props = await draw.getProperties({ entity_id: id });
    const text = readVisibleAiText(props, entity.label);
    if (!/\(AI\)/.test(text)) {
      throw new Error(`Inventory verification failed: active entity "${id}" is missing exact (AI) marker`);
    }
  }

  for (const id of expectedAbsent) {
    if (!id) continue;
    if (currentIds.has(id)) {
      throw new Error(`Inventory verification failed: retired entity "${id}" is still present on chart`);
    }
  }

  return { verified: true, active_count: expectedActive.length, checked_shapes: currentShapes.length };
}

/**
 * Persist ownership manifest atomically.
 */
export function writeOwnershipManifest(manifestPath = DEFAULT_MANIFEST_PATH, receipt = {}) {
  const payload = {
    schema_version: receipt.schema_version || SCHEMA_VERSION,
    symbol: receipt.symbol || 'OANDA:XAUUSD',
    entity_ids: receipt.entity_ids || [],
    retired_entity_ids: receipt.retired_entity_ids || [],
    manifest_hash: receipt.manifest_hash || null,
    updated_at_utc: receipt.updated_at_utc || new Date().toISOString()
  };
  if (Number.isFinite(receipt.generated_at_sec)) {
    payload.generated_at_sec = receipt.generated_at_sec;
  }
  if (Number.isFinite(receipt.quote_price)) {
    payload.quote_price = receipt.quote_price;
  }
  if (Array.isArray(receipt.active_entities)) {
    payload.active_entities = receipt.active_entities;
  }
  writeJsonAtomic(manifestPath, payload);
}

/**
 * Persist SNR map receipt artifact atomically.
 */
export function writeSnrMapReceipt(mapPath = DEFAULT_MAP_PATH, receipt = {}) {
  writeJsonAtomic(mapPath, receipt);
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, content: null };
  return { exists: true, content: fs.readFileSync(filePath, 'utf8') };
}

function restoreFileSnapshot(filePath, snapshot) {
  if (snapshot.exists) {
    writeJsonAtomic(filePath, snapshot.content);
  } else if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Roll back newly created drawings on chart upon mid-transaction error.
 */
export async function rollbackCreatedShapes(draw, createdIds = []) {
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
 * Helper to set timeframe and verify cadence via condition polling.
 */
async function fetchTimeframeBarsWithCadence({
  chart,
  data,
  timeframe,
  count,
  sleepFn,
  maxAttempts = 25,
  pollDelayMs = 250
}) {
  await chart.setTimeframe({ timeframe });

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (typeof chart.getState === 'function') {
        const state = await chart.getState();
        const actualResolution = normalizeResolution(state?.resolution);
        const expectedResolution = normalizeResolution(timeframe);
        if (actualResolution !== expectedResolution) {
          throw new Error(`Chart resolution mismatch while capturing ${timeframe}: expected "${timeframe}", found "${state?.resolution}"`);
        }
      }
      const res = await data.getOhlcv({ count });
      const rawBars = res?.bars || [];
      const verification = verifyTimeframeCadence(timeframe, rawBars);
      return { bars: rawBars, verification };
    } catch (err) {
      lastError = err;
      await sleepFn(pollDelayMs);
    }
  }

  throw new Error(`Timeframe readiness failed for "${timeframe}": ${lastError?.message || 'timeout awaiting valid cadence'}`);
}

/**
 * Execute automated SNR mapping with atomic ownership transaction.
 */
export async function executeAutomatedMapping({
  deps = {},
  ownershipPath = DEFAULT_MANIFEST_PATH,
  mapPath,
  mode = 'diff',
  tolerance = DEFAULT_TOLERANCE_PTS,
  keepLineChart = deps.keepLineChart ?? true
} = {}) {
  const resolvedMapPath = mapPath || (
    ownershipPath === DEFAULT_MANIFEST_PATH
      ? DEFAULT_MAP_PATH
      : path.join(path.dirname(ownershipPath), 'snr-map.v1.json')
  );

  const lockPath = deps.lockPath || `${ownershipPath}.lock`;
  const acquireLock = deps.acquireLock || acquireMapperLock;
  const releaseLock = deps.releaseLock || releaseMapperLock;

  const health = deps.healthCore || defaultHealthCore;
  const chart = deps.chartCore || defaultChartCore;
  const draw = deps.drawCore || defaultDrawCore;
  const data = deps.dataCore || defaultDataCore;
  const disconnect = deps.disconnect || defaultDisconnect;
  const sleepFn = deps.sleep || sleep;
  const writeOwnership = deps.writeOwnershipManifest || writeOwnershipManifest;
  const writeMapReceipt = deps.writeSnrMapReceipt || writeSnrMapReceipt;

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting Deterministic XAUUSD SNR Mapper (Mode: ${mode})...`);

  // Step 0: Acquire cross-process single-writer lock
  const lockHandle = await acquireLock(lockPath);

  let originalSymbol = null;
  let originalResolution = null;
  let originalChartType = null;
  let previousManifest = { entity_ids: [], manifest_hash: null };
  let identityCheck = null;
  let timeframeVerification = {};
  let chartSave = { supported: false, status: 'unverified' };
  let postSave = { supported: false, status: 'unverified' };
  let failureStage = 'preflight';
  const newlyCreatedIds = [];
  let journal = null;
  let rollbackAttempted = false;
  let rollbackResult = null;
  let rollbackError = null;

  try {
    // Ensure TV API is available (fail-closed, never auto-launch)
    failureStage = 'cdp_health';
    console.log('[auto_map_snr] Checking health...');
    const check = await health.healthCheck();
    console.log('[auto_map_snr] Health check result:', check?.api_available);
    if (!check?.api_available) {
      throw new Error('TradingView API unavailable - aborting automated SNR mapping (fail-closed)');
    }

    // 1. Load prior ownership manifest
    failureStage = 'manifest_load';
    console.log('[auto_map_snr] Loading prior manifest...');
    previousManifest = loadOwnershipManifest(ownershipPath, { failOnInvalid: mode !== 'capture-only' });

    journal = new TransactionJournal({
      draw,
      ownershipPath,
      resolvedMapPath,
      previousManifest,
      writeOwnership,
      rollbackCreated: rollbackCreatedShapes,
      snapshotFileFn: snapshotFile,
      restoreFileFn: restoreFileSnapshot
    });

    // 2. Capture initial chart state and verify identity (fail-closed if missing or mismatched)
    failureStage = 'identity_preflight';
    console.log('[auto_map_snr] Getting initial state...');
    const initialState = await chart.getState();
    console.log('[auto_map_snr] Initial state symbol:', initialState?.symbol);


    identityCheck = verifyChartIdentity(initialState, {
      expectedSymbol: deps.expectedSymbol || 'OANDA:XAUUSD',
      expectedChartId: deps.expectedChartId,
      expectedChartUrl: deps.expectedChartUrl,
      expectedLayoutId: deps.expectedLayoutId
    });

    originalSymbol = initialState.symbol;
    originalResolution = initialState.resolution || '60';
    originalChartType = initialState.chartType ?? 1;

    // Switch to OANDA:XAUUSD if needed
    failureStage = 'chart_prepare';
    if (originalSymbol !== 'OANDA:XAUUSD') {
      await chart.setSymbol({ symbol: 'OANDA:XAUUSD' });
      await sleepFn(500);
    }

    // Set chart type to Line (type 2) for closed-bar structural capture
    console.log('[auto_map_snr] Setting chart type to Line (2)...');
    await chart.setType({ chart_type: '2' });
    const lineState = await chart.getState();
    verifyChartIdentity(lineState, {
      expectedSymbol: deps.expectedSymbol || 'OANDA:XAUUSD',
      expectedChartId: deps.expectedChartId,
      expectedChartUrl: deps.expectedChartUrl,
      expectedLayoutId: deps.expectedLayoutId
    });
    if (Number(lineState?.chartType) !== 2) {
      throw new Error(`Line chart confirmation failed: expected chart type 2, found "${lineState?.chartType}". Aborting (fail-closed).`);
    }
    if (mode !== 'capture-only' && typeof chart.saveAndVerify !== 'function') {
      throw new Error('Active CDP connector cannot verify chart save. Mutation is blocked (fail-closed).');
    }

    // Fetch quote
    failureStage = 'quote_capture';
    console.log('[auto_map_snr] Fetching quote...');
    const quote = await data.getQuote({});
    const quotePrice = quote?.price || quote?.last || quote?.close;
    console.log('[auto_map_snr] Quote fetched. Price:', quotePrice);
    const nowSec = Math.floor(Date.now() / 1000);

    // Fetch MTF Bars with condition-based cadence verification
    failureStage = 'bar_capture';
    const deltaSignals = [];
    async function tryCollectDelta(tfName) {
      if (typeof data.getDeltaStudySignals === 'function') {
        try {
          const sigs = await data.getDeltaStudySignals();
          if (Array.isArray(sigs)) {
            for (const s of sigs) deltaSignals.push({ ...s, timeframe: tfName });
          }
        } catch (_) {}
      }
    }

    console.log('[auto_map_snr] Capturing 1W bars...');
    const { bars: wBars, verification: wVerif } = await fetchTimeframeBarsWithCadence({
      chart, data, timeframe: '1W', count: 100, sleepFn
    });
    console.log('[auto_map_snr] 1W bars verified:', wBars.length, 'cadence:', wVerif.median_cadence_sec);
    await tryCollectDelta('W');

    console.log('[auto_map_snr] Capturing 1D bars...');
    const { bars: dBars, verification: dVerif } = await fetchTimeframeBarsWithCadence({
      chart, data, timeframe: '1D', count: 150, sleepFn
    });
    console.log('[auto_map_snr] 1D bars verified:', dBars.length, 'cadence:', dVerif.median_cadence_sec);
    await tryCollectDelta('D');

    console.log('[auto_map_snr] Capturing 240 bars...');
    const { bars: h4Bars, verification: h4Verif } = await fetchTimeframeBarsWithCadence({
      chart, data, timeframe: '240', count: 150, sleepFn
    });
    console.log('[auto_map_snr] 240 bars verified:', h4Bars.length, 'cadence:', h4Verif.median_cadence_sec);
    await tryCollectDelta('H4');

    console.log('[auto_map_snr] Capturing 60 bars...');
    const { bars: h1Bars, verification: h1Verif } = await fetchTimeframeBarsWithCadence({
      chart, data, timeframe: '60', count: 200, sleepFn
    });
    console.log('[auto_map_snr] 60 bars verified:', h1Bars.length, 'cadence:', h1Verif.median_cadence_sec);
    await tryCollectDelta('H1');

    timeframeVerification = {
      W: wVerif,
      D: dVerif,
      H4: h4Verif,
      H1: h1Verif
    };

    // Fetch Delta indicator labels with verbose: true
    console.log('[auto_map_snr] Fetching Delta indicator labels...');
    let deltaLabels = [];
    try {
      deltaLabels = await data.getPineLabels({ study_filter: 'Delta Volume Reversal Finder', verbose: true });
      console.log('[auto_map_snr] Delta labels fetched:', deltaLabels?.studies?.length ?? 0);
    } catch (e) {
      console.warn('[auto_map_snr] Delta indicator labels unavailable:', e.message);
    }
    console.log('[auto_map_snr] Delta study plot signals captured:', deltaSignals.length);

    // 3. Build pure evidence-backed SNR map payload
    console.log('[auto_map_snr] Calling buildSnrMap...');
    const map = buildSnrMap({
      nowSec,
      quote,
      frames: { W: wBars, D: dBars, H4: h4Bars, H1: h1Bars },
      deltaLabels,
      deltaSignals
    });
    console.log(`[auto_map_snr] Map generated: ${map.entities.length} entities, manifest hash: ${map.manifest.manifest_hash}`);

    // Mode: capture-only -> Zero chart modifications
    if (mode === 'capture-only') {
      failureStage = 'artifact_write';
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
        entities: map.entities,
        target_verification: identityCheck,
        timeframe_verification: timeframeVerification,
        chart_save: { supported: false, status: 'unverified' }
      };
      console.log('[auto_map_snr] Writing map receipt to:', resolvedMapPath);
      writeMapReceipt(resolvedMapPath, mapReceipt);
      return {
        success: true,
        mode: 'capture-only',
        mutation_performed: false,
        created_entity_ids: [],
        retired_entity_ids: [],
        manifest_hash: map.manifest.manifest_hash,
        entity_count: map.entities.length,
        map_path: resolvedMapPath,
        timeframe_verification: timeframeVerification
      };
    }

    // 4. Identity check before mutation: fail closed if identity changed mid-run
    failureStage = 'identity_mutation_gate';
    const midRunState = await chart.getState();
    verifyChartIdentity(midRunState, {
      expectedSymbol: deps.expectedSymbol || 'OANDA:XAUUSD',
      expectedChartId: deps.expectedChartId,
      expectedChartUrl: deps.expectedChartUrl,
      expectedLayoutId: deps.expectedLayoutId
    });

    // 5. Compute Diff vs Previous Manifest
    failureStage = 'diff_plan';
    let diff;
    if (mode === 'force-refresh') {
      const priorEntities = (previousManifest.active_entities?.length
        ? previousManifest.active_entities
        : (previousManifest.entity_ids || []).map(id => ({ entity_id: id }))
      );
      let existingToDelete = priorEntities;
      if (typeof draw.listDrawings === 'function') {
        try {
          const liveList = await draw.listDrawings();
          const liveIds = new Set((liveList?.shapes || []).map(s => s.id));
          existingToDelete = priorEntities.filter(e => liveIds.has(e.entity_id));
        } catch (e) {
          console.warn('[auto_map_snr] listDrawings failed in force-refresh preflight:', e.message);
        }
      }
      diff = {
        keep: [],
        append: map.entities,
        delete: existingToDelete,
        summary: {
          keep_count: 0,
          append_count: map.entities.length,
          delete_count: existingToDelete.length
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

    // Safety sweep: ensure no unmanaged or duplicate AI Brief notes persist on chart across any session/runner
    if (typeof draw.listDrawings === 'function') {
      try {
        const liveDrawings = await draw.listDrawings();
        const keptIds = new Set(diff.keep.map(k => k.entity_id));
        const deleteIds = new Set(diff.delete.map(d => d.entity_id));

        for (const shape of (liveDrawings.shapes || [])) {
          if (!shape.id || keptIds.has(shape.id) || deleteIds.has(shape.id)) continue;
          if (shape.name === 'text' || shape.shape === 'text' || !shape.name) {
            try {
              const p = await draw.getProperties({ entity_id: shape.id });
              const txt = readVisibleAiText(p);
              if (txt.includes('[📌 XAUUSD AI Brief') && /\(AI\)/.test(txt)) {
                console.log(`[auto_map_snr] Discovered orphan AI Brief on chart (${shape.id}), queueing for retirement.`);
                diff.delete.push({
                  entity_id: shape.id,
                  entity: {
                    entity_id: shape.id,
                    kind: 'text',
                    shape: 'text',
                    label: txt,
                    point: p.points?.[0] || { time: nowSec, price: quotePrice }
                  }
                });
                deleteIds.add(shape.id);
                diff.summary.delete_count++;
              }
            } catch (_) {}
          }
        }
      } catch (scanErr) {
        console.warn('[auto_map_snr] Non-fatal: Orphan brief scan skipped:', scanErr.message);
      }
    }

    console.log(`[auto_map_snr] Diff plan: Append ${diff.append.length}, Keep ${diff.keep.length}, Delete ${diff.delete.length}`);

    if (diff.delete.length > 0 && (
      typeof draw.restoreShape !== 'function' ||
      typeof draw.snapshotShape !== 'function'
    )) {
      failureStage = 'transaction_capability_gate';
      throw new Error('Mutation blocked: retirement requires verified draw.snapshotShape and draw.restoreShape capabilities for rollback');
    }

    // Prove every retirement target before any create. This prevents a stale
    // manifest or a missing/manual shape from leaving new orphan drawings.
    failureStage = 'retirement_preflight';
    await preflightKeptTargets(draw, diff);
    for (const entity of diff.append) assertCandidateAiLabel(entity);
    await preflightRetirementTargets(draw, diff.delete);

    const activeEntities = [];

    // Keep entities carry over directly
    for (const k of diff.keep) {
      activeEntities.push({
        entity_id: k.entity_id,
        ...k.candidate
      });
    }

    // 6. Draw all new APPEND entities
    failureStage = 'draw_verify';
    try {
      for (const entity of diff.append) {
        const overrides = entity.overrides || {};
        if (entity.label && !overrides.text) {
          overrides.text = entity.label;
        }
        console.log(`[auto_map_snr] Drawing append entity: ${entity.kind || entity.shape} @ ${entity.price} (${entity.label})`);
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
        console.log(`[auto_map_snr] Successfully created shape ID: ${res.entity_id}`);
        newlyCreatedIds.push(res.entity_id);
        if (journal) journal.recordAppend(res.entity_id, entity);
        activeEntities.push({
          entity_id: res.entity_id,
          ...entity
        });
      }

      // Verification step: confirm all newly created IDs exist in listDrawings
      if (newlyCreatedIds.length > 0) {
        console.log('[auto_map_snr] Verifying newly created shapes in listDrawings...');
        const drawingsList = await draw.listDrawings();
        const existingIds = new Set((drawingsList.shapes || []).map(s => s.id));

        for (const createdId of newlyCreatedIds) {
          if (!existingIds.has(createdId)) {
            throw new Error(`Verification failed: newly created drawing ID "${createdId}" not found in chart drawings`);
          }
          const createdProperties = await draw.getProperties({ entity_id: createdId });
          const createdText = readVisibleAiText(createdProperties);
          if (!/\(AI\)/.test(createdText)) {
            throw new Error(`Verification failed: newly created drawing ID "${createdId}" is missing the exact (AI) marker`);
          }
        }
        console.log('[auto_map_snr] Verification passed for created shapes.');
      }
    } catch (createErr) {
      console.error('[auto_map_snr] Error during shape creation:', createErr.message);
      throw createErr;
    }

    // 7. Deletion step: safely retire DELETE entities (STRICT SOP: NEVER touch user drawings without (AI) tag)
    failureStage = 'retire_owned';
    const retiredEntityIds = [];
    for (const delItem of diff.delete) {
      const prevId = delItem.entity_id;
      if (!prevId || newlyCreatedIds.includes(prevId)) continue;

      console.log(`[auto_map_snr] Retiring delete entity ID: ${prevId}...`);
      // Re-read immediately before removal to detect a race after preflight.
      let prop = null;
      try {
        prop = await draw.getProperties({ entity_id: prevId });
      } catch (propErr) {
        console.error(`[auto_map_snr] getProperties failed for entity "${prevId}":`, propErr.message);
        throw new Error(`Failed to read properties for entity "${prevId}": ${propErr.message}`);
      }

      const text = readVisibleAiText(prop, delItem.entity?.label);
      if (!/\(AI\)/.test(text)) {
        throw new Error(`Retirement target "${prevId}" lost its exact (AI) marker before removal`);
      }

      // Connector-level shape snapshot before removal
      let snapshot = null;
      if (typeof draw.snapshotShape === 'function') {
        try {
          const snapRes = await draw.snapshotShape({ entity_id: prevId });
          snapshot = snapRes?.snapshot || snapRes;
        } catch (snapErr) {
          throw new Error(`Failed to snapshot retirement target "${prevId}": ${snapErr.message}`);
        }
      }
      if (!snapshot) {
        throw new Error(`Failed to snapshot retirement target "${prevId}": empty snapshot`);
      }
      const snapshotText = readVisibleAiText({ properties: snapshot.properties }, snapshot.text || delItem.entity?.label || '');
      if (!/\(AI\)/.test(snapshotText)) {
        throw new Error(`Failed to snapshot retirement target "${prevId}": recoverable snapshot is missing the exact (AI) marker`);
      }
      if (!snapshot.point || !Number.isFinite(Number(snapshot.point.time)) || !Number.isFinite(Number(snapshot.point.price))) {
        throw new Error(`Failed to snapshot retirement target "${prevId}": recoverable anchor coordinates are missing`);
      }
      if (journal) journal.recordSnapshot(prevId, snapshot, delItem.entity);

      try {
        const res = await draw.removeOne({ entity_id: prevId });
        if (!res || res.removed === false || res.success === false || res.notFound === true) {
          throw new Error(`Failed to retire previous entity ID "${prevId}": removal not confirmed (removed !== true)`);
        }
        console.log(`[auto_map_snr] Successfully retired shape ID: ${prevId}`);
        if (journal) journal.recordDelete(prevId);
        retiredEntityIds.push(prevId);
      } catch (remErr) {
        // A connector may throw or return a false result after the chart has
        // already removed the shape. Probe the live inventory before giving
        // up; if the ID disappeared, record the deletion so rollback restores
        // the snapshotted shape instead of leaving an ownership orphan.
        if (journal && !journal.deleted.some(item => item.id === prevId)) {
          try {
            if (!(await isDrawingPresent(draw, prevId))) {
              journal.recordDelete(prevId);
            }
          } catch (probeErr) {
            // Inventory is itself unavailable. Conservatively attempt restore
            // from the snapshot and surface the probe failure as part of the
            // original fail-closed retirement error.
            journal.recordDelete(prevId);
            remErr.message = `${remErr.message}; could not verify failed removal state: ${probeErr.message}`;
          }
        }
        throw remErr;
      }
    }

    failureStage = 'chart_save';
    chartSave = await chart.saveAndVerify();
    if (chartSave?.status !== 'verified') {
      throw new Error('Chart save was not explicitly verified by the active CDP target');
    }

    // 8. Identity check before manifest write
    failureStage = 'identity_commit_gate';
    try {
      const preManifestState = await chart.getState();
      verifyChartIdentity(preManifestState, {
        expectedSymbol: deps.expectedSymbol || 'OANDA:XAUUSD',
        expectedChartId: deps.expectedChartId,
        expectedChartUrl: deps.expectedChartUrl,
        expectedLayoutId: deps.expectedLayoutId
      });
    } catch (identErr) {
      console.error('[auto_map_snr] Identity check before manifest write failed:', identErr.message);
      throw identErr;
    }

    // Pre-commit inventory verification
    failureStage = 'inventory_verification';
    await verifyChartInventory(draw, {
      expectedActive: activeEntities,
      expectedAbsent: retiredEntityIds
    });

    // 9. Write new ownership receipt atomically (Rollback if manifest write fails)
    failureStage = 'artifact_commit';
    console.log('[auto_map_snr] Writing ownership manifest to:', ownershipPath);
    const allActiveIds = activeEntities.map(e => e.entity_id);
    const activeManifestHash = hashSnrMapEntities({
      generated_at_sec: map.manifest.generated_at_sec,
      quote_price: map.manifest.quote_price,
      entities: activeEntities
    });
    const receipt = {
      schema_version: map.manifest.schema_version,
      symbol: 'OANDA:XAUUSD',
      entity_ids: allActiveIds,
      active_entities: activeEntities,
      retired_entity_ids: retiredEntityIds,
      manifest_hash: activeManifestHash,
      generated_at_sec: map.manifest.generated_at_sec,
      quote_price: map.manifest.quote_price,
      updated_at_utc: new Date().toISOString()
    };

    const mapReceipt = {
      schema_version: map.manifest.schema_version,
      manifest_hash: activeManifestHash,
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
      entities: activeEntities,
      target_verification: identityCheck,
      timeframe_verification: timeframeVerification,
      chart_save: chartSave
    };

    try {
      writeOwnership(ownershipPath, receipt);
      writeMapReceipt(resolvedMapPath, mapReceipt);
      console.log('[auto_map_snr] Successfully wrote ownership manifest and map receipt.');
    } catch (writeErr) {
      console.error('[auto_map_snr] Error writing manifest/receipt:', writeErr.message);
      throw writeErr;
    }

    // 10. Post-transaction inventory verification and transaction-bound chart save
    failureStage = 'post_commit_verification';
    await verifyChartInventory(draw, {
      expectedActive: activeEntities,
      expectedAbsent: retiredEntityIds
    });

    failureStage = 'post_commit_chart_save';
    postSave = await chart.saveAndVerify();
    if (postSave?.status !== 'verified') {
      throw new Error('Transaction-bound post-commit chart save was not verified by the active CDP target');
    }

    // Record both save acknowledgements. The receipt must not claim chart
    // synchronization based only on the pre-commit save if the final
    // transaction-bound save was not verified by this same connector.
    failureStage = 'post_commit_receipt';
    mapReceipt.chart_save = {
      status: 'verified',
      verified_by: 'same_cdp_connector',
      pre_commit: chartSave,
      post_commit: postSave
    };
    writeMapReceipt(resolvedMapPath, mapReceipt);

    if (journal) journal.commit();

    console.log(`[auto_map_snr] Transaction complete: Appended ${newlyCreatedIds.length}, Kept ${diff.keep.length}, Retired ${retiredEntityIds.length}. Active total: ${activeEntities.length}`);

    return {
      success: true,
      mode,
      mutation_performed: newlyCreatedIds.length > 0 || retiredEntityIds.length > 0,
      created_entity_ids: newlyCreatedIds,
      retired_entity_ids: retiredEntityIds,
      kept_entity_ids: diff.keep.map(k => k.entity_id),
      diff_summary: diff.summary,
      manifest_hash: activeManifestHash,
      entity_count: activeEntities.length,
      map_path: resolvedMapPath,
      target_verification: identityCheck,
      timeframe_verification: timeframeVerification,
      chart_save: mapReceipt.chart_save
    };
  } catch (error) {
    const mutationPerformed = newlyCreatedIds.length > 0 || Boolean(journal?.deleted?.length);
    if (journal && !journal.committed) {
      rollbackAttempted = true;
      try {
        console.warn('[auto_map_snr] Mutation aborted before commit, rolling back via TransactionJournal...');
        rollbackResult = await journal.rollback();

        if (mutationPerformed) {
          const restoredMapping = new Map(
            (rollbackResult.restored_entities || []).map(item => [item.old_entity_id, item.restored_entity_id])
          );
          const expectedActive = (previousManifest.active_entities || []).map(entity => ({
            ...entity,
            entity_id: restoredMapping.get(entity.entity_id) || entity.entity_id
          }));
          rollbackResult.inventory = await verifyChartInventory(draw, {
            expectedActive,
            expectedAbsent: newlyCreatedIds
          });

          if (typeof chart.saveAndVerify === 'function') {
            const rollbackSave = await chart.saveAndVerify();
            rollbackResult.chart_save = rollbackSave;
            if (rollbackSave?.status !== 'verified') {
              throw new Error('Rollback chart save was not explicitly verified by the active CDP target');
            }
          }
        }
      } catch (rollbackErr) {
        console.error('[auto_map_snr] Critical: Error during transaction journal rollback:', rollbackErr);
        rollbackError = rollbackErr;
        error.rollbackError = rollbackErr;
      }
    }

    const failureReceipt = {
      schema_version: SCHEMA_VERSION,
      status: 'FAILED',
      mode,
      failure_stage: failureStage,
      errors: [{ message: error?.message || String(error) }],
      manifest_hash: previousManifest.manifest_hash || null,
      previous_manifest_hash: previousManifest.manifest_hash || null,
      mutation_performed: mutationPerformed,
      rollback_attempted: rollbackAttempted,
      rollback_verified: rollbackResult?.status === 'rolled_back' && !rollbackError,
      rollback_error: rollbackError?.message || null,
      target_verification: identityCheck,
      timeframe_verification: timeframeVerification,
      chart_save: {
        status: postSave?.status === 'verified' ? 'verified' : 'unverified',
        verified_by: postSave?.status === 'verified' ? 'same_cdp_connector' : null,
        pre_commit: chartSave,
        post_commit: postSave
      },
      generated_at_utc: new Date().toISOString()
    };
    try {
      const failurePath = path.join(
        path.dirname(resolvedMapPath),
        `${path.basename(resolvedMapPath, path.extname(resolvedMapPath))}.failure.json`
      );
      writeMapReceipt(failurePath, failureReceipt);
    } catch (receiptErr) {
      console.error('[auto_map_snr] Failed to write failure receipt:', receiptErr.message);
    }
    throw error;
  } finally {
    // 10. Restore original chart state (preserve Line chart mode if keepLineChart is true)
    try {
      if (!keepLineChart && originalChartType != null) {
        await chart.setType({ chart_type: originalChartType });
        await sleepFn(150);
      }
      if (originalResolution) {
        await chart.setTimeframe({ timeframe: originalResolution });
        await sleepFn(150);
      }
      if (originalSymbol && originalSymbol !== 'OANDA:XAUUSD') {
        await chart.setSymbol({ symbol: originalSymbol });
        await sleepFn(150);
      }
    } catch (e) {
      console.warn('[auto_map_snr] Error restoring chart state in finally:', e.message);
    }

    // Release cross-process lock
    try {
      await releaseLock(lockHandle);
    } catch (e) {
      console.warn('[auto_map_snr] Error releasing lock:', e.message);
    }

    try {
      if (typeof disconnect === 'function') {
        await disconnect();
      }
    } catch (e) {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  // Direct invocation must be read-only by default. Mutating runs belong behind
  // the guarded runner, which requires an explicit human AllowMutation opt-in.
  let cliMode = 'capture-only';
  let keepLineChart = true;
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
    } else if (args[i] === '--restore-chart-type') {
      keepLineChart = false;
    } else if (args[i] === '--keep-line-chart') {
      keepLineChart = true;
    }
  }

  executeAutomatedMapping({
    mode: cliMode,
    keepLineChart,
    deps: {
      expectedSymbol: process.env.TRADINGVIEW_SYMBOL || 'OANDA:XAUUSD',
      expectedChartId: process.env.TRADINGVIEW_CHART_ID || '1xfXpF1b',
      expectedChartUrl: process.env.TRADINGVIEW_TAB_URL || null
    }
  })
    .then((res) => {
      console.log('Automated SNR Mapping Success:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Automated SNR Mapping Error:', err);
      process.exit(1);
    });
}
