import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHUNK_SIZE, NOT_FETCHED, NO_AUDIT, appendBlock, buildSummary, captureBaseline, chunkCount, decodeChain, emptyChain, encodeChain, encodeChunk, rangeStarts, subsidy, sv2Blocks, truncateChain } from '../scripts/lib/store.mjs';

const id = (n) => n.toString(16).padStart(64, '0');
function sampleChain() {
  const chain = emptyChain(1000, 'abc');
  for (let i = 0; i < 10; i++) {
    const block = { height: 1000 + i, id: id(i), timestamp: 5000 + i * 600, reward: subsidy(1000 + i) + 1000 + i, poolSlug: i % 2 ? 'a' : 'b', poolName: i % 2 ? 'Pool A' : 'Pool B' };
    appendBlock(chain, block, i === 3 ? { reason: 'tag', tag: '/sv2/' } : null);
  }
  return chain;
}

test('subsidy halves on schedule', () => {
  assert.equal(subsidy(0), 5_000_000_000);
  assert.equal(subsidy(955318), 312_500_000);
  assert.equal(subsidy(210000 * 64), 0);
});

test('chain.json round-trips', () => {
  const chain = sampleChain();
  chain.price = { usd: 100000, time: 1, source: 'fixed' };
  const copy = decodeChain(JSON.parse(JSON.stringify(encodeChain(chain, { include: [1005], exclude: [] }))));
  assert.deepEqual(copy.t, chain.t);
  assert.deepEqual(copy.p, chain.p);
  assert.deepEqual(copy.x, chain.x);
  assert.deepEqual(copy.pools, chain.pools);
  assert.deepEqual([...copy.auto], [...chain.auto]);
  assert.deepEqual(copy.price, chain.price);
});

test('rejects files whose columns do not line up', () => {
  const encoded = encodeChain(sampleChain(), { include: [], exclude: [] });
  assert.throws(() => decodeChain({ ...encoded, t: encoded.t.slice(1) }));
  assert.throws(() => decodeChain({ ...encoded, p: encoded.p.map(() => 9) }));
  assert.throws(() => decodeChain({ ...encoded, v: 99 }));
});

test('overrides add and remove blocks', () => {
  const chain = sampleChain();
  assert.deepEqual(sv2Blocks(chain, { include: [1005, 99999], exclude: [] }).map((b) => [b.height, b.reason]), [[1003, 'tag'], [1005, 'override']]);
  assert.deepEqual(sv2Blocks(chain, { include: [1005], exclude: [1003] }).map((b) => b.height), [1005]);
});

test('blocks must be appended in order, and truncation forgets later blocks', () => {
  const chain = sampleChain();
  assert.throws(() => appendBlock(chain, { height: 2000, id: id(1), timestamp: 1, reward: 1, poolSlug: 'a', poolName: 'A' }, null));
  truncateChain(chain, 3);
  assert.equal(chain.t.length, 3);
  assert.equal(chain.auto.size, 0);
});

test('chunks cover every block exactly once and carry their own pool names', () => {
  const chain = emptyChain(1000, 'abc');
  const total = CHUNK_SIZE + 10;
  for (let i = 0; i < total; i++) {
    appendBlock(chain, { height: 1000 + i, id: id(i), timestamp: 5000 + i * 600 + (i % 7), reward: subsidy(1000 + i) + i, poolSlug: i < CHUNK_SIZE ? 'a' : i % 2 ? 'b' : 'c', poolName: i < CHUNK_SIZE ? 'Pool A' : i % 2 ? 'Pool B' : 'Pool C' }, null);
  }
  assert.equal(chunkCount(chain), 2);
  const [first, second] = [encodeChunk(chain, 0), encodeChunk(chain, 1)];
  assert.deepEqual([first.start, first.count, second.start, second.count], [1000, CHUNK_SIZE, 1000 + CHUNK_SIZE, 10]);
  assert.deepEqual(first.pools, ['Pool A']);
  assert.deepEqual([...second.pools].sort(), ['Pool B', 'Pool C']);
  for (const chunk of [first, second]) {
    let time = 0;
    chunk.t.forEach((delta, k) => {
      time += delta;
      const position = chunk.start - chain.start + k;
      assert.equal(time, chain.t[position]);
      assert.equal(chunk.pools[chunk.p[k]], chain.pools[chain.p[position]].name);
      assert.equal(chunk.x[k], chain.x[position]);
    });
  }
  assert.equal(buildSummary(chain, { include: [], exclude: [] }, { now: 1, synced: true }).chunkSize, CHUNK_SIZE);
});

test('expected fees: old files load as not fetched, and the summary compares Stratum V2 with the rest', () => {
  const chain = emptyChain(1000, 'abc');
  for (let i = 0; i < 6; i++) {
    // fees are 1000 for every block; block 3 is Stratum V2 and block 5 has no audit
    const expectedFees = [1250, 1000, 2000, 1001, 1000, null][i];
    const block = { height: 1000 + i, id: id(i), timestamp: 5000 + i * 600, reward: subsidy(1000 + i) + 1000, expectedFees, poolSlug: 'a', poolName: 'Pool A' };
    appendBlock(chain, block, i === 3 ? { reason: 'tag', tag: '/sv2/' } : null);
  }
  assert.deepEqual(chain.e, [1250, 1000, 2000, 1001, 1000, NO_AUDIT]);
  const encoded = JSON.parse(JSON.stringify(encodeChain(chain, { include: [], exclude: [] })));
  assert.deepEqual(decodeChain(encoded).e, chain.e);
  const { e, ...older } = encoded;
  assert.deepEqual(decodeChain(older).e, new Array(6).fill(NOT_FETCHED));
  assert.deepEqual(decodeChain({ ...encoded, e: [1, 2] }).e, new Array(6).fill(NOT_FETCHED));

  const summary = buildSummary(chain, { include: [], exclude: [] }, { now: 5000 + 5 * 600, synced: true });
  assert.equal(summary.sv2[0].exp, 1001);
  // other blocks with a figure: 1000/1250, 1000/1000, 1000/2000, 1000/1000 -> median 0.9
  assert.deepEqual(summary.capture.ALL, { n: 4, median: 0.9 });
  assert.deepEqual(captureBaseline(chain, { none: 1006 }, []).none, { n: 0, median: null });
  truncateChain(chain, 2);
  assert.equal(chain.e.length, 2);
});

test('time windows count back from now', () => {
  const chain = sampleChain(); // blocks at 5000, 5600, ... 10400
  const now = 10400 + 86400;
  assert.equal(rangeStarts(chain, now)['24H'], 1009);
  assert.equal(rangeStarts(chain, now + 1)['24H'], 1010); // empty window
  assert.equal(rangeStarts(chain, now)['1W'], 1000);
  const summary = buildSummary(chain, { include: [], exclude: [] }, { now, synced: true });
  assert.equal(summary.tip, 1009);
  assert.deepEqual(summary.sv2.map((b) => [b.h, b.pool, b.reward]), [[1003, 'Pool A', subsidy(1003) + 1003]]);
});
