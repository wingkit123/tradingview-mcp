import fs from 'fs';
import path from 'path';
import * as chartCore from '../src/core/chart.js';
import * as drawCore from '../src/core/drawing.js';
import * as healthCore from '../src/core/health.js';
import { evaluate, disconnect } from '../src/connection.js';
import { normalizeDrawingSnapshot } from './lib/user_drawing_pipeline.js';

function parseOutPath() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i].startsWith('--out=')) {
      return args[i].slice(6);
    }
  }
  if (process.env.USER_DRAWINGS_OUT) {
    return process.env.USER_DRAWINGS_OUT;
  }
  return null;
}

function parseTimezone() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timezone' && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i].startsWith('--timezone=')) {
      return args[i].slice(11);
    }
  }
  if (process.env.USER_DRAWINGS_TIMEZONE) {
    return process.env.USER_DRAWINGS_TIMEZONE;
  }
  return null;
}

async function studyUserChart() {
  const outPath = parseOutPath();
  if (!outPath) {
    throw new Error("Output path must be specified via --out <path> or USER_DRAWINGS_OUT environment variable.");
  }

  const timezone = parseTimezone();
  if (!timezone || typeof timezone !== 'string' || timezone.trim() === '') {
    throw new Error("Explicit timezone must be specified via --timezone <IANA-name> or USER_DRAWINGS_TIMEZONE environment variable.");
  }

  console.log("=== STUDYING USER MANUAL DRAWINGS & TRADING STYLE ===");

  let health;
  try {
    health = await healthCore.healthCheck();
  } catch (err) {
    throw new Error(`TradingView connection unavailable: health check failed (${err.message})`);
  }
  if (!health || !health.api_available) {
    throw new Error("TradingView connection unavailable: active controlled session is not running or API is unavailable.");
  }

  const chartState = await chartCore.getState();
  if (!chartState || !chartState.symbol || !chartState.resolution) {
    throw new Error(`Failed to retrieve live chart state (symbol: ${chartState?.symbol}, resolution: ${chartState?.resolution})`);
  }
  const symbol = chartState.symbol;
  const resolution = chartState.resolution;
  console.log(`Live Chart Symbol: ${symbol}, Resolution: ${resolution}, Timezone: ${timezone.trim()}`);

  const visibleRangeRes = await chartCore.getVisibleRange();
  if (!visibleRangeRes || !visibleRangeRes.success) {
    throw new Error('Failed to retrieve visible range from chart');
  }
  const visibleRange = visibleRangeRes.visible_range || null;

  // Fetch all drawings
  const listResult = await drawCore.listDrawings();
  if (!listResult || !Array.isArray(listResult.shapes)) {
    throw new Error('Failed to list drawings from chart');
  }
  const allShapes = listResult.shapes || [];
  console.log(`Total drawings on chart: ${allShapes.length}`);

  const extractedDrawings = [];

  // Fetch points and model metadata directly from TradingView chart data sources
  let modelShapes = {};
  try {
    const rawModelInfo = await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (!chart) throw new Error("Active chart widget not found");
        var model = chart._chartWidget ? chart._chartWidget.model().model() : null;
        if (!model) throw new Error("Chart model not found for active chart widget");
        var shapes = chart.getAllShapes();
        var map = {};
        shapes.forEach(function(s) {
          var ds = model.dataSourceForId(s.id);
          if (!ds) {
            throw new Error("Data source not found for shape id " + s.id);
          }
          if (!ds.points || typeof ds.points !== 'function') {
            throw new Error("Points method not available on data source for shape id " + s.id);
          }
          var rawPts;
          try {
            rawPts = ds.points();
          } catch(ptErr) {
            throw new Error("Failed extracting points for shape id " + s.id + ": " + (ptErr && ptErr.message));
          }
          if (!rawPts || !Array.isArray(rawPts) || rawPts.length === 0) {
            throw new Error("No points returned for shape id " + s.id);
          }
          var pts = rawPts.map(function(p) { return { price: p.price, index: p.index, time: p.time_t }; });
          map[s.id] = { name: s.name, points: pts };
        });
        return map;
      })()
    `);
    if (rawModelInfo) modelShapes = rawModelInfo;
  } catch (err) {
    throw new Error(`Failed evaluating raw chart model shapes: ${err.message}`);
  }

  for (const s of allShapes) {
    let p;
    try {
      p = await drawCore.getProperties({ entity_id: s.id });
    } catch (e) {
      throw new Error(`Failed to retrieve properties for shape id ${s.id}: ${e.message}`);
    }

    if (!p || !p.properties) {
      throw new Error(`Failed to retrieve valid properties for shape id ${s.id}`);
    }

    const props = p.properties || {};
    const txt = props.text || '';
    const mInfo = modelShapes[s.id];
    if (!mInfo || !mInfo.points || mInfo.points.length === 0) {
      throw new Error(`Missing extracted model points for shape id ${s.id}`);
    }

    const drawingInfo = {
      id: s.id,
      name: mInfo.name || s.name || 'unknown',
      type: s.type || props.type || mInfo.name || 'unknown',
      points: mInfo.points,
      text: txt,
      color: props.color || props.linecolor || props.backgroundColor,
      linecolor: props.linecolor,
      backgroundColor: props.backgroundColor,
      linewidth: props.linewidth,
      linestyle: props.linestyle,
      fontsize: props.fontsize || props.fontSize,
      properties: props
    };

    extractedDrawings.push(drawingInfo);
  }

  console.log(`Extracted ${extractedDrawings.length} drawings from chart.`);

  const capturedAt = new Date().toISOString();
  const rawSnapshot = {
    symbol: symbol,
    timeframe: String(resolution),
    timezone: timezone.trim(),
    timestamp: capturedAt,
    visible_range: visibleRange ? {
      from: visibleRange.from !== undefined ? visibleRange.from : null,
      to: visibleRange.to !== undefined ? visibleRange.to : null
    } : null,
    source_model_version: 'tv_chart_model.v1',
    drawings: extractedDrawings
  };

  const normalizedSnapshot = normalizeDrawingSnapshot(rawSnapshot, {
    capturedAtUtc: capturedAt,
    chart: {
      symbol: rawSnapshot.symbol,
      timeframe: rawSnapshot.timeframe,
      timezone: rawSnapshot.timezone,
      visible_range: rawSnapshot.visible_range
    },
    sourceModelVersion: rawSnapshot.source_model_version
  });

  const resolvedOut = path.resolve(outPath);
  const outDir = path.dirname(resolvedOut);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(resolvedOut, JSON.stringify(normalizedSnapshot, null, 2), 'utf8');

  disconnect();
  console.log("=== USER STUDY COMPLETE ===");
  console.log(`Normalized snapshot saved to: ${resolvedOut}`);
  process.exit(0);
}

studyUserChart().catch(err => {
  console.error("Study Error:", err);
  process.exit(1);
});



