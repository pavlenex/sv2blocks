# sv2blocks

Tracks Bitcoin blocks mined with Stratum V2. The new blocks are also posted on X by [@sv2blocks](https://x.com/sv2blocks) and can be tracked on [Telegram](https://t.me/+LZeFAU3jydQxZGY0).

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

Job Declaration Protocol (JDP) blocks (where the miner builds the block template rather than the pool) are detected automatically from the `Sv2/<pool_tag>/<miner_tag>/` coinbase convention (see [stratum#2141](https://github.com/stratum-mining/stratum/discussions/2141), case-insensitive `sv2` or `v2` prefix with a non-empty `miner_tag`). Add confirmed blocks with unrecognized tags to `include`, false matches to `exclude`, and manually confirmed JDP blocks (with optional miner tag) to `jdp` in [data/overrides.json](data/overrides.json). DMND block 955,318 (`GM`) is included manually. Changes take effect on the next data update.

## Embed widgets

Two tiles can be shown on other sites in an `<iframe>`: the block count with its growth chart, and the leaderboard.

```html
<!-- Blocks & growth chart -->
<iframe src="https://sv2blocks.com/embed.html?widget=blocks&amp;theme=dark" title="Stratum V2 blocks" width="100%" height="420" loading="lazy" style="border:0;border-radius:24px;display:block"></iframe>

<!-- Leaderboard -->
<iframe src="https://sv2blocks.com/embed.html?widget=leaderboard&amp;theme=dark" title="Stratum V2 leaderboard" width="100%" height="320" loading="lazy" style="border:0;border-radius:24px;display:block"></iframe>
```

| Parameter | Values | What it does |
|---|---|---|
| `widget` | `blocks`, `leaderboard` | Which widget to show |
| `theme` | `dark`, `light`, `auto` | `auto` follows the visitor's device |
| `range` | `24h`, `1w`, `1m`, `all` | Time range |
| `unit` | `btc`, `usd` | Leaderboard revenue currency (visitors can still switch) |
| `rows` | `1` to `10` | Maximum pools listed in the leaderboard |
| `link` | `0` | Hides the link back to sv2blocks |

To auto-fit the leaderboard iframe height as pools join, add this script once on the embedding page:

```html
<script>
  addEventListener('message', function (event) {
    if (event.origin !== 'https://sv2blocks.com' || !event.data || event.data.type !== 'sv2blocks:height') return;
    var height = Number(event.data.height);
    if (!(height > 0 && height < 4000)) return;
    document.querySelectorAll('iframe').forEach(function (frame) {
      if (frame.contentWindow === event.source) frame.style.height = Math.ceil(height) + 'px';
    });
  });
</script>
```

To change the theme of an already-loaded widget without reloading it, send `{ type: 'sv2blocks:theme', theme: 'dark' }` (or `'light'`) with `postMessage` once the widget posts `sv2blocks:ready`.

[MIT license](LICENSE)
