import { register } from '../router.js';
import * as core from '../../core/drawing.js';

register('draw', {
  description: 'Drawing tools (shape, list, get, remove, clear, snapshot, restore)',
  subcommands: new Map([
    ['shape', {
      description: 'Draw a shape on the chart',
      options: {
        type: { type: 'string', short: 't', description: 'Shape type: horizontal_line, trend_line, rectangle, text' },
        price: { type: 'string', short: 'p', description: 'Price level' },
        time: { type: 'string', description: 'Unix timestamp' },
        price2: { type: 'string', description: 'Second point price (for trend_line, rectangle)' },
        time2: { type: 'string', description: 'Second point time (for trend_line, rectangle)' },
        text: { type: 'string', description: 'Text content (for text shapes)' },
        overrides: { type: 'string', description: 'JSON style overrides' },
      },
      handler: (opts) => {
        const point = { time: Number(opts.time), price: Number(opts.price) };
        const point2 = opts.price2 ? { time: Number(opts.time2), price: Number(opts.price2) } : undefined;
        return core.drawShape({ shape: opts.type || 'horizontal_line', point, point2, overrides: opts.overrides, text: opts.text });
      },
    }],
    ['list', {
      description: 'List all drawings on the chart',
      handler: () => core.listDrawings(),
    }],
    ['get', {
      description: 'Get properties of a drawing',
      handler: (opts, positionals) => core.getProperties({ entity_id: positionals[0] }),
    }],
    ['remove', {
      description: 'Remove a drawing by entity ID',
      handler: (opts, positionals) => core.removeOne({ entity_id: positionals[0] }),
    }],
    ['clear', {
      description: 'Remove all drawings',
      handler: () => core.clearAll(),
    }],
    ['snapshot', {
      description: 'Take a recoverable snapshot of a drawing by entity ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv draw snapshot <entity_id>');
        return core.snapshotShape({ entity_id: positionals[0] });
      },
    }],
    ['restore', {
      description: 'Restore a previously snapshotted drawing from JSON',
      options: {
        json: { type: 'string', description: 'Snapshot JSON string' },
      },
      handler: (opts, positionals) => {
        const raw = opts.json || positionals[0];
        if (!raw) throw new Error('Snapshot JSON required. Usage: tv draw restore \'{"shape": "horizontal_line", ...}\'');
        const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return core.restoreShape({ snapshot });
      },
    }],
  ]),
});
