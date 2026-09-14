/**
 * Unit tests for chart readiness, resolution normalization, and idempotent setTimeframe.
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Run: node --test tests/chart_readiness.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForChartReady, normalizeResolution } from '../src/wait.js';
import { setTimeframe } from '../src/core/chart.js';

// ── 1. Resolution normalization symmetric aliases ──────────────────────────

describe('normalizeResolution() — symmetric resolution alias mapping', () => {
  it('normalizes Daily aliases symmetrically (D, 1D)', () => {
    assert.equal(normalizeResolution('D'), normalizeResolution('1D'));
    assert.equal(normalizeResolution('d'), normalizeResolution('1d'));
    assert.equal(normalizeResolution('D'), 'D');
  });

  it('normalizes Weekly aliases symmetrically (W, 1W)', () => {
    assert.equal(normalizeResolution('W'), normalizeResolution('1W'));
    assert.equal(normalizeResolution('w'), normalizeResolution('1w'));
    assert.equal(normalizeResolution('W'), 'W');
  });

  it('normalizes 4-Hour aliases symmetrically (H4, 4H, 240)', () => {
    const canonical = normalizeResolution('240');
    assert.equal(normalizeResolution('H4'), canonical);
    assert.equal(normalizeResolution('4H'), canonical);
    assert.equal(normalizeResolution('h4'), canonical);
    assert.equal(normalizeResolution('4h'), canonical);
    assert.equal(canonical, '240');
  });

  it('normalizes 1-Hour aliases symmetrically (H1, 1H, 60)', () => {
    const canonical = normalizeResolution('60');
    assert.equal(normalizeResolution('H1'), canonical);
    assert.equal(normalizeResolution('1H'), canonical);
    assert.equal(normalizeResolution('h1'), canonical);
    assert.equal(normalizeResolution('1h'), canonical);
    assert.equal(canonical, '60');
  });

  it('normalizes 15-Minute aliases symmetrically (M15, 15M, 15)', () => {
    const canonical = normalizeResolution('15');
    assert.equal(normalizeResolution('M15'), canonical);
    assert.equal(normalizeResolution('15M'), canonical);
    assert.equal(normalizeResolution('m15'), canonical);
    assert.equal(normalizeResolution('15m'), canonical);
    assert.equal(canonical, '15');
  });

  it('normalizes 5-Minute aliases symmetrically (M5, 5M, 5)', () => {
    const canonical = normalizeResolution('5');
    assert.equal(normalizeResolution('M5'), canonical);
    assert.equal(normalizeResolution('5M'), canonical);
    assert.equal(normalizeResolution('m5'), canonical);
    assert.equal(normalizeResolution('5m'), canonical);
    assert.equal(canonical, '5');
  });

  it('handles empty and unrecognized inputs gracefully', () => {
    assert.equal(normalizeResolution(''), '');
    assert.equal(normalizeResolution(null), '');
    assert.equal(normalizeResolution(undefined), '');
    assert.equal(normalizeResolution('UNKNOWN'), 'UNKNOWN');
  });
});

// ── 2. waitForChartReady() readiness & stability ───────────────────────────

describe('waitForChartReady() — mainSeries bars & readiness verification', () => {
  it('passes on canvas-only chart with stable mainSeries bars and no DOM bar elements', async () => {
    let callCount = 0;
    const mockEvaluate = async () => {
      callCount++;
      return {
        isLoading: false,
        barCount: 350, // Positive mainSeries bar evidence
        currentSymbol: 'NASDAQ:AAPL',
        resolution: '60',
      };
    };

    const ready = await waitForChartReady('AAPL', '1H', 1000, {
      evaluate: mockEvaluate,
      pollInterval: 10,
    });

    assert.equal(ready, true);
    assert.ok(callCount >= 2, 'Requires at least 2 consecutive stable polls');
  });

  it('fails closed when barCount is non-positive (zero or negative)', async () => {
    const mockEvaluate = async () => ({
      isLoading: false,
      barCount: 0, // No loaded bars
      currentSymbol: 'XAUUSD',
      resolution: 'D',
    });

    const ready = await waitForChartReady('XAUUSD', '1D', 100, {
      evaluate: mockEvaluate,
      pollInterval: 10,
    });

    assert.equal(ready, false);
  });

  it('remains blocked while loading spinner is active', async () => {
    let callCount = 0;
    const mockEvaluate = async () => {
      callCount++;
      if (callCount < 3) {
        return {
          isLoading: true, // Spinner active
          barCount: 300,
          currentSymbol: 'XAUUSD',
          resolution: 'D',
        };
      }
      return {
        isLoading: false, // Spinner cleared
        barCount: 300,
        currentSymbol: 'XAUUSD',
        resolution: 'D',
      };
    };

    const ready = await waitForChartReady('XAUUSD', 'D', 500, {
      evaluate: mockEvaluate,
      pollInterval: 10,
    });

    assert.equal(ready, true);
    assert.ok(callCount >= 4, 'Waits for spinner to clear then requires 2 stable polls');
  });

  it('stays blocked and returns false when resolution does not match expected resolution', async () => {
    const mockEvaluate = async () => ({
      isLoading: false,
      barCount: 200,
      currentSymbol: 'XAUUSD',
      resolution: '60', // Still on 1H
    });

    const ready = await waitForChartReady('XAUUSD', '1D', 100, {
      evaluate: mockEvaluate,
      pollInterval: 10,
    });

    assert.equal(ready, false);
  });

  it('stays blocked and returns false when symbol does not match expected symbol', async () => {
    const mockEvaluate = async () => ({
      isLoading: false,
      barCount: 200,
      currentSymbol: 'EURUSD',
      resolution: '60',
    });

    const ready = await waitForChartReady('XAUUSD', '1H', 100, {
      evaluate: mockEvaluate,
      pollInterval: 10,
    });

    assert.equal(ready, false);
  });
});

// ── 3. setTimeframe() idempotency & fail-closed behavior ───────────────────

describe('setTimeframe() — idempotency & resolution handling', () => {
  it('does NOT call setResolution when chart resolution already matches exactly', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('chart.resolution()')) {
        return '60';
      }
      return undefined;
    };

    let waitCalled = false;
    const waitForChartReadyMock = async () => {
      waitCalled = true;
      return true;
    };

    const result = await setTimeframe({
      timeframe: '60',
      _deps: {
        evaluate,
        waitForChartReady: waitForChartReadyMock,
      },
    });

    assert.deepEqual(result, { success: true, timeframe: '60', chart_ready: true });
    assert.equal(calls.some(c => c.includes('setResolution')), false, 'Must not call setResolution');
    assert.equal(waitCalled, false, 'Short-circuits without re-waiting');
  });

  it('does NOT call setResolution when chart resolution matches via alias (60 vs 1H, D vs 1D)', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('chart.resolution()')) {
        return '60';
      }
      return undefined;
    };

    const result = await setTimeframe({
      timeframe: '1H',
      _deps: {
        evaluate,
        waitForChartReady: async () => true,
      },
    });

    assert.deepEqual(result, { success: true, timeframe: '1H', chart_ready: true });
    assert.equal(calls.some(c => c.includes('setResolution')), false, 'Must not call setResolution for alias match');
  });

  it('calls setResolution and waits for chart ready when resolution differs', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('chart.resolution()')) {
        return '15'; // Different from requested 1H
      }
      return undefined;
    };

    let waitArgs = null;
    const waitForChartReadyMock = async (...args) => {
      waitArgs = args;
      return true;
    };

    const result = await setTimeframe({
      timeframe: '1H',
      _deps: {
        evaluate,
        waitForChartReady: waitForChartReadyMock,
      },
    });

    assert.deepEqual(result, { success: true, timeframe: '1H', chart_ready: true });
    const setResCall = calls.find(c => c.includes('setResolution'));
    assert.ok(setResCall, 'setResolution must be called');
    assert.ok(setResCall.includes('"1H"'), 'timeframe passed safely with safeString');
    assert.deepEqual(waitArgs, [null, '1H']);
  });

  it('fails closed and throws error when mismatched resolution stays blocked / does not become ready', async () => {
    const calls = [];
    const evaluate = async (expr) => {
      calls.push(expr);
      if (expr.includes('chart.resolution()')) {
        return '15';
      }
      return undefined;
    };

    const waitForChartReadyMock = async () => false; // Never becomes ready

    await assert.rejects(
      () => setTimeframe({
        timeframe: '4H',
        _deps: {
          evaluate,
          waitForChartReady: waitForChartReadyMock,
        },
      }),
      /Chart timeframe did not become ready for "4H"/,
    );
  });
});
