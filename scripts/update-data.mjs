#!/usr/bin/env node
// Brings public/data up to date with the chain: fetches new blocks from the configured mempool
// instance, marks the Stratum V2 ones, fetches today's BTC price, and writes summary.json (what the
// page loads), blocks/<n>.json (per-block details, loaded on hover) and chain.json (this job's record).
//
//   npm run data:update              incremental (first run backfills from detection.startHeight)
//   npm run data:update -- --rescan  ignore stored blocks and fetch everything again
//   npm run data:update -- --backfill-all   fill in every missing expected-fees figure in one go
//
// Environment:
//   SV2_MEMPOOL_API         overrides mempool.apiBase
//   SV2_PRICE_SOURCE        overrides price.source
//   SV2_REQUEST_DELAY_MS    overrides mempool.requestDelayMs
//   SV2_DATA_DIR            where to read and write the data files (default public/data)
//   SV2_PREVIOUS_DATA_URL   site URL to download the previous data from when none is on disk
//   SV2_MAX_RUNTIME_SEC     stop fetching after this long and save progress (default 1500)
//   SV2_RESCAN              "true" does the same as --rescan (used by the deploy workflow)
//   SV2_BACKFILL_PAGES      overrides mempool.backfillPagesPerRun
//
// API use: a normal run makes about four requests (tip, one or two pages of blocks, price). Only a
// first run or a rescan fetches everything, about 1,500 requests spaced mempool.requestDelayMs apart.
// Blocks stored before the job recorded expected fees are filled in a little per run
// (mempool.backfillPagesPerRun requests, Stratum V2 blocks first, then newest first) until none are left.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, loadOverrides } from './lib/config.mjs';
import { autoDetect, compilePatterns, detectionFingerprint } from './lib/detect.mjs';
import { HttpError, PAGE_SIZE, createClient, fetchWithRetry } from './lib/mempool.mjs';
import { fetchPrice } from './lib/price.mjs';
import { NOT_FETCHED, NO_AUDIT, appendBlock, buildSummary, chunkCount, chainTip, decodeChain, emptyChain, encodeChain, encodeChunk, sv2Blocks, truncateChain } from './lib/store.mjs';

const REORG_DEPTH = PAGE_SIZE; // the newest blocks are always fetched again
const CHECKPOINT_PAGES = 100;
const MAX_DELAY_MS = 10000; // the slowest we go when the API keeps answering 429
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[sv2blocks] ${message}`);

async function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

/**
 * Where to look for the data the live site already has. GitHub reports a custom domain as http://
 * until its certificate is issued, so https is tried first and plain http only as a fallback.
 */
export function previousDataUrls(siteUrl) {
  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new Error(`SV2_PREVIOUS_DATA_URL is not a valid URL: ${siteUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`SV2_PREVIOUS_DATA_URL must be a plain http(s) address: ${siteUrl}`);
  }
  const path = `${url.pathname.replace(/\/+$/, '')}/data/chain.json`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local');
  if (local) return [`${url.protocol}//${url.host}${path}`];
  const urls = [`https://${url.host}${path}`];
  if (url.protocol === 'http:') urls.push(`http://${url.host}${path}`);
  return urls;
}

/** readPrevious found no data, and the site did not even answer with a clean "not found". */
const UNREACHABLE = Symbol('unreachable');

async function readPrevious(dataDir, previousUrl, timeoutMs) {
  try {
    return decodeChain(JSON.parse(await readFile(path.join(dataDir, 'chain.json'), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') log(`Stored chain.json is unusable (${error.message}); ignoring it.`);
  }
  if (!previousUrl) return null;
  let reachable = false;
  // The first deploy, a domain that is still being set up, or a parked domain all mean "nothing to
  // resume from": start from scratch. Only a server error from a site that exists stops the run,
  // because starting over then would re-fetch every block for no good reason.
  for (const url of previousDataUrls(previousUrl)) {
    try {
      const chain = decodeChain(await fetchWithRetry(`${url}?t=${Date.now()}`, { timeoutMs, retries: 2, log }));
      log(`Loaded ${chain.t.length} stored blocks from ${url}.`);
      if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) && !new URL(url).hostname.endsWith('.local')) {
        log('This was read over plain http. Tick "Enforce HTTPS" in the Pages settings once it is offered.');
      }
      return chain;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        log(`No previous data at ${url} yet.`);
        reachable = true;
        continue;
      }
      if (error instanceof HttpError && (error.status >= 500 || error.status === 429)) {
        throw new Error(`Could not load previous data: ${error.message}`);
      }
      log(`No usable data at ${url} (${error.message}).`);
    }
  }
  return reachable ? null : UNREACHABLE;
}

/**
 * Fills in expected fees for blocks stored before that figure was recorded, at most `maxPages`
 * requests per run so a shared public API is never asked for everything at once.
 */
async function backfillExpectedFees({ chain, overrides, client, maxPages, delay, outOfTime }) {
  const missing = (height) => chain.e[height - chain.start] === NOT_FETCHED;
  function* wanted() {
    for (const { height } of sv2Blocks(chain, overrides).reverse()) yield height; // what the page shows first
    for (let height = chainTip(chain); height >= chain.start; height--) yield height;
  }
  let pages = 0;
  try {
    for (const height of wanted()) {
      if (!missing(height)) continue;
      if (pages >= maxPages || outOfTime()) break;
      await sleep(delay());
      const page = await client.blocksEndingAt(height);
      pages++;
      for (const [pageHeight, block] of page) {
        const index = pageHeight - chain.start;
        if (index < 0 || index >= chain.t.length || chain.e[index] !== NOT_FETCHED) continue;
        // Only trust the figure if this is the block we stored (a reorg would have changed its time).
        chain.e[index] = block.timestamp === chain.t[index] && block.expectedFees !== null ? block.expectedFees : NO_AUDIT;
      }
      if (missing(height)) chain.e[height - chain.start] = NO_AUDIT; // never ask for the same block forever
    }
  } catch (error) {
    log(`Expected-fees backfill paused (${error.message}); the next run continues.`);
  }
  const left = chain.e.reduce((count, value) => count + (value === NOT_FETCHED ? 1 : 0), 0);
  if (pages > 0) log(`Filled in expected fees with ${pages} request${pages === 1 ? '' : 's'}; ${left} block${left === 1 ? '' : 's'} still to go.`);
  return pages;
}

export async function updateData({ argv = process.argv.slice(2), env = process.env, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const config = await loadConfig({ env });
  const overrides = await loadOverrides(config);
  const dataDir = path.resolve(ROOT, env.SV2_DATA_DIR || 'public/data');
  const maxRuntimeMs = (Number(env.SV2_MAX_RUNTIME_SEC) || 1500) * 1000;
  const started = Date.now();
  const { startHeight, poolSlugs, coinbasePatterns } = config.detection;
  const fingerprint = detectionFingerprint(config.detection);
  const regexes = compilePatterns(coinbasePatterns);
  // Be a good citizen of a shared public API: say who is calling, and back off when asked to.
  const repository = /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : '';
  const userAgent = repository ? `sv2blocks-data-job (+https://github.com/${repository})` : 'sv2blocks-data-job';
  let delayMs = config.mempool.requestDelayMs;
  const onRateLimit = () => {
    const slower = Math.min(MAX_DELAY_MS, Math.max(1000, delayMs * 2));
    if (slower !== delayMs) log(`The API asked us to slow down; now waiting ${slower} ms between requests.`);
    delayMs = slower;
  };
  const client = createClient({ apiBase: config.mempool.apiBase, timeoutMs: config.mempool.timeoutMs, log, userAgent, onRateLimit });
  await mkdir(dataDir, { recursive: true });

  const rescan = argv.includes('--rescan') || env.SV2_RESCAN === 'true';
  if (rescan) log('Rescan requested; ignoring stored blocks.');
  let chain = rescan ? null : await readPrevious(dataDir, env.SV2_PREVIOUS_DATA_URL, config.mempool.timeoutMs);
  if (chain === UNREACHABLE) {
    // Fetching every block again is about 1,500 requests. An unattended run must not repeat that
    // every ten minutes just because the site address is misconfigured or briefly unreachable.
    if (env.GITHUB_EVENT_NAME === 'schedule') {
      throw new Error('The previous data could not be reached, and a scheduled run will not re-fetch every block on its own. Check the site address, or run the workflow manually to start from scratch.');
    }
    log('The previous data could not be reached; starting from scratch.');
    chain = null;
  }
  if (chain && (chain.start !== startHeight || chain.fingerprint !== fingerprint)) {
    log('Start height or detection rule changed; fetching every block again.');
    chain = null;
  }
  chain ??= emptyChain(startHeight, fingerprint);

  // chain.json is this job's own record (it resumes from it). The site reads summary.json and,
  // for hover details, the small files under blocks/.
  const save = async (synced) => {
    await writeJson(path.join(dataDir, 'chain.json'), encodeChain(chain, overrides));
    await mkdir(path.join(dataDir, 'blocks'), { recursive: true });
    for (let index = 0; index < chunkCount(chain); index++) {
      await writeJson(path.join(dataDir, 'blocks', `${index}.json`), encodeChunk(chain, index));
    }
    await writeJson(path.join(dataDir, 'summary.json'), buildSummary(chain, overrides, { now: now(), synced }));
  };

  const tip = await client.tipHeight();
  log(`Instance ${config.mempool.apiBase} is at block ${tip}.`);

  // Fetch the newest stored blocks again so a reorg cannot leave stale data behind.
  truncateChain(chain, Math.min(chain.t.length - REORG_DEPTH, tip - startHeight + 1));

  let cursor = chain.start + chain.t.length;
  let pages = 0;
  let synced = true;
  while (cursor <= tip) {
    if (Date.now() - started > maxRuntimeMs) {
      log(`Time budget used up at block ${cursor - 1}; the next run continues from here.`);
      synced = false;
      break;
    }
    const top = Math.min(cursor + PAGE_SIZE - 1, tip);
    let page;
    try {
      page = await client.blocksEndingAt(top);
    } catch (error) {
      // Keep what was fetched so far, so the next run continues instead of starting over.
      if (pages > 0) await save(false);
      throw error;
    }
    for (let height = cursor; height <= top; height++) {
      const block = page.get(height);
      if (!block) throw new Error(`Block ${height} is missing from the response for /v1/blocks/${top}`);
      appendBlock(chain, block, autoDetect(block, regexes, poolSlugs));
    }
    cursor = top + 1;
    pages++;
    if (pages % CHECKPOINT_PAGES === 0) {
      await save(false);
      log(`Fetched up to block ${top} (${tip - top} to go).`);
    }
    if (cursor <= tip) await sleep(delayMs);
  }

  // Overridden heights need a block hash for their link.
  for (const height of overrides.include) {
    if (height < chain.start || height > chainTip(chain) || chain.ids.has(height)) continue;
    const block = (await client.blocksEndingAt(height)).get(height);
    if (block) chain.ids.set(height, block.id);
  }

  if (synced) {
    await backfillExpectedFees({
      chain,
      overrides,
      client,
      maxPages: argv.includes('--backfill-all') ? Infinity : config.mempool.backfillPagesPerRun,
      delay: () => delayMs,
      outOfTime: () => Date.now() - started > maxRuntimeMs,
    });
  }

  try {
    chain.price = await fetchPrice(config, client.json, now(), chain.price);
  } catch (error) {
    log(`Price not updated (${error.message}); keeping ${chain.price ? `the previous one, $${chain.price.usd}` : 'none'}.`);
  }

  await save(synced);
  const summary = buildSummary(chain, overrides, { now: now(), synced });
  log(`Stored ${chain.t.length} blocks up to ${summary.tip}; ${summary.sv2.length} are Stratum V2. Price: ${chain.price ? `$${chain.price.usd} (${chain.price.source})` : 'none'}.`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  updateData().catch((error) => {
    console.error(`[sv2blocks] ${error.message}`);
    process.exitCode = 1;
  });
}
