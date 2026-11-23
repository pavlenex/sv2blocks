# sv2blocks

Tracks Bitcoin blocks mined with Stratum V2, their share of all tracked blocks, and rewards by mining pool.

## GitHub Pages

1. Publish this repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. In **Actions → Update data and deploy**, choose **Run workflow** on the default branch. The Pages settings show the site URL after it deploys.

The [included workflow](.github/workflows/deploy.yml) checks the mempool API every 10 minutes and on pushes to the default branch. It loads the previous snapshot from the published site, fetches new blocks, checks recent blocks for reorgs, and publishes the rebuilt site. A new block appears after a scheduled run finishes. GitHub can delay scheduled runs.

The first run fetches history from block 955,318. To rebuild all data later, run the workflow manually with **Fetch every block again** ticked.

### Mempool API use

A normal run makes about four requests to the mempool API: the tip height, one or two pages of blocks, and the price. Only the first run, a manual rescan, or a change to the detection settings fetches everything, about 1,500 requests spaced `mempool.requestDelayMs` apart. The job backs off when the API answers 429, keeps what it has fetched if a request fails, and a scheduled run never starts a full re-fetch on its own. The public mempool.space API does not publish its limits, so avoid rescans you do not need. If scheduled runs stop after 60 days of inactivity on a public repo, re-enable the workflow in **Actions**.

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
