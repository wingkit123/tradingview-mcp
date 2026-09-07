import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeEntityDiff, isEntityMatch } from '../scripts/lib/diff_engine.js';

describe('Diff Engine — Differential SNR Lifecycle Actions', () => {
  it('identifies identical horizontal lines within tolerance as KEEP', () => {
    const candidate = {
      kind: 'horizontal_line',
      point: { time: 1000, price: 2500.4 },
      reason: 'SWING_HIGH'
    };
    const existing = {
      entity_id: 'tv-id-1',
      kind: 'horizontal_line',
      point: { time: 900, price: 2500.0 },
      reason: 'SWING_HIGH'
    };

    assert.equal(isEntityMatch(candidate, existing, 1.0), true);
    assert.equal(isEntityMatch(candidate, existing, 0.2), false);

    const diff = computeEntityDiff([candidate], [existing], { tolerance: 1.0 });
    assert.equal(diff.keep.length, 1);
    assert.equal(diff.keep[0].entity_id, 'tv-id-1');
    assert.equal(diff.append.length, 0);
    assert.equal(diff.delete.length, 0);
  });

  it('marks newly formed candidates as APPEND', () => {
    const existing = [
      {
        entity_id: 'tv-id-1',
        kind: 'horizontal_line',
        point: { time: 900, price: 2400.0 }
      }
    ];
    const candidates = [
      {
        kind: 'horizontal_line',
        point: { time: 900, price: 2400.0 }
      },
      {
        kind: 'horizontal_line',
        point: { time: 1200, price: 2450.0 }, // New structure
        reason: 'SBR'
      }
    ];

    const diff = computeEntityDiff(candidates, existing, { tolerance: 1.0 });
    assert.equal(diff.keep.length, 1);
    assert.equal(diff.append.length, 1);
    assert.equal(diff.append[0].point.price, 2450.0);
    assert.equal(diff.delete.length, 0);
  });

  it('marks invalidated or breached existing levels as DELETE', () => {
    const existing = [
      {
        entity_id: 'tv-id-1',
        kind: 'horizontal_line',
        point: { time: 900, price: 2400.0 }
      },
      {
        entity_id: 'tv-id-old',
        kind: 'horizontal_line',
        point: { time: 800, price: 2350.0 } // Breached/expired
      }
    ];
    const candidates = [
      {
        kind: 'horizontal_line',
        point: { time: 900, price: 2400.0 }
      }
    ];

    const diff = computeEntityDiff(candidates, existing, { tolerance: 1.0 });
    assert.equal(diff.keep.length, 1);
    assert.equal(diff.append.length, 0);
    assert.equal(diff.delete.length, 1);
    assert.equal(diff.delete[0].entity_id, 'tv-id-old');
  });

  it('handles rectangle ranges correctly for keep and delete', () => {
    const existRange = {
      entity_id: 'range-1',
      kind: 'rectangle',
      point: { time: 100, price: 2420.0 },
      point2: { time: 200, price: 2400.0 }
    };
    const candRange = {
      kind: 'rectangle',
      point: { time: 100, price: 2420.5 },
      point2: { time: 250, price: 2399.8 }
    };

    const diff = computeEntityDiff([candRange], [existRange], { tolerance: 1.0 });
    assert.equal(diff.keep.length, 1);
    assert.equal(diff.keep[0].entity_id, 'range-1');
    assert.equal(diff.append.length, 0);
    assert.equal(diff.delete.length, 0);
  });

  it('replaces text note when briefing content changes', () => {
    const existNote = {
      entity_id: 'note-1',
      kind: 'text',
      label: 'Old Briefing: Range bound'
    };
    const candNote = {
      kind: 'text',
      label: 'New Briefing: Breakout confirmed'
    };

    const diff = computeEntityDiff([candNote], [existNote]);
    // Changed note should result in deleting old and appending new
    assert.equal(diff.keep.length, 0);
    assert.equal(diff.delete.length, 1);
    assert.equal(diff.delete[0].entity_id, 'note-1');
    assert.equal(diff.append.length, 1);
    assert.equal(diff.append[0].label, 'New Briefing: Breakout confirmed');
  });

  it('appends all when previous state is empty', () => {
    const candidates = [
      { kind: 'horizontal_line', point: { price: 2400 } },
      { kind: 'horizontal_line', point: { price: 2450 } }
    ];
    const diff = computeEntityDiff(candidates, []);
    assert.equal(diff.keep.length, 0);
    assert.equal(diff.append.length, 2);
    assert.equal(diff.delete.length, 0);
  });
});
