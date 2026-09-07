# User Drawing Pipeline v1 Specification

## 1. Executive Summary & Non-Goals

The User Drawing Pipeline (`user_drawing_pipeline.js`, schema version `drawing_snapshot.v1`) is an offline, pure, deterministic normalizer and diagnostic alignment engine for TradingView chart drawings.

### Explicit Non-Goals
1. **No Strategy Inference**: The pipeline strictly normalizes geometry, annotations, and spatial diagnostics. It does not infer trading strategies, entry/exit criteria, or user intent beyond conservative structural tags.
2. **No Parameter Updating**: The module is read-only with respect to strategy hyperparameters. It does not calibrate or mutate trading configurations.
3. **No MT5 Bridge or Execution Handoff**: The module does not interface with MetaTrader 5, emit MQL5 structures, generate orders, or trigger trading actions.

---

## 2. Snapshot Schema (`drawing_snapshot.v1`)

### 2.1 Root Structure
```json
{
  "schema_version": "drawing_snapshot.v1",
  "snapshot_id": "e47bc87ef8f745bb526e96071680c07d671548744827b81a565e85b6afad88f3",
  "captured_at_utc": "2026-08-31T12:00:00.000Z",
  "chart": {
    "symbol": "XAUUSD",
    "timeframe": "60",
    "timezone": "UTC",
    "visible_range": {
      "from": 1700000000,
      "to": 1700100000
    }
  },
  "source_model_version": "tv_chart_model.v1",
  "drawings": [ ... ]
}
```

### 2.2 Normalized Drawing Entity
```json
{
  "source_id": "shape_rect_1",
  "kind": "rectangle",
  "provenance": {
    "ownership": "UNCLASSIFIED"
  },
  "geometry": {
    "anchors": [
      {
        "index": 130,
        "price": 2390.0,
        "time": 1700080000,
        "time_utc": "2023-11-15T20:26:40.000Z"
      },
      {
        "index": 150,
        "price": 2405.5,
        "time": 1700152000,
        "time_utc": "2023-11-16T16:26:40.000Z"
      }
    ],
    "price_bounds": {
      "low": 2390.0,
      "high": 2405.5
    },
    "time_bounds": {
      "start_time": 1700080000,
      "end_time": 1700152000,
      "start_time_utc": "2023-11-15T20:26:40.000Z",
      "end_time_utc": "2023-11-16T16:26:40.000Z"
    }
  },
  "style": {
    "color": "#FF5252",
    "linecolor": null,
    "backgroundColor": "rgba(255, 82, 82, 0.2)",
    "linewidth": 1,
    "linestyle": null,
    "fontsize": null
  },
  "annotation": {
    "raw_text": "H1 POI Supply Zone",
    "normalized_text": "H1 POI Supply Zone",
    "tags": ["POI"],
    "parser_version": "tag_parser.v1"
  },
  "source_status": "valid",
  "errors": []
}
```

#### Fibonacci Drawings Specification
For Fibonacci geometry (`kind: "fib_retracement"` or `"fib_extension"`), level coefficients are never synthesized or inferred from anchor points:
- `geometry.fib_levels`: Object mapping stringified coefficients to numeric prices for explicitly supplied levels only. If no levels are supplied in the raw drawing, `fib_levels` is an empty object (`{}`).
- `geometry.golden_levels_present`: Array containing only the recognized golden ratio coefficients (`0.5`, `0.618`, `0.786`) that were explicitly supplied in the raw drawing.

### 2.3 Error Resilience & Fail-Closed Behavior
- **Fail-Closed Root Validation**: Root-level omissions (missing `symbol`, missing/empty `timezone`, invalid/missing `captured_at_utc`, missing `source_model_version`, or invalid payload type) throw structured errors with distinct codes (`ERR_INVALID_PAYLOAD`, `ERR_MISSING_SYMBOL`, `ERR_MISSING_TIMEZONE`, `ERR_INVALID_CAPTURED_AT`, `ERR_MISSING_SOURCE_MODEL_VERSION`).
- **Preservation of Malformed Drawings**: Individual malformed drawings are NEVER silently dropped. If coordinate or timestamp values are missing or invalid, an anchor error record is captured, `source_status` is set to `'malformed'`, and the drawing is retained in the output for diagnostic auditing.
- **Timestamp Integrity**: The normalizer never invents timestamps. Missing or non-convertible timestamps remain `null`.

---

## 3. Provenance & Extraction Integrity

### 3.1 Unclassified Ownership & Non-Filtering
Drawing text annotations (including `[AI-SNR]`, `(AI)`, or similar label prefixes) do NOT serve as ownership signals. Every retrieved drawing from the chart is preserved in the normalized snapshot with `provenance: { ownership: "UNCLASSIFIED" }`. No drawings are filtered, dropped, or segregated based on text content.

### 3.2 Live Chart Extraction Contract
The chart study harness (`scripts/study_user_drawings.js`) enforces strict fail-closed extraction integrity:
1. **Controlled-Session-Only Execution**: The extractor operates strictly against an already running, controlled TradingView session. It contains no `healthCore.launch` or auto-launch/sleep fallback. If the session or API health check fails, it throws a clear connection-unavailable error immediately without spawning a new TradingView instance.
2. **Live Chart Context**: Fetches live chart symbol and resolution via `chartCore.getState()`, and visible range via `chartCore.getVisibleRange()`. No fallback or default to hard-coded symbols (such as `XAUUSD`).
3. **Explicit Timezone Requirement**: Requires `--timezone <IANA-name>` (or `USER_DRAWINGS_TIMEZONE` environment variable) and fails immediately if omitted.
4. **Fail-Closed Model Extraction & No Partial Fallback**: Point extraction is performed directly via chart data sources (`dataSourceForId(s.id)`). If `model`, `dataSourceForId(s.id)`, or `ds.points` is missing, or if no points are returned for any shape, extraction immediately throws a descriptive error including the affected shape ID. The pipeline never falls back to `p.points` or partial snapshots. Shape property retrieval failures are similarly fail-closed.


The `snapshot_id` guarantees cryptographically stable identity across invocations and environments without random seeds or local system clocks.

### Deterministic Canonicalization Algorithm
1. **Object Key Sorting**: Object keys are recursively sorted in lexicographical ASCII order.
2. **Array Preservation**: Array order is strictly preserved.
3. **Number Formatting**: Finite numeric values are represented in standard decimal format; non-finite numbers normalize to `null`.
4. **Hashing**: SHA-256 is computed over the UTF-8 encoded canonical JSON string of the snapshot payload (excluding `snapshot_id`).

$$\text{snapshot\_id} = \text{SHA-256}(\text{CanonicalJSON}(\text{Payload}_{\setminus \text{snapshot\_id}}))$$

---

## 4. Accepted Conservative Tag Grammar

To eliminate hallucinations and unwarranted narrative interpretations, the annotation parser (`tag_parser.v1`) enforces a strict allowlist matching token boundaries:

| Tag Token | Meaning | Matching Pattern |
| :--- | :--- | :--- |
| `BOS` | Break of Structure | `\bBOS\b` |
| `CHOCH` | Change of Character | `\bCHOCH\b` |
| `SBR` | Support Becomes Resistance | `\bSBR\b` |
| `RBS` | Resistance Becomes Support | `\bRBS\b` |
| `POI` | Point of Interest | `\bPOI\b` |
| `SSL` | Sell-Side Liquidity | `\bSSL\b` |
| `BSL` | Buy-Side Liquidity | `\bBSL\b` |
| `liquidity sweep` | Liquidity Sweep Event | `\bliquidity\s+sweep\b` |

*Any narrative text outside these tokens (e.g., "looking for scalp long", "strong buyer momentum") is discarded from tags.*

---

## 5. Bounded Lifecycle Classification State Machine

The lifecycle classifier `classifyLifecycle(normalizedDrawing, closedBars, asOfUtc, lifecyclePolicy)` tracks the temporal interaction of price against drawing boundaries.

### 5.1 Permitted Output States
- `UNKNOWN`: Insufficient parameters, invalid drawing bounds, or missing `lifecycle_policy`.
- `UNTOUCHED`: Price has never entered or breached the drawing price bounds during the evaluated closed bars.
- `TOUCHED`: Price has interacted with or wicked into the drawing price bounds without meeting mitigation or breaking criteria.
- `MITIGATED`: Price reached the policy-defined mitigation depth (e.g. 50% equilibrium or full zone test).
- `BROKEN`: Price closed or wicked beyond the invalidation threshold (e.g. `close_beyond` or `wick_beyond`).
- `EXPIRED`: Drawing lifespan exceeded the maximum bar horizon.

### 5.2 Strict Evaluation Constraints
1. **Closed Bars Only**: The classifier evaluates closed bars only.
2. **Strict Time Cutoff (`asOfUtc`)**: Any bar with timestamp $> \text{asOfUtc}$ is strictly excluded to eliminate lookahead bias.
3. **Explicit Policy Requirement**: Requires an explicit `lifecycle_policy` specifying `side` (`buy` / `sell`) and `invalidation` rule (`close_beyond` / `wick_beyond`). Without this, the state returns `UNKNOWN`. Mitigation is never assumed from drawing metadata.

---

## 6. Deterministic Mathematical Formulas

### 6.1 1D Interval Distance (`intervalDistance`)
Given two closed intervals $A = [a_{\min}, a_{\max}]$ and $B = [b_{\min}, b_{\max}]$:

$$d(A, B) = \begin{cases} 0 & \text{if } a_{\max} \ge b_{\min} \text{ and } b_{\max} \ge a_{\min} \\ b_{\min} - a_{\max} & \text{if } a_{\max} < b_{\min} \\ a_{\min} - b_{\max} & \text{if } b_{\max} < a_{\min} \end{cases}$$

### 6.2 ATR-Normalized Zone Alignment (`alignDrawingToZone`)
Given drawing price interval $D$, reference zone interval $Z$, average true range $\text{ATR} > 0$, and tolerance $\epsilon \ge 0$:

$$\text{Normalized Distance} = \frac{d(D, Z)}{\text{ATR}}$$

$$\text{is\_aligned} = \begin{cases} \text{true} & \text{if } \text{Normalized Distance} \le \epsilon \\ \text{false} & \text{otherwise} \end{cases}$$
