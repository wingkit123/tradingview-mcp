import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5_000;

export class CloudCaptureBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudCaptureBlockedError';
    this.code = 'CLOUD_CAPTURE_BLOCKED';
  }
}

export function readCloudCaptureConfig(env = process.env) {
  const mode = env.TV_MAPPER_MODE || 'capture-only';
  if (mode !== 'capture-only') {
    throw new CloudCaptureBlockedError(
      `Cloud entry point is capture-only; received mode "${mode}".`,
    );
  }

  const chartId = env.TRADINGVIEW_CHART_ID || env.TV_CHART_ID || '1xfXpF1b';
  const symbol = env.TRADINGVIEW_SYMBOL || 'OANDA:XAUUSD';
  if (symbol.toUpperCase() !== 'OANDA:XAUUSD') {
    throw new CloudCaptureBlockedError(
      `Cloud capture requires OANDA:XAUUSD; received "${symbol}".`,
    );
  }

  const host = env.TV_CDP_HOST || env.CDP_HOST || '127.0.0.1';
  const port = Number(env.TV_CDP_PORT || env.CDP_PORT || 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CloudCaptureBlockedError(`Invalid CDP port "${port}".`);
  }

  return { mode, chartId, symbol, host, port };
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightCloudCdp({
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new CloudCaptureBlockedError('Fetch API is unavailable for CDP preflight.');
  }

  const baseUrl = `http://${config.host}:${config.port}`;
  let version;
  let targets;
  try {
    version = await fetchJson(`${baseUrl}/json/version`, fetchImpl, timeoutMs);
    targets = await fetchJson(`${baseUrl}/json/list`, fetchImpl, timeoutMs);
  } catch (error) {
    throw new CloudCaptureBlockedError(`CDP preflight failed at ${baseUrl}: ${error.message}`);
  }

  if (!version || typeof version !== 'object') {
    throw new CloudCaptureBlockedError('CDP /json/version returned an invalid payload.');
  }
  if (!Array.isArray(targets)) {
    throw new CloudCaptureBlockedError('CDP /json/list returned a non-array payload.');
  }

  const escapedChartId = config.chartId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chartPattern = new RegExp(`/chart/${escapedChartId}(?:[/?]|$)`, 'i');
  const target = targets.find((item) => item?.type === 'page'
    && /tradingview\.com/i.test(item?.url || '')
    && chartPattern.test(item?.url || ''));
  if (!target) {
    throw new CloudCaptureBlockedError(
      `Exact TradingView chart ${config.chartId} is not present in CDP targets.`,
    );
  }

  return {
    verified: true,
    browser: version.Browser || null,
    target_id: target.id || null,
    target_url: target.url,
  };
}

export async function runCloudCapture({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  executeMapping,
} = {}) {
  const config = readCloudCaptureConfig(env);
  const preflight = await preflightCloudCdp({ config, fetchImpl, timeoutMs });
  const execute = executeMapping
    || (await import('./auto_map_snr.js')).executeAutomatedMapping;

  const result = await execute({
    mode: 'capture-only',
    deps: {
      expectedSymbol: config.symbol,
      expectedChartId: config.chartId,
      expectedChartUrl: preflight.target_url,
    },
  });

  if (!result?.success || result.mode !== 'capture-only' || result.mutation_performed !== false) {
    throw new Error('Capture runner returned an invalid or mutating result.');
  }

  return {
    status: 'PASS',
    mode: 'capture-only',
    mutation_performed: false,
    target: preflight,
    manifest_hash: result.manifest_hash,
    entity_count: result.entity_count,
    map_path: result.map_path,
  };
}

async function main() {
  try {
    const result = await runCloudCapture();
    console.log(JSON.stringify(result));
  } catch (error) {
    const blocked = error instanceof CloudCaptureBlockedError;
    console.error(JSON.stringify({
      status: blocked ? 'BLOCKED' : 'FAILED',
      stage: blocked ? 'cloud_preflight' : 'capture',
      error: error.message,
    }));
    process.exitCode = blocked ? 4 : 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
