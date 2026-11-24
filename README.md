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

[MIT license](LICENSE)
