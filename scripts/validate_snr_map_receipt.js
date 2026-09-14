import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSnrMapEntities } from './lib/snr_map_v1.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiptPath = process.argv[2] || path.join(__dirname, '..', 'artifacts', 'snr-map.v1.json');

try {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.status === 'FAILED') {
    throw new Error(`Mapper receipt reports FAILED at stage "${receipt.failure_stage || 'unknown'}"`);
  }
  if (!/^[a-f0-9]{64}$/i.test(receipt.manifest_hash || '')) {
    throw new Error('Receipt has no valid 64-character manifest_hash');
  }
  if (!Array.isArray(receipt.entities) || receipt.entity_count !== receipt.entities.length) {
    throw new Error('Receipt entity_count does not match its persisted entities');
  }
  const expected = hashSnrMapEntities(receipt);
  if (receipt.manifest_hash !== expected) {
    throw new Error(`Receipt manifest_hash mismatch: stored ${receipt.manifest_hash}, recomputed ${expected}`);
  }
  if (receipt.mode !== 'capture-only' && (
    receipt.chart_save?.status !== 'verified' ||
    receipt.chart_save?.verified_by !== 'same_cdp_connector'
  )) {
    throw new Error('Mutating receipt does not contain same-connector verified chart-save evidence');
  }
  console.log(JSON.stringify({
    status: receipt.status || 'OK',
    manifest_hash: receipt.manifest_hash,
    entity_count: receipt.entity_count,
    mode: receipt.mode,
    mutation_performed: receipt.mutation_performed === true
  }));
} catch (error) {
  console.error(`[validate_snr_map_receipt] FAILED: ${error.message}`);
  process.exitCode = 5;
}
