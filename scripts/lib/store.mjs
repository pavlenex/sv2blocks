// The stored data: one compact file with every block since the start height (chain.json),
// and one small file with only what the first paint needs (summary.json).

export const FORMAT = 1;
export const WINDOWS = { '24H': 86400, '1W': 7 * 86400, '1M': 30 * 86400 };
// Per-block details for the grid's hover card are published in files of this many blocks, so a
// visitor only downloads the part they point at and no file grows without limit.
export const CHUNK_SIZE = 4096;

export function subsidy(height) {
  const halvings = Math.floor(height / 210000);
  return halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
}

export function emptyChain(start, fingerprint) {
  return { start, fingerprint, t: [], p: [], x: [], pools: [], auto: new Map(), ids: new Map(), price: null };
}

export function chainTip(chain) {
  return chain.start + chain.t.length - 1;
}

export function appendBlock(chain, block, detected) {
  const expected = chain.start + chain.t.length;
  if (block.height !== expected) throw new Error(`Expected block ${expected}, got ${block.height}`);
  let poolIndex = chain.pools.findIndex((pool) => pool.slug === block.poolSlug);
  if (poolIndex === -1) {
    poolIndex = chain.pools.length;
    chain.pools.push({ slug: block.poolSlug, name: block.poolName });
  } else {
    chain.pools[poolIndex].name = block.poolName;
  }
  chain.t.push(block.timestamp);
  chain.p.push(poolIndex);
  chain.x.push(block.reward - subsidy(block.height)); // fees claimed; small numbers keep the file compact
  if (detected) {
    chain.auto.set(block.height, detected);
    chain.ids.set(block.height, block.id);
  }
}

/** Keep only the first `length` blocks. Used to re-fetch the newest blocks in case of a reorg. */
export function truncateChain(chain, length) {
  const keep = Math.max(0, Math.min(length, chain.t.length));
  chain.t.length = keep;
  chain.p.length = keep;
  chain.x.length = keep;
  const limit = chain.start + keep;
  for (const height of [...chain.auto.keys()]) if (height >= limit) chain.auto.delete(height);
  for (const height of [...chain.ids.keys()]) if (height >= limit) chain.ids.delete(height);
}

/** The final list of SV2 heights: automatic matches plus overrides.include, minus overrides.exclude. */
export function sv2Blocks(chain, overrides) {
  const tip = chainTip(chain);
  const excluded = new Set(overrides.exclude);
  const found = new Map();
  for (const [height, detected] of chain.auto) found.set(height, detected);
  for (const height of overrides.include) {
    if (height < chain.start || height > tip) continue;
    if (!found.has(height)) found.set(height, { reason: 'override', tag: '' });
  }
  return [...found.entries()]
    .filter(([height]) => !excluded.has(height))
    .sort((a, b) => a[0] - b[0])
    .map(([height, detected]) => ({ height, reason: detected.reason, tag: detected.tag }));
}

/** First height inside each time window, counted back from `now`. tip + 1 means the window is empty. */
export function rangeStarts(chain, now) {
  const tip = chainTip(chain);
  const result = {};
  for (const [name, seconds] of Object.entries(WINDOWS)) {
    const cutoff = now - seconds;
    let index = chain.t.length;
    while (index > 0 && chain.t[index - 1] >= cutoff) index--;
    result[name] = chain.start + index;
  }
  result.ALL = chain.start;
  return { ...result, tip };
}

export function buildSummary(chain, overrides, { now, synced }) {
  const { tip, ...ranges } = rangeStarts(chain, now);
  const sv2 = sv2Blocks(chain, overrides).map(({ height, reason, tag }) => {
    const index = height - chain.start;
    const pool = chain.pools[chain.p[index]] ?? { slug: 'unknown', name: 'Unknown' };
    return {
      h: height,
      id: chain.ids.get(height) ?? '',
      t: chain.t[index],
      pool: pool.name,
      slug: pool.slug,
      reward: chain.x[index] + subsidy(height),
      reason,
      tag,
    };
  });
  return { v: FORMAT, updatedAt: now, start: chain.start, tip, synced, chunkSize: CHUNK_SIZE, price: chain.price, ranges, sv2 };
}

export function encodeChain(chain, overrides) {
  const deltas = chain.t.map((time, index) => (index === 0 ? time : time - chain.t[index - 1]));
  return {
    v: FORMAT,
    start: chain.start,
    fingerprint: chain.fingerprint,
    count: chain.t.length,
    price: chain.price,
    pools: chain.pools,
    t: deltas,
    p: chain.p,
    x: chain.x,
    s: sv2Blocks(chain, overrides).map(({ height }) => height - chain.start),
    auto: Object.fromEntries(chain.auto),
    ids: Object.fromEntries(chain.ids),
  };
}

export function chunkCount(chain) {
  return Math.ceil(chain.t.length / CHUNK_SIZE);
}

/** Blocks [index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) as a small self-contained file. */
export function encodeChunk(chain, index) {
  const from = index * CHUNK_SIZE;
  const to = Math.min(chain.t.length, from + CHUNK_SIZE);
  const names = [];
  const local = new Map();
  const t = [];
  const p = [];
  for (let position = from; position < to; position++) {
    const global = chain.p[position];
    let slot = local.get(global);
    if (slot === undefined) {
      slot = names.length;
      local.set(global, slot);
      names.push(chain.pools[global]?.name ?? 'Unknown');
    }
    p.push(slot);
    t.push(position === from ? chain.t[position] : chain.t[position] - chain.t[position - 1]);
  }
  return { v: FORMAT, start: chain.start + from, count: Math.max(0, to - from), pools: names, t, p, x: chain.x.slice(from, to) };
}

const isIntArray = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isSafeInteger);

export function decodeChain(json) {
  if (json === null || typeof json !== 'object' || json.v !== FORMAT) throw new Error('unknown chain.json format');
  const { start, fingerprint, count, pools, t, p, x } = json;
  if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0) throw new Error('chain.json: bad start or count');
  if (!isIntArray(t, count) || !isIntArray(p, count) || !isIntArray(x, count)) throw new Error('chain.json: column lengths do not match count');
  if (!Array.isArray(pools) || pools.some((pool) => typeof pool?.slug !== 'string' || typeof pool?.name !== 'string')) throw new Error('chain.json: bad pools');
  if (p.some((index) => index < 0 || index >= pools.length)) throw new Error('chain.json: pool index out of range');
  const times = new Array(count);
  let running = 0;
  for (let index = 0; index < count; index++) {
    running += t[index];
    times[index] = running;
  }
  const chain = emptyChain(start, typeof fingerprint === 'string' ? fingerprint : '');
  chain.t = times;
  chain.p = [...p];
  chain.x = [...x];
  chain.pools = pools.map((pool) => ({ slug: pool.slug, name: pool.name }));
  const inRange = (height) => Number.isInteger(height) && height >= start && height < start + count;
  for (const [key, detected] of Object.entries(json.auto ?? {})) {
    const height = Number(key);
    if (inRange(height) && ['tag', 'pool'].includes(detected?.reason)) {
      chain.auto.set(height, { reason: detected.reason, tag: String(detected.tag ?? '').slice(0, 80) });
    }
  }
  for (const [key, id] of Object.entries(json.ids ?? {})) {
    const height = Number(key);
    if (inRange(height) && typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) chain.ids.set(height, id);
  }
  const price = json.price;
  if (price && Number.isFinite(price.usd) && price.usd > 0) {
    chain.price = { usd: price.usd, time: Number(price.time) || 0, source: String(price.source ?? '') };
  }
  return chain;
}
