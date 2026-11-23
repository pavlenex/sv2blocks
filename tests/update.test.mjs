import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig, validateConfig } from '../scripts/lib/config.mjs';
import { createFakeApi } from '../scripts/lib/fake-api.mjs';
import { previousDataUrls, updateData } from '../scripts/update-data.mjs';

const config = await loadConfig({ env: {} });
const START = config.detection.startHeight;
let api;
let origin;
let dir;
const env = (extra = {}) => ({ SV2_MEMPOOL_API: `${origin}/api`, SV2_REQUEST_DELAY_MS: '0', SV2_DATA_DIR: dir, SV2_PRICE_SOURCE: 'mempool', ...extra });
const readJson = async (name) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const silently = async (fn) => {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
};

before(async () => {
  api = createFakeApi({ start: START, tip: START + 100, sv2Rate: () => 0.2 });
  origin = await api.listen();
  dir = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
});
after(async () => {
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

test('backfills, then only fetches what is new', async () => {
  const first = await silently(() => updateData({ argv: [], env: env() }));
  assert.equal(first.tip, START + 100);
  assert.equal(first.synced, true);
  assert.equal(first.price.usd, 98765.43);
  assert.equal(first.sv2[0].h, START);
  assert.equal(first.sv2[0].reason, 'override');
  assert.equal(first.sv2[0].pool, 'DMND');
  assert.equal(first.sv2[0].id, api.block(START).id);
  assert.ok(first.sv2.length > 5 && first.sv2.slice(1).every((b) => b.reason === 'tag' && /^[0-9a-f]{64}$/.test(b.id)));
  for (const b of first.sv2) assert.equal(b.reward, api.block(b.h).extras.reward);
  const chain = await readJson('chain.json');
  assert.equal(chain.count, 101);
  const chunk = await readJson('blocks/0.json');
  assert.deepEqual([chunk.start, chunk.count, first.chunkSize], [START, 101, 4096]);
  assert.equal(chunk.t[0], chain.t[0]);
  assert.equal(chain.s.length, first.sv2.length);

  api.state.tip += 20;
  api.state.requests = 0;
  const second = await silently(() => updateData({ argv: [], env: env() }));
  assert.equal(second.tip, START + 120);
  assert.ok(api.state.requests <= 6, `expected a handful of requests, saw ${api.state.requests}`);
  assert.deepEqual(second.sv2.slice(0, 3).map((b) => b.h), first.sv2.slice(0, 3).map((b) => b.h));
});

test('picks up a reorg of the newest blocks', async () => {
  const lastDeltaBefore = (await readJson('chain.json')).t.at(-1);
  api.state.salt.set(api.state.tip, 'reorged');
  await silently(() => updateData({ argv: [], env: env() }));
  const lastDeltaAfter = (await readJson('chain.json')).t.at(-1);
  assert.notEqual(lastDeltaAfter, lastDeltaBefore);
});

test('keeps the previous price when the source fails, and supports a fixed price', async () => {
  api.state.priceStatus = 404;
  const kept = await silently(() => updateData({ argv: [], env: env() }));
  assert.equal(kept.price.usd, 98765.43);
  api.state.priceStatus = 200;
  const fixed = await silently(() => updateData({ argv: [], env: env({ SV2_PRICE_SOURCE: 'fixed' }) }));
  assert.equal(fixed.price.usd, 100000);
  assert.equal(fixed.price.source, 'fixed');
});

test('rejects a price that jumps implausibly, and non-numeric values', async () => {
  await silently(() => updateData({ argv: [], env: env() })); // back to the API price
  for (const bad of [987654.3, 9.87, true, [98000], '']) {
    api.state.priceUsd = bad;
    const kept = await silently(() => updateData({ argv: [], env: env() }));
    assert.equal(kept.price.usd, 98765.43, `should have kept the old price instead of ${JSON.stringify(bad)}`);
  }
  api.state.priceUsd = '101000.5'; // a numeric string, as some APIs send
  const moved = await silently(() => updateData({ argv: [], env: env() }));
  assert.equal(moved.price.usd, 101000.5);
  api.state.priceUsd = 98765.43;
  await silently(() => updateData({ argv: [], env: env() }));
});

test('resumes from the deployed site when nothing is on disk', async () => {
  api.state.files.set('/site/data/chain.json', await readFile(path.join(dir, 'chain.json'), 'utf8'));
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
  try {
    api.state.requests = 0;
    const summary = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/site` }) }));
    assert.equal(summary.tip, api.state.tip);
    assert.ok(api.state.requests <= 6, `expected a handful of requests, saw ${api.state.requests}`);
    // A site with no data yet means a clean start, not an error.
    const empty = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
    const scratch = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: empty, SV2_PREVIOUS_DATA_URL: `${origin}/nothing` }) }));
    assert.equal(scratch.tip, api.state.tip);
    await rm(empty, { recursive: true, force: true });
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('looks for previous data over https first, and over http only when that is all the site has', () => {
  // What GitHub reports for a custom domain before its certificate exists.
  assert.deepEqual(previousDataUrls('http://sv2blocks.com'), ['https://sv2blocks.com/data/chain.json', 'http://sv2blocks.com/data/chain.json']);
  assert.deepEqual(previousDataUrls('https://sv2blocks.com/'), ['https://sv2blocks.com/data/chain.json']);
  assert.deepEqual(previousDataUrls('https://pavlenex.github.io/sv2blocks'), ['https://pavlenex.github.io/sv2blocks/data/chain.json']);
  assert.deepEqual(previousDataUrls('http://127.0.0.1:4000/site'), ['http://127.0.0.1:4000/site/data/chain.json']);
  assert.throws(() => previousDataUrls('ftp://example.com'));
  assert.throws(() => previousDataUrls('https://user:pw@example.com'));
  assert.throws(() => previousDataUrls('not a url'));
});

test('a site that answers with something other than data means a clean start; a server error stops the run', async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
  try {
    api.state.files.set('/parked/data/chain.json', '<html><body>This domain is parked</body></html>');
    const parked = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/parked` }) }));
    assert.equal(parked.tip, api.state.tip);
    await rm(path.join(fresh, 'chain.json'));
    api.state.files.set('/wrong/data/chain.json', '{"hello":"world"}');
    const wrong = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/wrong` }) }));
    assert.equal(wrong.tip, api.state.tip);
    await rm(path.join(fresh, 'chain.json'));
    api.state.statuses.set('/down/data/chain.json', 503);
    await assert.rejects(silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/down` }) })), /Could not load previous data/);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('slows down when the API answers 429, and names itself', async () => {
  api.state.tip += 40;
  api.state.rateLimitNext = 2;
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let summary;
  try {
    summary = await updateData({ argv: [], env: env({ GITHUB_REPOSITORY: 'pavlenex/sv2blocks' }) });
  } finally {
    console.log = original;
  }
  assert.equal(summary.tip, api.state.tip);
  assert.ok(lines.some((line) => /asked us to slow down/.test(line)), lines.join('\n'));
  assert.ok(api.state.userAgents.has('sv2blocks-data-job (+https://github.com/pavlenex/sv2blocks)'));
});

test('keeps the blocks already fetched when a later request fails', async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
  try {
    api.state.failBlocksAbove = START + 50;
    await assert.rejects(silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh }) })), /HTTP 400/);
    const partial = JSON.parse(await readFile(path.join(fresh, 'summary.json'), 'utf8'));
    assert.equal(partial.synced, false);
    assert.ok(partial.tip >= START + 14 && partial.tip <= START + 50, `partial tip ${partial.tip}`);
    api.state.failBlocksAbove = Infinity;
    api.state.requests = 0;
    const done = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh }) }));
    assert.equal(done.tip, api.state.tip);
    assert.ok(api.state.requests < Math.ceil((api.state.tip - START) / 15) + 4, 'the second run should not start over');
  } finally {
    api.state.failBlocksAbove = Infinity;
    await rm(fresh, { recursive: true, force: true });
  }
});

test('a scheduled run refuses to re-fetch everything when the site cannot be reached', async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
  try {
    api.state.files.set('/parked2/data/chain.json', '<html>parked</html>');
    api.state.requests = 0;
    await assert.rejects(silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/parked2`, GITHUB_EVENT_NAME: 'schedule' }) })), /will not re-fetch every block/);
    assert.ok(api.state.requests <= 2, `made ${api.state.requests} requests`);
    // A first deploy (the site answers "not found") and a manual run are both allowed to start from scratch.
    const first = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/nothing-here`, GITHUB_EVENT_NAME: 'schedule' }) }));
    assert.equal(first.tip, api.state.tip);
    await rm(path.join(fresh, 'chain.json'));
    const manual = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_PREVIOUS_DATA_URL: `${origin}/parked2`, GITHUB_EVENT_NAME: 'workflow_dispatch' }) }));
    assert.equal(manual.tip, api.state.tip);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('SV2_RESCAN fetches everything again instead of resuming', async () => {
  api.state.requests = 0;
  const resumed = await silently(() => updateData({ argv: [], env: env() }));
  const resumeRequests = api.state.requests;
  api.state.requests = 0;
  const rescanned = await silently(() => updateData({ argv: [], env: env({ SV2_RESCAN: 'true' }) }));
  assert.ok(api.state.requests > resumeRequests + 3, `rescan made ${api.state.requests} requests, resume made ${resumeRequests}`);
  assert.equal(rescanned.tip, resumed.tip);
  assert.deepEqual(rescanned.sv2.map((b) => b.h), resumed.sv2.map((b) => b.h));
  // Anything other than the exact word "true" (the workflow passes an empty value on scheduled runs) resumes.
  api.state.requests = 0;
  await silently(() => updateData({ argv: [], env: env({ SV2_RESCAN: '' }) }));
  assert.ok(api.state.requests <= 6);
});

test('stops at the time budget and continues next run', async () => {
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sv2blocks-'));
  try {
    const partial = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh, SV2_MAX_RUNTIME_SEC: '0.000001' }) }));
    assert.equal(partial.synced, false);
    const done = await silently(() => updateData({ argv: [], env: env({ SV2_DATA_DIR: fresh }) }));
    assert.equal(done.synced, true);
    assert.equal(done.tip, api.state.tip);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('config rejects unsafe or malformed values', async () => {
  const raw = JSON.parse(await readFile(new URL('../sv2blocks.config.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateConfig(raw));
  assert.throws(() => validateConfig({ ...raw, mempool: { ...raw.mempool, apiBase: 'http://example.com/api' } }), /https/);
  assert.doesNotThrow(() => validateConfig({ ...raw, mempool: { ...raw.mempool, apiBase: 'http://umbrel.local:3006/api' } }));
  assert.throws(() => validateConfig({ ...raw, price: { ...raw.price, source: 'nope' } }), /price.source/);
  assert.throws(() => validateConfig({ ...raw, detection: { ...raw.detection, coinbasePatterns: ['('] } }), /invalid pattern/);
  assert.throws(() => validateConfig({ ...raw, links: [{ label: 'x', href: 'javascript:alert(1)', icon: 'icons/x.svg' }] }), /https/);
  assert.throws(() => validateConfig({ ...raw, links: [{ label: 'x', href: 'https://x.com', icon: '../x.svg' }] }), /icon/);
});
