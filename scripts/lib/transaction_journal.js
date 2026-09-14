/**
 * Transaction Journal & Rollback Engine for TradingView SNR Mapping.
 *
 * Requirements:
 * - Records all mutating operations (APPEND, SNAPSHOT, DELETE) in memory.
 * - Supports pre-deletion live snapshotting via draw.snapshotShape.
 * - On abort/failure:
 *   1. Removes newly created shapes via rollbackCreated.
 *   2. Restores previously deleted shapes via draw.restoreShape (LIFO order).
 *   3. Preserves ownership in the ownership manifest:
 *      - If restored shapes receive new IDs, reconciles manifest with the new IDs.
 *      - If no IDs changed, restores the exact original file snapshot.
 *   4. Fails closed and reports structured composite rollback errors if any step fails.
 */

import { hashSnrMapEntities } from './snr_map_v1.js';

function parseJsonSnapshot(snapshot) {
  if (!snapshot?.exists || typeof snapshot.content !== 'string') return null;
  try {
    return JSON.parse(snapshot.content);
  } catch (_) {
    return null;
  }
}

function resolveHashContext(manifest, mapReceipt) {
  const generatedAt = Number.isFinite(manifest?.generated_at_sec)
    ? manifest.generated_at_sec
    : mapReceipt?.generated_at_sec;
  const quotePrice = Number.isFinite(manifest?.quote_price)
    ? manifest.quote_price
    : mapReceipt?.quote_price;

  if (!Number.isFinite(generatedAt) || !Number.isFinite(quotePrice)) {
    return null;
  }

  return {
    schema_version: manifest?.schema_version || mapReceipt?.schema_version,
    symbol: manifest?.symbol || mapReceipt?.symbol || 'OANDA:XAUUSD',
    generated_at_sec: generatedAt,
    quote_price: quotePrice
  };
}

export class TransactionJournal {
  constructor({
    draw,
    ownershipPath,
    resolvedMapPath,
    previousManifest,
    writeOwnership,
    rollbackCreated,
    snapshotFileFn,
    restoreFileFn
  } = {}) {
    this.draw = draw;
    this.ownershipPath = ownershipPath || null;
    this.resolvedMapPath = resolvedMapPath || null;
    this.previousManifest = previousManifest ? JSON.parse(JSON.stringify(previousManifest)) : { entity_ids: [], active_entities: [] };
    this.writeOwnership = writeOwnership || null;
    this.rollbackCreated = rollbackCreated || null;
    this.snapshotFileFn = snapshotFileFn || null;
    this.restoreFileFn = restoreFileFn || null;

    this.created = []; // [{ id, entity }]
    this.snapshots = new Map(); // id -> { snapshot, entity }
    this.deleted = []; // [{ id, snapshot, entity }]
    this.entries = []; // Audit log
    this.committed = false;
    this.rolledBack = false;

    this.initialOwnershipSnapshot = (this.ownershipPath && typeof this.snapshotFileFn === 'function')
      ? this.snapshotFileFn(this.ownershipPath)
      : null;
    this.initialMapSnapshot = (this.resolvedMapPath && typeof this.snapshotFileFn === 'function')
      ? this.snapshotFileFn(this.resolvedMapPath)
      : null;
  }

  recordAppend(id, entity) {
    if (this.committed) throw new Error('Cannot append to committed journal');
    this.created.push({ id, entity });
    this.entries.push({ action: 'APPEND', id, timestamp: new Date().toISOString() });
  }

  recordSnapshot(id, snapshot, entity) {
    this.snapshots.set(id, { snapshot, entity });
    this.entries.push({ action: 'SNAPSHOT', id, timestamp: new Date().toISOString() });
  }

  recordDelete(id) {
    if (this.committed) throw new Error('Cannot delete in committed journal');
    const snap = this.snapshots.get(id);
    this.deleted.push({ id, snapshot: snap?.snapshot, entity: snap?.entity });
    this.entries.push({ action: 'DELETE', id, timestamp: new Date().toISOString() });
  }

  async rollback() {
    if (this.committed) {
      throw new Error('Cannot rollback a committed transaction');
    }
    if (this.rolledBack) {
      return { status: 'already_rolled_back' };
    }
    this.rolledBack = true;

    const rollbackErrors = [];
    const createdIds = this.created.map(c => c.id);

    // 1. Remove newly created shapes
    if (createdIds.length > 0 && this.draw && typeof this.rollbackCreated === 'function') {
      try {
        await this.rollbackCreated(this.draw, createdIds);
      } catch (err) {
        rollbackErrors.push(`Failed to remove newly created shapes: ${err.message}`);
      }
    }

    // 2. Restore deleted shapes in LIFO order
    const restoredMapping = new Map();
    if (this.deleted.length > 0 && this.draw) {
      for (let i = this.deleted.length - 1; i >= 0; i--) {
        const item = this.deleted[i];
        const snapshotToRestore = item.snapshot || item.entity;
        try {
          if (typeof this.draw.restoreShape !== 'function') {
            throw new Error(`Cannot restore entity "${item.id}": draw.restoreShape is not a function`);
          }
          const res = await this.draw.restoreShape(snapshotToRestore);
          const restoredId = res?.restored_entity_id || res?.entity_id || item.id;
          restoredMapping.set(item.id, restoredId);
        } catch (restoreErr) {
          rollbackErrors.push(`Failed to restore entity "${item.id}": ${restoreErr.message}`);
        }
      }
    }

    // 3. Preserve Ownership in manifest
    if (this.ownershipPath) {
      try {
        const anyIdChanged = Array.from(restoredMapping.entries()).some(([oldId, newId]) => oldId !== newId);
        if (this.deleted.length > 0 && anyIdChanged && typeof this.writeOwnership === 'function') {
          const previousMapReceipt = parseJsonSnapshot(this.initialMapSnapshot);
          const updatedIds = (this.previousManifest?.entity_ids || []).map(id =>
            restoredMapping.has(id) ? restoredMapping.get(id) : id
          );
          const sourceEntities = Array.isArray(this.previousManifest?.active_entities)
            ? this.previousManifest.active_entities
            : (Array.isArray(previousMapReceipt?.entities) ? previousMapReceipt.entities : null);
          const hashContext = resolveHashContext(this.previousManifest, previousMapReceipt);
          if (!hashContext || !Array.isArray(sourceEntities)) {
            throw new Error(
              'Cannot reconcile ownership manifest after shape restoration: finite generated_at_sec, quote_price, and active entity records are required to recompute manifest_hash'
            );
          }
          const updatedEntities = sourceEntities.map(ent => {
            const oldId = ent.entity_id;
            if (restoredMapping.has(oldId)) {
              return { ...ent, entity_id: restoredMapping.get(oldId) };
            }
            return ent;
          });
          const updatedEntityIds = new Set(updatedIds);
          if (updatedEntities.length !== updatedEntityIds.size ||
              updatedEntities.some(ent => !updatedEntityIds.has(ent.entity_id))) {
            throw new Error(
              'Cannot reconcile ownership manifest after shape restoration: active entity records do not match entity_ids'
            );
          }
          const payload = {
            ...this.previousManifest,
            entity_ids: updatedIds,
            active_entities: updatedEntities,
            schema_version: hashContext.schema_version,
            symbol: hashContext.symbol,
            generated_at_sec: hashContext.generated_at_sec,
            quote_price: hashContext.quote_price,
            manifest_hash: hashSnrMapEntities({
              schema_version: hashContext.schema_version,
              symbol: hashContext.symbol,
              generated_at_sec: hashContext.generated_at_sec,
              quote_price: hashContext.quote_price,
              entities: updatedEntities
            }),
            updated_at_utc: new Date().toISOString()
          };
          this.writeOwnership(this.ownershipPath, payload);
        } else if (this.initialOwnershipSnapshot && typeof this.restoreFileFn === 'function') {
          this.restoreFileFn(this.ownershipPath, this.initialOwnershipSnapshot);
        }
      } catch (manifestErr) {
        rollbackErrors.push(`Failed to reconcile ownership manifest during rollback: ${manifestErr.message}`);
      }
    }

    // Restore map receipt artifact if initial snapshot exists
    if (this.resolvedMapPath && this.initialMapSnapshot && typeof this.restoreFileFn === 'function') {
      try {
        this.restoreFileFn(this.resolvedMapPath, this.initialMapSnapshot);
      } catch (mapErr) {
        rollbackErrors.push(`Failed to restore map receipt during rollback: ${mapErr.message}`);
      }
    }

    if (rollbackErrors.length > 0) {
      const compositeErr = new Error(`Transaction rollback completed with errors:\n${rollbackErrors.join('\n')}`);
      compositeErr.rollbackErrors = rollbackErrors;
      throw compositeErr;
    }

    return {
      status: 'rolled_back',
      rolled_back_created: createdIds,
      restored_entities: Array.from(restoredMapping.entries()).map(([oldId, newId]) => ({
        old_entity_id: oldId,
        restored_entity_id: newId
      }))
    };
  }

  commit() {
    this.committed = true;
    this.entries.push({ action: 'COMMIT', timestamp: new Date().toISOString() });
  }
}
