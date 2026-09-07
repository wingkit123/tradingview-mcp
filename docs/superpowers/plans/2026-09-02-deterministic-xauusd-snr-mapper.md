# Deterministic XAUUSD SNR Mapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthetic XAUUSD mapper with an evidence-only W/D/H4/H1 line-chart structural mapper that atomically updates only mapper-owned TradingView drawings.

**Architecture:** Put closed-bar structural detection and immutable `snr-map.v1` generation in a pure module. Keep CDP operations in `auto_map_snr.js`: capture the original chart state, obtain real Delta Volume Reversal Finder labels, draw and verify a complete replacement, then remove only entity IDs from the prior ownership manifest. The on-chart brief is a compact, evidence-linked note rather than a price-area overlay.

**Tech Stack:** Node.js ESM, `node:test`, TradingView MCP chart/drawing/data cores, SHA-256.

**Spec:** `C:\Users\Wing Kit\.gemini\config\skills\xauusd-analyst\SKILL.md`

## Global Constraints

- Analyse W/D/H4/H1 using closed bars only; W and D may select only structures within current price plus/minus 50 points.
- Use chart type `Line` during analysis and restore the caller's symbol, resolution, and chart type in a `finally` block.
- Draw only engulfing, confirmed SBR/RBS, two-or-more-pivot trendlines, two-sided ranges/boxes, and real Delta indicator labels; emit no substitute zone when evidence is absent.
- Delta evidence comes only from `getPineLabels({ study_filter: 'Delta Volume Reversal Finder' })`; missing indicator data yields no Delta entity.
- No source-text ownership predicates. Deletion accepts only prior IDs recorded in `artifacts/mapper-owned-entities.json`.
- New drawings must be verified before any prior mapper ID is removed. User drawings are never enumerated for deletion.
- The map payload has `schema_version: 'snr-map.v1'`, canonical JSON, and a SHA-256 `manifest_hash`.

---

### Task 1: Pure evidence-only SNR map builder

**Files:**
- Create: `scripts/lib/snr_map_v1.js`
- Create: `tests/snr_map_v1.test.js`

**Interfaces:**
- Produces: `buildSnrMap({ nowSec, quote, frames, deltaLabels }) -> { manifest, entities, note }`
- Produces: `canonicalizeJson(value)` and `hashManifest(payload)` for stable receipts.

- [ ] **Step 1: Write failing tests**

```js
assert.deepEqual(buildSnrMap({ quote: 3000, frames: noEvidenceFrames, deltaLabels: [] }).entities, []);
assert.equal(map.manifest.schema_version, 'snr-map.v1');
assert.match(map.manifest.manifest_hash, /^[0-9a-f]{64}$/);
assert.equal(map.entities.some(e => e.kind === 'trend_line'), true);
assert.equal(map.entities.some(e => e.kind === 'rectangle' && e.reason === 'RANGE'), true);
assert.equal(map.entities.some(e => e.tags.includes('DELTA_REV')), true);
```

- [ ] **Step 2: Run red test**

Run: `node --test tests/snr_map_v1.test.js`

Expected: failure because the pure builder does not exist.

- [ ] **Step 3: Implement minimal closed-bar builder**

```js
const closed = bars.slice(0, -1);
if (!hasConfirmedEvidence(candidate, closed)) return null;
```

Implement literal engulfing body containment, breakout-and-retest SBR/RBS, two confirmed pivot trendlines, two-sided range boundaries plus 50% equilibrium, and normalized real Delta labels. Do not include PVP/SVP, M15, hard-coded widths, or current-price offsets unless a current user specification adds them.

- [ ] **Step 4: Run green test**

Run: `node --test tests/snr_map_v1.test.js`

Expected: pass.

### Task 2: Atomic mapper ownership transaction

**Files:**
- Modify: `scripts/auto_map_snr.js`
- Create: `tests/auto_map_snr.test.js`

**Interfaces:**
- Consumes: `buildSnrMap`, `loadOwnershipManifest(path)`, `writeOwnershipManifest(path, receipt)`.
- Produces: `executeAutomatedMapping({ deps, ownershipPath }) -> receipt` with `created_entity_ids`, `retired_entity_ids`, and `manifest_hash`.

- [ ] **Step 1: Write failing tests**

```js
assert.deepEqual(removals, []); // until every newly created ID is confirmed by listDrawings
assert.deepEqual(removals, ['old-agent-id']);
assert.equal(removals.includes('manual-id'), false);
```

- [ ] **Step 2: Run red test**

Run: `node --test tests/auto_map_snr.test.js`

Expected: failure because the mapper currently deletes by text before drawing.

- [ ] **Step 3: Implement minimal transaction**

```js
const created = await drawAllEntities(map.entities);
await verifyCreatedIds(created);
await retireOnly(previous.entity_ids);
await writeOwnershipManifest({ entity_ids: created, manifest_hash: map.manifest.manifest_hash });
```

Ensure every failure before verification leaves previous IDs untouched. Capture chart state first, request W/D/H4/H1 with chart type `Line`, read Delta labels, and restore caller state in `finally`. Render the compact note only when evidence exists.

- [ ] **Step 4: Run green tests**

Run: `node --test tests/auto_map_snr.test.js tests/snr_map_v1.test.js`

Expected: pass.

### Task 3: Connector and live acceptance

**Files:**
- Modify: `scripts/auto_map_snr.js` only if connector behaviour requires a narrow adapter injection.
- Create: `artifacts/snr-map.v1.json` during controlled live run; do not commit it unless it is already an artifact convention.

- [ ] **Step 1: Run static checks**

Run: `node --check scripts/auto_map_snr.js && node --test tests/snr_map_v1.test.js tests/auto_map_snr.test.js`

Expected: exit 0.

- [ ] **Step 2: Remove the three user-approved erroneous IDs**

```js
for (const id of ['7Wc8Ry', 'SvdLlF', 'Qv3HFv']) await drawCore.removeOne({ entity_id: id });
```

Require individual successful removals; no text search or bulk cleanup.

- [ ] **Step 3: Controlled live dry run**

Run: `node scripts/auto_map_snr.js --apply`

Expected: receipt has a hash, all created IDs exist, all prior approved IDs are absent, chart returns to its original state, and only evidence-backed mapper objects appear.

- [ ] **Step 4: Final inspection**

Run: `git diff -- scripts/auto_map_snr.js scripts/lib/snr_map_v1.js tests/snr_map_v1.test.js tests/auto_map_snr.test.js` and capture the same connector's chart state and drawing IDs.

Expected: no synthetic price offsets, no canned prices, no text-derived cleanup, and no user drawing mutation.
