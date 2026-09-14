import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hashSnrMapEntities } from '../scripts/lib/snr_map_v1.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate_snr_map_receipt.js');

function runValidator(receipt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-receipt-validator-'));
  const file = path.join(dir, 'receipt.json');
  fs.writeFileSync(file, JSON.stringify(receipt), 'utf8');
  try {
    try {
      const stdout = execFileSync(process.execPath, [VALIDATOR, file], {
        cwd: ROOT,
        encoding: 'utf8'
      });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeReceipt(overrides = {}) {
  const receipt = {
    schema_version: 'snr-map.v1',
    symbol: 'OANDA:XAUUSD',
    generated_at_sec: 1700000000,
    quote_price: 3000,
    mode: 'diff',
    entity_count: 1,
    entities: [{
      entity_id: 'shape-1',
      kind: 'horizontal_line',
      shape: 'horizontal_line',
      price: 3000,
      point: { time: 1700000000, price: 3000 },
      label: '[D - SBR @ 3000.00] (AI)',
      overrides: {}
    }],
    chart_save: {
      status: 'verified',
      verified_by: 'same_cdp_connector',
      pre_commit: { status: 'verified' },
      post_commit: { status: 'verified' }
    }
  };
  receipt.manifest_hash = hashSnrMapEntities(receipt);
  return { ...receipt, ...overrides };
}

test('receipt validator accepts same-connector verified mutating receipts', () => {
  const result = runValidator(makeReceipt());
  assert.equal(result.status, 0, result.stderr);
});

test('receipt validator rejects a mutating receipt without final save proof', () => {
  const result = runValidator(makeReceipt({
    chart_save: { success: true, supported: true, status: 'verified' }
  }));
  assert.equal(result.status, 5);
  assert.match(result.stderr, /same-connector verified chart-save/i);
});

test('receipt validator permits capture-only receipts without chart mutation', () => {
  const result = runValidator(makeReceipt({
    mode: 'capture-only',
    chart_save: { supported: false, status: 'unverified' }
  }));
  assert.equal(result.status, 0, result.stderr);
});
