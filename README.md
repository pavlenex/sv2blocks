# sv2blocks

Tracks Bitcoin blocks mined with Stratum V2, their share of all tracked blocks, and rewards by mining pool.

## GitHub Pages

1. Publish this repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. In **Actions → Update data and deploy**, choose **Run workflow** on the default branch. The Pages settings show the site URL after it deploys.

The [included workflow](.github/workflows/deploy.yml) checks the mempool API every 10 minutes and on pushes to the default branch. It loads the previous snapshot from the published site, fetches new blocks, checks recent blocks for reorgs, and publishes the rebuilt site. A new block appears after a scheduled run finishes. GitHub can delay scheduled runs.

The first run fetches history from block 955,318. To rebuild all data later, run the workflow manually with **Fetch every block again** ticked.

### Mempool API use

A normal run makes about four requests to the mempool API: the tip height, one or two pages of blocks, and the price. Only the first run, a manual rescan, or a change to the detection settings fetches everything, about 1,500 requests spaced `mempool.requestDelayMs` apart. The job backs off when the API answers 429, keeps what it has fetched if a request fails, and a scheduled run never starts a full re-fetch on its own. Data stored before the job recorded expected fees is filled in gradually: each run makes up to `mempool.backfillPagesPerRun` extra requests (40 by default, Stratum V2 blocks first, then newest first) until every block has its figure, which takes a few hours of scheduled runs and then stops. The public mempool.space API does not publish its limits, so avoid rescans you do not need. If scheduled runs stop after 60 days of inactivity on a public repo, re-enable the workflow in **Actions**.

## Run locally

Use Node.js 22.12 or newer.

```sh
npm ci
npm run data:update
npm run dev
```

The first `data:update` after upgrading fills in expected fees for the Stratum V2 blocks and the newest few hundred others; `npm run data:update -- --backfill-all` fills in every block in one go (about 1,500 requests, 12 minutes or so).

For offline development, `npm run data:sample` generates sample data. Run `npm run data:update -- --rescan` when switching back to real blocks. Use `npm run check` to run the type check and tests.

## Fees captured

The **Fees captured** tile compares the fees a block collected with its `expectedFees` from the mempool instance: what that instance's own projected block would have collected when the block arrived. It shows the median for the Stratum V2 blocks in the selected range beside the median for every other block. The figure reflects one node's view of the mempool, and blocks that include privately submitted transactions can exceed 100%. An instance that does not audit blocks has no such figure, and the tile is hidden.

## Block detection

A block matches automatically when its coinbase has a configured tag or its pool is listed in [sv2blocks.config.json](sv2blocks.config.json). Coinbase tags are self-reported.

Add confirmed blocks with unrecognized tags to `include` in [data/overrides.json](data/overrides.json). Add false matches to `exclude`. DMND block 955,318 is included manually. Changes take effect on the next data update.

[MIT license](LICENSE)
