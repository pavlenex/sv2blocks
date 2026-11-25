// Loads the JSON files the data job writes: summary.json for the page, and small per-block files
// for the grid's hover card. All are served by this site itself; the browser never calls
// mempool.space or a price API. Everything read here is checked before it is used.
import type { BlockChunk, Price, RangeKey, Summary, Sv2Block, Sv2BlockDetail, Sv2BlocksData } from './types';

const SUBSIDY_INTERVAL = 210_000;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isUnixTime = (value: unknown): value is number => isInt(value) && value >= 0 && value <= 8.64e12;
const optInt = (value: unknown): number | null => (isInt(value) && value >= 0 ? value : null);
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected data format');
  return value as Record<string, unknown>;
};

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-cache', credentials: 'omit' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function parsePrice(value: unknown): Price | null {
  if (value === null || typeof value !== 'object') return null;
  const price = value as Record<string, unknown>;
  if (typeof price.usd !== 'number' || !Number.isFinite(price.usd) || price.usd <= 0) return null;
  return { usd: price.usd, time: isInt(price.time) ? price.time : 0, source: text(price.source, 40) };
}

export function parseSummary(json: unknown): Summary {
  const raw = record(json);
  if (raw.v !== 1) throw new Error('Unsupported summary.json version');
  const { start, tip, updatedAt } = raw;
  if (!isInt(start) || !isInt(tip) || !isUnixTime(updatedAt)) throw new Error('summary.json has an invalid start, tip or updatedAt');
  const rawRanges = record(raw.ranges ?? {});
  const range = (key: RangeKey) => {
    const value = rawRanges[key];
    return isInt(value) ? Math.max(start, value) : start;
  };
  const list = Array.isArray(raw.sv2) ? raw.sv2 : [];
  const sv2: Sv2Block[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (!isInt(block.h) || block.h < start || block.h > tip || !isUnixTime(block.t) || !isInt(block.reward) || block.reward < 0) continue;
    const id = text(block.id, 64);
    const entry: Sv2Block = {
      h: block.h,
      id: /^[0-9a-f]{64}$/.test(id) ? id : '',
      t: block.t,
      pool: text(block.pool, 48) || 'Unknown',
      slug: text(block.slug, 48) || 'unknown',
      reward: block.reward,
      reason: text(block.reason, 16),
      tag: text(block.tag, 80),
    };
    if (block.jdp === true) {
      entry.jdp = true;
      const miner = text(block.miner, 32).trim();
      if (miner) entry.miner = miner;
    }
    sv2.push(entry);
  }
  sv2.sort((a, b) => a.h - b.h);
  return {
    updatedAt,
    start,
    tip,
    synced: typeof raw.synced === 'boolean' ? raw.synced : undefined,
    chunkSize: isInt(raw.chunkSize) && raw.chunkSize > 0 ? raw.chunkSize : 0,
    price: parsePrice(raw.price),
    ranges: { '24H': range('24H'), '1W': range('1W'), '1M': range('1M'), ALL: start },
    sv2,
  };
}

function intColumn(value: unknown, count: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== count || !value.every(isInt)) throw new Error(`Block details: bad column "${name}"`);
  return value as number[];
}

export function parseChunk(json: unknown): BlockChunk {
  const raw = record(json);
  if (raw.v !== 1) throw new Error('Unsupported block details version');
  const { start, count } = raw;
  if (!isInt(start) || start < 0 || !isInt(count) || count < 0) throw new Error('Block details are missing start or count');
  const pools = Array.isArray(raw.pools) ? raw.pools.map((name) => text(name, 48) || 'Unknown') : [];
  const deltas = intColumn(raw.t, count, 't');
  const poolIndex = intColumn(raw.p, count, 'p');
  const extra = intColumn(raw.x, count, 'x');
  const time = new Float64Array(count);
  const pool = new Uint16Array(count);
  const reward = new Float64Array(count);
  let running = 0;
  for (let index = 0; index < count; index++) {
    running += deltas[index] ?? 0;
    time[index] = running;
    pool[index] = poolIndex[index] ?? 0;
    const halvings = Math.floor((start + index) / SUBSIDY_INTERVAL);
    const subsidy = halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
    reward[index] = Math.max(0, subsidy + (extra[index] ?? 0));
  }
  return { start, count, pools, time, pool, reward };
}

export function parseSv2Blocks(json: unknown): Sv2BlocksData {
  const raw = record(json);
  if (raw.v !== 1) throw new Error('Unsupported sv2-blocks.json version');
  const { start, tip, updatedAt } = raw;
  if (!isInt(start) || !isInt(tip) || !isUnixTime(updatedAt)) throw new Error('sv2-blocks.json has an invalid start, tip or updatedAt');
  const list = Array.isArray(raw.blocks) ? raw.blocks : [];
  const blocks: Sv2BlockDetail[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (!isInt(block.h) || block.h < start || block.h > tip || !isUnixTime(block.t) || !isInt(block.reward) || block.reward < 0) continue;
    const id = text(block.id, 64);
    const halvings = Math.floor(block.h / SUBSIDY_INTERVAL);
    const fallbackSubsidy = halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
    const sub = optInt(block.subsidy) ?? fallbackSubsidy;
    const fees = optInt(block.fees) ?? Math.max(0, block.reward - sub);
    const jdp = block.jdp === true;
    const miner = jdp ? text(block.miner, 32).trim() : '';
    blocks.push({
      h: block.h,
      id: /^[0-9a-f]{64}$/.test(id) ? id : '',
      t: block.t,
      pool: text(block.pool, 48) || 'Unknown',
      slug: text(block.slug, 48) || 'unknown',
      reward: block.reward,
      subsidy: sub,
      fees,
      coinbaseAddress: text(block.coinbaseAddress, 100),
      reason: text(block.reason, 16),
      tag: text(block.tag, 80),
      jdp,
      miner: miner || undefined,
    });
  }
  blocks.sort((a, b) => a.h - b.h);
  return {
    updatedAt,
    start,
    tip,
    synced: typeof raw.synced === 'boolean' ? raw.synced : undefined,
    price: parsePrice(raw.price),
    blocks,
  };
}

export const loadSummary = async () => parseSummary(await getJson('./data/summary.json'));

export const loadSv2Blocks = async () => parseSv2Blocks(await getJson('./data/sv2-blocks.json'));

export async function loadChunk(index: number): Promise<BlockChunk> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Bad block details index');
  return parseChunk(await getJson(`./data/blocks/${index}.json`));
}
