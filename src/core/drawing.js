/**
 * Core drawing logic.
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  let createdEntityId = null;
  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    createdEntityId = await evaluate(`
      (async function() {
        return await ${apiPath}.createMultipointShape(
          [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
          { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
        );
      })()
    `, { awaitPromise: true });
  } else {
    createdEntityId = await evaluate(`
      (async function() {
        try {
          return await ${apiPath}.createShape(
            { time: ${p1time}, price: ${p1price} },
            { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
          );
        } catch(e) {
          try {
            var ms = ${apiPath}._chartWidget.model().mainSeries();
            var lb = ms && ms.bars ? ms.bars().last() : null;
            var fallbackTime = (lb && lb.value ? lb.value[0] : (lb && lb[0] ? lb[0] : null));
            if (!fallbackTime) {
              var r = ${apiPath}._chartWidget.model().model().timeScale().points();
              var range = r ? r.range().value() : null;
              fallbackTime = range ? r.valueAt(range.lastIndex) : null;
            }
            if (fallbackTime) {
              return await ${apiPath}.createShape(
                { time: fallbackTime, price: ${p1price} },
                { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
              );
            }
          } catch(e2) {}
          throw e;
        }
      })()
    `, { awaitPromise: true });
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (typeof createdEntityId === 'string' && createdEntityId) || (after || []).find(id => !(before || []).includes(id)) || null;
  const result = { entity_id: newId };
  return { success: true, shape, entity_id: result?.entity_id };
}

export async function listDrawings() {
  const apiPath = await _getChartApi();
  const shapes = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var seen = new Set();
      var result = [];
      try {
        var all = api.getAllShapes() || [];
        for (var i = 0; i < all.length; i++) {
          var s = all[i];
          if (s && s.id && !seen.has(s.id)) {
            seen.add(s.id);
            result.push({ id: s.id, name: s.name });
          }
        }
      } catch(e) {}
      try {
        var model = api._chartWidget.model().model();
        var dsList = model.dataSources() || [];
        for (var j = 0; j < dsList.length; j++) {
          var ds = dsList[j];
          var dsId = ds && typeof ds.id === 'function' ? ds.id() : (ds ? ds.id : null);
          var dsName = ds && typeof ds.name === 'function' ? ds.name() : (ds ? ds.name : null);
          if (dsId && !seen.has(dsId)) {
            seen.add(dsId);
            result.push({ id: dsId, name: dsName });
          }
        }
      } catch(e2) {}
      return result;
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var model = api._chartWidget.model().model();
      var ds = model.dataSourceForId ? model.dataSourceForId(eid) : null;
      var before = api.getAllShapes() || [];
      var inShapes = before.some(function(s) { return s.id === eid; });
      if (!ds && !inShapes) {
        return { removed: true, notFound: true, entity_id: eid, remaining_shapes: before.length };
      }
      try {
        api.removeEntity(eid);
      } catch(e) {
        if (ds && typeof model.removeSource === 'function') {
          try { model.removeSource(ds); } catch(e2) {}
        }
      }
      var afterDs = model.dataSourceForId ? model.dataSourceForId(eid) : null;
      var afterShapes = api.getAllShapes() || [];
      var stillExists = !!afterDs || afterShapes.some(function(s) { return s.id === eid; });
      return { removed: !stillExists, entity_id: eid, remaining_shapes: afterShapes.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  await _evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}

export function mapToolNameToShape(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  if (lower.includes('horiz') || lower === 'horizontal_line') return 'horizontal_line';
  if (lower.includes('vert') || lower === 'vertical_line') return 'vertical_line';
  if (lower.includes('rect') || lower === 'rectangle') return 'rectangle';
  if (lower.includes('trend') || lower === 'trend_line') return 'trend_line';
  if (lower.includes('text')) return 'text';
  return name;
}

export async function snapshotShape({ entity_id, _deps } = {}) {
  if (!entity_id) throw new Error('entity_id is required for snapshotShape');
  const { evaluate, getChartApi } = _resolve(_deps);
  const apiPath = await getChartApi();
  const eid = safeString(entity_id);
  const result = await evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${eid};
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var pts = null;
      try { pts = shape.getPoints(); } catch(e) {}
      var props = null;
      try { props = shape.getProperties(); } catch(e) {
        try { props = shape.properties(); } catch(e2) {}
      }
      var name = null;
      try {
        var all = api.getAllShapes() || [];
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === eid) { name = all[i].name; break; }
        }
      } catch(e3) {}
      return {
        entity_id: eid,
        name: name,
        points: pts,
        properties: props
      };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  const shapeKind = mapToolNameToShape(result?.name);
  const point = result?.points?.[0] || null;
  if (!shapeKind) {
    throw new Error(`Cannot snapshot shape "${entity_id}" without a recoverable TradingView tool name`);
  }
  if (!point || point.time == null || point.price == null) {
    throw new Error(`Cannot snapshot shape "${entity_id}" without recoverable anchor point coordinates`);
  }
  return {
    success: true,
    snapshot: {
      entity_id,
      name: result.name,
      shape: shapeKind,
      points: result.points,
      properties: result.properties,
      point,
      point2: result.points?.[1] || null,
      overrides: result.properties,
      text: typeof result.properties?.text === 'string'
        ? result.properties.text
        : (result.properties?.text?.value || '')
    }
  };
}

export async function restoreShape(input, _depsOptional) {
  const snapshot = input?.snapshot || input;
  const _deps = input?._deps || _depsOptional;
  if (!snapshot) throw new Error('snapshot is required for restoreShape');

  const shapeKind = snapshot.shape || mapToolNameToShape(snapshot.name);
  if (!shapeKind) {
    throw new Error('Cannot restore shape without a recoverable TradingView shape type');
  }
  const points = snapshot.points || (snapshot.point ? [snapshot.point, snapshot.point2].filter(Boolean) : []);
  const point = snapshot.point || points[0];
  const point2 = snapshot.point2 || points[1] || null;
  const overrides = snapshot.overrides || snapshot.properties || {};
  const text = snapshot.text || snapshot.label || (typeof overrides.text === 'string' ? overrides.text : overrides.text?.value) || '';

  if (!point || point.price == null || point.time == null) {
    throw new Error('Cannot restore shape without anchor point coordinates { time, price }');
  }

  const res = await drawShape({
    shape: shapeKind,
    point,
    point2,
    overrides,
    text,
    _deps
  });
  if (!res?.entity_id) {
    throw new Error(`Shape restore did not return a new entity ID for "${snapshot.entity_id || 'unknown'}"`);
  }

  return {
    success: true,
    restored: true,
    original_entity_id: snapshot.entity_id || null,
    restored_entity_id: res.entity_id
  };
}
