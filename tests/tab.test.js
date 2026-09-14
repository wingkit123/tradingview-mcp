/**
 * Unit tests for tab management in src/core/tab.js.
 * Covers validateUrl, target selection by numeric index, CDP Page.navigate lifecycle,
 * and fail-closed error handling.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, navigate, list } from '../src/core/tab.js';

function createMockTabList() {
  return {
    success: true,
    tab_count: 2,
    tabs: [
      {
        index: 0,
        id: 'target-page-001',
        title: 'XAUUSD 1D Chart',
        url: 'https://www.tradingview.com/chart/abc12345/',
        chart_id: 'abc12345',
        is_chart: true,
      },
      {
        index: 1,
        id: 'target-page-002',
        title: 'BTCUSDT 4H Chart',
        url: 'https://www.tradingview.com/chart/xyz67890/',
        chart_id: 'xyz67890',
        is_chart: true,
      },
    ],
  };
}

function createMockDeps(overrides = {}) {
  const calls = {
    reconnected: [],
    pageEnabled: 0,
    navigated: [],
  };

  const defaultClient = {
    Page: {
      enable: async () => {
        calls.pageEnabled++;
      },
      navigate: async ({ url }) => {
        calls.navigated.push(url);
        return { frameId: 'frame-123', loaderId: 'loader-456' };
      },
    },
  };

  const deps = {
    list: async () => createMockTabList(),
    reconnectTo: async (targetId) => {
      calls.reconnected.push(targetId);
      return defaultClient;
    },
    ...overrides,
  };

  return { deps, calls, defaultClient };
}

// ── validateUrl() ─────────────────────────────────────────────────────────

describe('validateUrl() — HTTP/HTTPS validation', () => {
  it('accepts valid HTTPS URLs', () => {
    const valid = 'https://www.tradingview.com/chart/abc12345/';
    assert.equal(validateUrl(valid), valid);
  });

  it('accepts valid HTTP URLs with port and params', () => {
    const valid = 'http://127.0.0.1:8080/chart?symbol=BINANCE:BTCUSDT';
    assert.equal(validateUrl(valid), valid);
  });

  it('rejects empty or whitespace string', () => {
    assert.throws(() => validateUrl(''), /non-empty string/);
    assert.throws(() => validateUrl('   '), /non-empty string/);
  });

  it('rejects non-string values', () => {
    assert.throws(() => validateUrl(null), /non-empty string/);
    assert.throws(() => validateUrl(undefined), /non-empty string/);
    assert.throws(() => validateUrl(123), /non-empty string/);
    assert.throws(() => validateUrl({}), /non-empty string/);
  });

  it('rejects invalid URL formats', () => {
    assert.throws(() => validateUrl('not-a-valid-url'), /Invalid URL format/);
    assert.throws(() => validateUrl('//tradingview.com/chart'), /Invalid URL format/);
  });

  it('rejects forbidden protocols (javascript:, file:, data:, ftp:)', () => {
    assert.throws(() => validateUrl('javascript:alert(1)'), /Only http: and https:/);
    assert.throws(() => validateUrl('file:///etc/passwd'), /Only http: and https:/);
    assert.throws(() => validateUrl('data:text/html,<h1>hi</h1>'), /Only http: and https:/);
    assert.throws(() => validateUrl('ftp://example.com/file'), /Only http: and https:/);
    assert.throws(() => validateUrl('chrome://settings'), /Only http: and https:/);
  });
});

// ── navigate() — target selection ──────────────────────────────────────────

describe('navigate() — exact target selection by numeric index', () => {
  it('selects target tab at index 0 by default when index is omitted', async () => {
    const { deps, calls } = createMockDeps();
    const result = await navigate({
      url: 'https://www.tradingview.com/chart/newlayout/',
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.index, 0);
    assert.equal(result.tab_id, 'target-page-001');
    assert.equal(result.chart_id, 'abc12345');
    assert.deepEqual(calls.reconnected, ['target-page-001']);
  });

  it('selects target tab at numeric index 1', async () => {
    const { deps, calls } = createMockDeps();
    const result = await navigate({
      url: 'https://www.tradingview.com/chart/newlayout/',
      index: 1,
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.index, 1);
    assert.equal(result.tab_id, 'target-page-002');
    assert.equal(result.chart_id, 'xyz67890');
    assert.deepEqual(calls.reconnected, ['target-page-002']);
  });

  it('coerces valid string numeric index', async () => {
    const { deps, calls } = createMockDeps();
    const result = await navigate({
      url: 'https://www.tradingview.com/chart/newlayout/',
      index: '1',
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.index, 1);
    assert.equal(result.tab_id, 'target-page-002');
    assert.deepEqual(calls.reconnected, ['target-page-002']);
  });

  it('throws when index is out of bounds (greater or equal to tab count)', async () => {
    const { deps } = createMockDeps();
    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/newlayout/', index: 2, _deps: deps }),
      /Tab index 2 out of range \(have 2 tabs\)/
    );
  });

  it('throws when index is negative', async () => {
    const { deps } = createMockDeps();
    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/newlayout/', index: -1, _deps: deps }),
      /Tab index -1 out of range/
    );
  });

  it('throws when index is non-integer or NaN', async () => {
    const { deps } = createMockDeps();
    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/newlayout/', index: 'invalid', _deps: deps }),
      /Tab index invalid out of range/
    );
    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/newlayout/', index: 1.5, _deps: deps }),
      /Tab index 1.5 out of range/
    );
  });

  it('throws when there are zero tabs available', async () => {
    const { deps } = createMockDeps({ list: async () => ({ success: true, tab_count: 0, tabs: [] }) });
    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/newlayout/', index: 0, _deps: deps }),
      /Tab index 0 out of range \(have 0 tabs\)/
    );
  });
});

// ── navigate() — CDP Page.navigate call & lifecycle ────────────────────────

describe('navigate() — CDP Page.navigate call and structured output', () => {
  it('enables Page domain and navigates to the validated URL', async () => {
    const { deps, calls } = createMockDeps();
    const targetUrl = 'https://www.tradingview.com/chart/target123/';
    const result = await navigate({
      url: targetUrl,
      index: 0,
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.action, 'navigated');
    assert.equal(result.url, targetUrl);
    assert.equal(result.index, 0);
    assert.equal(result.tab_id, 'target-page-001');
    assert.equal(result.chart_id, 'abc12345');
    assert.equal(result.frame_id, 'frame-123');
    assert.equal(result.loader_id, 'loader-456');
    assert.deepEqual(result.target, {
      id: 'target-page-001',
      title: 'XAUUSD 1D Chart',
      url: 'https://www.tradingview.com/chart/abc12345/',
      chart_id: 'abc12345',
      is_chart: true,
    });

    assert.equal(calls.pageEnabled, 1);
    assert.deepEqual(calls.navigated, [targetUrl]);
  });

  it('works when Page domain does not have enable method', async () => {
    const { deps, calls } = createMockDeps({
      reconnectTo: async () => ({
        Page: {
          navigate: async ({ url }) => {
            calls.navigated.push(url);
            return { frameId: 'frame-999' };
          },
        },
      }),
    });

    const result = await navigate({
      url: 'https://www.tradingview.com/chart/abc/',
      index: 0,
      _deps: deps,
    });

    assert.equal(result.success, true);
    assert.equal(result.frame_id, 'frame-999');
    assert.equal(result.loader_id, null);
  });
});

// ── navigate() — Fail-closed error handling ────────────────────────────────

describe('navigate() — fail-closed error handling', () => {
  it('throws if reconnectTo fails / rejects', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => {
        throw new Error('CDP target disconnected');
      },
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /CDP target disconnected/
    );
  });

  it('throws if reconnectTo returns null client', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => null,
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /Failed to reconnect CDP client/
    );
  });

  it('throws if client has no Page domain', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => ({}),
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /CDP Page domain or navigate method not available/
    );
  });

  it('throws if Page.navigate returns errorText (CDP navigation error)', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => ({
        Page: {
          enable: async () => {},
          navigate: async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
        },
      }),
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /Page\.navigate failed: net::ERR_NAME_NOT_RESOLVED/
    );
  });

  it('throws if Page.navigate returns invalid or empty result', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => ({
        Page: {
          enable: async () => {},
          navigate: async () => null,
        },
      }),
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /Page\.navigate failed: empty or invalid response from CDP/
    );
  });

  it('throws if Page.navigate throws an exception', async () => {
    const { deps } = createMockDeps({
      reconnectTo: async () => ({
        Page: {
          enable: async () => {},
          navigate: async () => {
            throw new Error('CDP socket closed unexpectedly');
          },
        },
      }),
    });

    await assert.rejects(
      () => navigate({ url: 'https://www.tradingview.com/chart/abc/', _deps: deps }),
      /CDP socket closed unexpectedly/
    );
  });
});
