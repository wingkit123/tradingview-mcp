#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TV_MCP_APP_DIR:-/home/mulerun/apps/tradingview-mcp}"
STATE_DIR="${TV_MCP_STATE_DIR:-/home/mulerun/.state/tradingview-mcp}"
CAPTURE_DIR="${TV_MCP_CAPTURE_DIR:-${STATE_DIR}/captures}"
CHROME_PROFILE="${TV_CHROME_PROFILE:-/home/mulerun/.state/tradingview-chrome}"
CHROME_LOG="${TV_CHROME_LOG:-/home/mulerun/.state/logs/tradingview-chrome.log}"
CDP_HOST="${TV_CDP_HOST:-127.0.0.1}"
CDP_PORT="${TV_CDP_PORT:-9222}"
CHART_ID="${TRADINGVIEW_CHART_ID:-1xfXpF1b}"
SYMBOL="${TRADINGVIEW_SYMBOL:-OANDA:XAUUSD}"

mkdir -p "$STATE_DIR" "$CAPTURE_DIR" "$CHROME_PROFILE" "$(dirname "$CHROME_LOG")"

exec 9>"$STATE_DIR/capture.lock"
if ! flock -n 9; then
  printf '%s\n' '{"status":"BLOCKED","stage":"single_writer_lock","error":"cloud capture already running"}' >&2
  exit 4
fi

cdp_url="http://${CDP_HOST}:${CDP_PORT}/json/version"
if ! curl -fsS "$cdp_url" >/dev/null 2>&1; then
  if pgrep -f -- "--user-data-dir=${CHROME_PROFILE}" >/dev/null 2>&1; then
    printf '%s\n' '{"status":"BLOCKED","stage":"chrome_start","error":"profile process exists but CDP is unavailable"}' >&2
    exit 4
  fi

  nohup google-chrome \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --remote-debugging-address="$CDP_HOST" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$CHROME_PROFILE" \
    "https://www.tradingview.com/chart/${CHART_ID}/?symbol=OANDA%3AXAUUSD" \
    >"$CHROME_LOG" 2>&1 </dev/null &

  ready=false
  for _ in $(seq 1 20); do
    if curl -fsS "$cdp_url" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    printf '%s\n' '{"status":"BLOCKED","stage":"chrome_start","error":"CDP did not become ready"}' >&2
    exit 4
  fi
fi

export TV_MAPPER_MODE='capture-only'
export TV_CDP_HOST="$CDP_HOST"
export TV_CDP_PORT="$CDP_PORT"
export TRADINGVIEW_CHART_ID="$CHART_ID"
export TRADINGVIEW_SYMBOL="$SYMBOL"

cd "$APP_DIR"
set +e
node scripts/run_cloud_capture.js
runner_status=$?
set -e

if [[ "$runner_status" -ne 0 ]]; then
  exit "$runner_status"
fi

receipt_path="$APP_DIR/artifacts/snr-map.v1.json"
if [[ ! -s "$receipt_path" ]]; then
  printf '%s\n' '{"status":"FAILED","stage":"capture_archive","error":"capture receipt is missing or empty"}' >&2
  exit 5
fi

capture_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
capture_path="$CAPTURE_DIR/snr-map-${capture_stamp}.json"
capture_tmp="$CAPTURE_DIR/.snr-map-${capture_stamp}-$$.tmp"
cp -- "$receipt_path" "$capture_tmp"
chmod 600 "$capture_tmp"
mv -- "$capture_tmp" "$capture_path"
printf '{"status":"ARCHIVED","stage":"capture_archive","path":"%s"}\n' "$capture_path"
