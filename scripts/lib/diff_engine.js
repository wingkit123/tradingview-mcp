/**
 * diff_engine.js
 * Differential SNR Lifecycle Engine for TradingView entities.
 *
 * Computes:
 * - KEEP: Existing entities that remain valid within price/geometry tolerance.
 * - APPEND: Newly formed candidate entities that must be drawn.
 * - DELETE: Existing entities that are no longer valid and must be retired.
 */

export const DEFAULT_TOLERANCE_PTS = 1.0;

function getEntityKind(e) {
  if (!e) return null;
  if (e.kind) return e.kind;
  if (e.shape) return e.shape;
  if (e.high != null && e.low != null) return 'rectangle';
  if (e.price != null && !e.label?.includes('\n')) return 'horizontal_line';
  if (e.label) return 'text';
  return null;
}

/**
 * Match a candidate horizontal line against an existing horizontal line.
 */
function matchHorizontalLine(cand, exist, tolerance = DEFAULT_TOLERANCE_PTS) {
  const existKind = getEntityKind(exist);
  if (existKind !== 'horizontal_line') return false;
  const candPrice = cand.point?.price ?? cand.price;
  const existPrice = exist.point?.price ?? exist.price;
  if (typeof candPrice !== 'number' || typeof existPrice !== 'number') return false;
  return Math.abs(candPrice - existPrice) <= tolerance;
}

/**
 * Match a candidate rectangle (Range) against an existing rectangle.
 */
function matchRectangle(cand, exist, tolerance = DEFAULT_TOLERANCE_PTS) {
  const existKind = getEntityKind(exist);
  if (existKind !== 'rectangle') return false;
  const cP1 = cand.point?.price ?? cand.high;
  const cP2 = cand.point2?.price ?? cand.low;
  const eP1 = exist.point?.price ?? exist.high;
  const eP2 = exist.point2?.price ?? exist.low;
  if (cP1 == null || cP2 == null || eP1 == null || eP2 == null) return false;

  const cMin = Math.min(cP1, cP2);
  const cMax = Math.max(cP1, cP2);
  const eMin = Math.min(eP1, eP2);
  const eMax = Math.max(eP1, eP2);

  return Math.abs(cMin - eMin) <= tolerance && Math.abs(cMax - eMax) <= tolerance;
}

/**
 * Match a candidate trendline against an existing trendline.
 */
function matchTrendLine(cand, exist, tolerance = DEFAULT_TOLERANCE_PTS) {
  const existKind = getEntityKind(exist);
  if (existKind !== 'trend_line') return false;
  const cP1 = cand.point?.price;
  const cP2 = cand.point2?.price;
  const eP1 = exist.point?.price;
  const eP2 = exist.point2?.price;
  if (cP1 == null || cP2 == null || eP1 == null || eP2 == null) return false;

  return Math.abs(cP1 - eP1) <= tolerance && Math.abs(cP2 - eP2) <= tolerance;
}

/**
 * Match a candidate text note against an existing text note.
 * If text content is identical, keep it. If content changed, replace it (delete + append).
 */
function matchTextNote(cand, exist) {
  const existKind = getEntityKind(exist);
  if (existKind !== 'text') return false;
  const cText = cand.label || cand.overrides?.text || '';
  const eText = exist.label || exist.overrides?.text || '';
  return cText === eText && cText.length > 0;
}

/**
 * Check if a candidate entity matches an existing entity.
 */
export function isEntityMatch(cand, exist, tolerance = DEFAULT_TOLERANCE_PTS) {
  if (!cand || !exist) return false;
  const candKind = getEntityKind(cand);
  const existKind = getEntityKind(exist);
  if (candKind !== existKind) return false;

  switch (candKind) {
    case 'horizontal_line':
      return matchHorizontalLine(cand, exist, tolerance);
    case 'rectangle':
      return matchRectangle(cand, exist, tolerance);
    case 'trend_line':
      return matchTrendLine(cand, exist, tolerance);
    case 'text':
      return matchTextNote(cand, exist);
    default:
      return false;
  }
}

/**
 * Compute the differential lifecycle actions.
 *
 * @param {Array<object>} candidateEntities - Freshly generated entities from buildSnrMap
 * @param {Array<object>} existingEntities - Active entities loaded from previous ownership manifest
 * @param {object} options
 * @param {number} [options.tolerance=1.0] - Price difference tolerance in points
 * @returns {{
 *   keep: Array<{ candidate: object, existing: object, entity_id: string }>,
 *   append: Array<object>,
 *   delete: Array<{ entity_id: string, entity?: object }>,
 *   summary: { keep_count: number, append_count: number, delete_count: number }
 * }}
 */
export function computeEntityDiff(candidateEntities = [], existingEntities = [], options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_PTS;

  const keep = [];
  const append = [];
  const deleteList = [];

  const matchedExistingIndices = new Set();

  for (const cand of candidateEntities) {
    let foundIndex = -1;
    for (let i = 0; i < existingEntities.length; i++) {
      if (matchedExistingIndices.has(i)) continue;
      const exist = existingEntities[i];
      if (isEntityMatch(cand, exist, tolerance)) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex !== -1) {
      matchedExistingIndices.add(foundIndex);
      const exist = existingEntities[foundIndex];
      keep.push({
        candidate: cand,
        existing: exist,
        entity_id: exist.entity_id
      });
    } else {
      append.push(cand);
    }
  }

  // Any existing entity that was not matched with candidates should be deleted
  for (let i = 0; i < existingEntities.length; i++) {
    if (!matchedExistingIndices.has(i)) {
      const exist = existingEntities[i];
      if (exist.entity_id) {
        deleteList.push({
          entity_id: exist.entity_id,
          entity: exist
        });
      }
    }
  }

  return {
    keep,
    append,
    delete: deleteList,
    summary: {
      keep_count: keep.length,
      append_count: append.length,
      delete_count: deleteList.length
    }
  };
}
