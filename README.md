# sv2blocks

Tracks Bitcoin blocks mined with Stratum V2. The new blocks are also posted on X by [@sv2blocks](https://x.com/sv2blocks). T

## Run locally

Use Node.js 22.12 or newer.

```sh
npm ci
npm run data:update
npm run dev
```

For offline development, `npm run data:sample` generates sample data. Run `npm run data:update -- --rescan` when switching back to real blocks. Use `npm run check` to run the type check and tests.

## Block detection

A block matches automatically when its coinbase has a configured tag or its pool is listed in [sv2blocks.config.json](sv2blocks.config.json). Coinbase tags are self-reported.

Add confirmed blocks with unrecognized tags to `include` in [data/overrides.json](data/overrides.json). Add false matches to `exclude`. DMND block 955,318 is included manually. Changes take effect on the next data update.

## Embed widgets

Two tiles can be shown on other sites in an `<iframe>`: the block count with its growth chart, and the leaderboard. Open `embeds.html` on the deployed site (or `http://127.0.0.1:5173/embeds.html` with `npm run dev`) for live previews and the code to paste, for example:

```html
<iframe src="https://sv2blocks.com/embed.html?widget=blocks&amp;theme=dark" title="Stratum V2 blocks" width="100%" height="420" loading="lazy" style="border:0;border-radius:24px;display:block"></iframe>
```

Options go in the address: `widget` (`blocks`, `leaderboard`), `theme` (`dark`, `light`, `auto`), `range` (`24h`, `1w`, `1m`, `all`), `unit` (`btc`, `usd`), `rows` (1 to 10) and `link=0` to hide the link back. A widget reads the same data files as the dashboard and updates by itself. To change the theme of a widget that is already showing, without reloading it, the embedding page can send it `{ type: 'sv2blocks:theme', theme: 'dark' }` (or `'light'`) with `postMessage` once the widget has sent `sv2blocks:ready`. The embedding page must be able to frame this site, and a page served over https can only frame an https address.

[MIT license](LICENSE)
