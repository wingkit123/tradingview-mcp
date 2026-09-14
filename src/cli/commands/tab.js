import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch, navigate)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      handler: (opts, positionals) => {
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
    ['navigate', {
      description: 'Navigate a chart tab to a URL (defaults to index 0)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('URL required. Usage: tv tab navigate https://www.tradingview.com/chart/abc/ [index]');
        return core.navigate({ url: positionals[0], index: positionals[1] !== undefined ? positionals[1] : 0 });
      },
    }],
  ]),
});
