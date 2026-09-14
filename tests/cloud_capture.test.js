import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudCaptureBlockedError,
  readCloudCaptureConfig,
  preflightCloudCdp,
  runCloudCapture,
} from '../scripts/run_cloud_capture.js';

const config = {
  mode: 'capture-only',
  chartId: '1xfXpF1b',
  symbol: 'OANDA:XAUUSD',
  host: '127.0.0.1',
  port: 9222,
};

function mockFetch(payloads) {
  let index = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => payloads[index++],
  });
}

describe('MuleRun cloud capture-only entry point', () => {
  it('refuses a mutation mode before contacting CDP', () => {
    assert.throws(
      () => readCloudCaptureConfig({ TV_MAPPER_MODE: 'diff' }),
      CloudCaptureBlockedError,
    );
  });

  it('blocks when CDP is unavailable', async () => {
    await assert.rejects(
      preflightCloudCdp({
        config,
        fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
        timeoutMs: 50,
      }),
      /CDP preflight failed.*ECONNREFUSED/,
    );
  });

  it('blocks when the exact chart target is absent', async () => {
    await assert.rejects(
      preflightCloudCdp({
        config,
        fetchImpl: mockFetch([
          { Browser: 'Chrome/1' },
          [{ id: 'other', type: 'page', url: 'https://www.tradingview.com/chart/other/' }],
        ]),
      }),
      /Exact TradingView chart 1xfXpF1b is not present/,
    );
  });

  it('invokes only capture-only mapping after exact-target preflight', async () => {
    const calls = [];
    const result = await runCloudCapture({
      env: {
        TRADINGVIEW_CHART_ID: '1xfXpF1b',
        TRADINGVIEW_SYMBOL: 'OANDA:XAUUSD',
      },
      fetchImpl: mockFetch([
        { Browser: 'Chrome/1' },
        [{
          id: 'target-1',
          type: 'page',
          url: 'https://www.tradingview.com/chart/1xfXpF1b/?symbol=OANDA%3AXAUUSD',
        }],
      ]),
      executeMapping: async (options) => {
        calls.push(options);
        return {
          success: true,
          mode: 'capture-only',
          mutation_performed: false,
          manifest_hash: 'a'.repeat(64),
          entity_count: 8,
          map_path: '/tmp/snr-map.v1.json',
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'capture-only');
    assert.equal(calls[0].deps.expectedChartId, '1xfXpF1b');
    assert.equal(calls[0].deps.expectedSymbol, 'OANDA:XAUUSD');
    assert.equal(result.status, 'PASS');
    assert.equal(result.mutation_performed, false);
  });
});
