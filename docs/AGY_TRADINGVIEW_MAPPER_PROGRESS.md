# TradingView mapper safety progress

## Scope and hard boundary

- Worktree: `C:\Users\Wing Kit\Trading View PineScript\tradingview-mcp`.
- No live TradingView chart was opened, changed, saved, or scheduled during this work.
- Existing dirty files are user-owned and must not be reset, cleaned, broadly staged, or overwritten.
- Cloud automation remains capture-only. No future agent may enable `diff`, `force-refresh`, or any scheduler without explicit user authorization and independent Codex acceptance.

## Ownership iron rule

Every new AI drawing must show the exact visible marker `(AI)` in its text/title/label. A drawing is eligible for mutation only when both conditions hold:

1. its ID is in a validated ownership manifest; and
2. its live visible text/title/label contains `(AI)`.

No marker means user-owned and immutable. A marker without manifest ownership is unowned and must be reported, never bulk-deleted. Never use a text search alone as delete authority.

## Evidence at handoff start (historical)

- `scripts/lib/snr_map_v1.js` already emits close-only EB/ES coordinates, 4.0-point global horizontal clustering, and the required note header `[📌 XAUUSD AI Brief] (AI)`.
- The initial AGY handoff identified unsafe reconciliation paths: corrupt ownership fallback, unconfirmed retirement, incomplete deletion rollback, and unverified save evidence. These paths were independently reviewed and closed in the current worktree.

## Current implementation checkpoint

Status: `CODEX_REVIEWED_OFFLINE_PASS_LIVE_APPLY_BLOCKED`

Completed in this checkpoint:

- Root-cause trace and source inspection completed.
- No live-chart mutation performed in this checkpoint.
- Preserved all existing dirty worktree files without discarding or overwriting user changes.
- Implemented connector-level drawing snapshot and restore:
  - `src/core/drawing.js`: Added `mapToolNameToShape` (mapping TradingView tool types to shapes), `snapshotShape` (capturing shape entity ID, name, points, properties, and visible text), and `restoreShape` (recreating shape via `drawShape` and returning `{ success: true, restored: true, original_entity_id, restored_entity_id }`).
  - `src/tools/drawing.js`: Registered `draw_snapshot_shape` and `draw_restore_shape` MCP tools.
- Implemented transaction journal and atomic rollback engine:
  - `scripts/lib/transaction_journal.js`: Created `TransactionJournal` class supporting `recordAppend`, `recordSnapshot`, `recordDelete`, `commit`, and `rollback`.
  - Atomic LIFO rollback reverses created shapes by ID and restores deleted shapes via `draw.restoreShape`.
  - Reconciles ownership manifest on restore: updates `active_entities` and `entity_ids` with any new IDs assigned during shape restoration so restored drawings do not become unowned orphans; restores exact initial file snapshot if IDs match.
- Integrated transaction journal into mapper:
  - `scripts/auto_map_snr.js`: Integrated `TransactionJournal` into `executeAutomatedMapping` across all mutation phases.
  - Added `verifyChartInventory(draw, { expectedActive, expectedAbsent })`: Validates live chart drawing state, strictly checks presence of expected active entities, absence of retired entities, and visible presence of `(AI)` markers.
  - Added transaction-bound pre-commit and post-commit `chart.saveAndVerify()`; any failure triggers automatic atomic rollback.
- Added strict preflight and receipt evidence:
  - Exact chart ID, optional exact chart URL, symbol, line-chart type, current resolution, quote, and closed-bar cadence are verified through the same connector.
  - Timeframe capture polls actual chart resolution and rejects wrong-timeframe bars before any draw/remove operation.
  - Mutating receipts require `chart_save.status=verified` and `verified_by=same_cdp_connector`; capture-only receipts remain explicitly unverified.
- Added the iron `(AI)` ownership rule to the MuleRun adapter and atomic mapper, including marker checks before retirement and after creation, atomic owner-manifest writes, snapshot/restore rollback, and same-connector chart-save verification.
- Added comprehensive unit and integration test suite:
  - `tests/transaction_journal.test.js`: 16 tests covering tool name mapping, snapshotting, shape restoration, fail-closed coordinate checks, rollback after mid-deletion failure, rollback after save failure, rollback after identity mismatch, rollback after CDP disconnect, rollback after manifest write failure, chart inventory verification (missing shape, retained deleted shape, unmarked shape), and rollback after post-commit chart save failure.
- Verified zero regressions across the independent offline suites; live CDP acceptance is intentionally still open.

Exact machine evidence:

- `node --test tests/transaction_journal.test.js`: 16 passed, 0 failed, 0 skipped (exit code 0).
- Full non-e2e test suite (15 test files):
  `node --test tests/auto_map_snr.test.js tests/transaction_journal.test.js tests/chart_history.test.js tests/chart_indicator.test.js tests/cli.test.js tests/cloud_capture.test.js tests/diff_engine.test.js tests/launch.test.js tests/pine_analyze.test.js tests/replay.test.js tests/sanitization.test.js tests/snr_map_v1.test.js tests/update.test.js tests/user_drawing_pipeline.test.js tests/receipt_validator.test.js`
  **282 passed, 0 failed, 0 skipped, 0 cancelled (exit code 0)**.
- Syntax checks:
  TradingView JavaScript targets and `scripts/run-daily.ps1` parser verified syntax clean (exit code 0).
- Whitespace and diff hygiene:
  `git diff --check` passed clean (exit code 0).
- Current ownership artifact hash:
  `manifest_hash=57225aab62961e11949a6e0cf025057823900685db0fa3e3e1a3c54f7e3c2d79`; recomputed with the repository canonical hash function and matched exactly.
- MuleRun/XAUUSD agent evidence:
  `npm test` returned **56 passed, 0 failed, 0 skipped, 0 cancelled (exit code 0)**; changed JavaScript targets, the repository check, and diff hygiene all passed.
- Guarded runner evidence:
  `-Mode diff -RequireTradingDay -NoLaunchBrowser` returned `SKIPPED` with exit 0 on the weekend; `-Mode diff -NoLaunchBrowser` returned `BLOCKED` at `mutation_guard` with exit 4. No draw/remove was attempted.

Remaining gates and safety requirements:

1. No live TradingView chart was opened, touched, modified, or connected to CDP port 9222.
2. Schedulers remain disabled. Cloud automation remains capture-only.
3. The historical `artifacts/snr-map.v1.json` is hash-valid but is rejected by the new receipt validator for mutation synchronization because its old `chart_save` field lacks `verified_by=same_cdp_connector`; it was not rewritten to fabricate live evidence.
4. Production / live apply remains strictly disabled until an explicit controlled CDP preflight and apply are authorized.

## Non-negotiable completion state

Status reached: `CODEX_REVIEWED_OFFLINE_PASS_LIVE_APPLY_BLOCKED`.
Offline implementation and tests are accepted by Codex. Production apply is not claimed safe because no live TradingView/CDP preflight or controlled apply was performed in this run.

## MuleRun deployment hardening

- `scripts/lib/mulerun-cli.js` invokes MuleRun through `cmd.exe`, separates stdout/stderr, rejects non-zero exits and timeouts, and uses a deployment lock with `finally` cleanup.
- `scripts/deploy-page.js` rejects polluted JSON, serializes version allocation through the lock, and attempts to republish the previous version if publishing the new version fails.
- `scripts/sync-vps.js` uses per-run staging/archive/backup paths, archive SHA-256 verification, remote tests before swap, atomic live replacement, rollback on swap failure, remote cleanup traps, command timeouts, and local `finally` cleanup.
