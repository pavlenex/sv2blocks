// Loads the JSON files the data job writes: summary.json for the page, and small per-block files
// for the grid's hover card. All are served by this site itself; the browser never calls
// mempool.space or a price API. Everything read here is checked before it is used.
import type { BlockChunk, Capture, Price, RangeKey, Summary, Sv2Block } from './types';

const SUBSIDY_INTERVAL = 210_000;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isUnixTime = (value: unknown): value is number => isInt(value) && value >= 0 && value <= 8.64e12;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected data format');
  return value as Record<string, unknown>;
};

/** The new-coin part of a block's reward, in satoshis. */
export function subsidy(height: number): number {
  const halvings = Math.floor(height / SUBSIDY_INTERVAL);
  return halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
}

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
    sv2.push({
      h: block.h,
      id: /^[0-9a-f]{64}$/.test(id) ? id : '',
      t: block.t,
      pool: text(block.pool, 48) || 'Unknown',
      slug: text(block.slug, 48) || 'unknown',
      reward: block.reward,
      reason: text(block.reason, 16),
      tag: text(block.tag, 80),
      exp: isInt(block.exp) && block.exp > 0 ? block.exp : 0,
    });
  }
  sv2.sort((a, b) => a.h - b.h);
  const rawCapture = raw.capture !== null && typeof raw.capture === 'object' ? (raw.capture as Record<string, unknown>) : {};
  const capture = (key: RangeKey): Capture => {
    const value = rawCapture[key];
    if (value === null || typeof value !== 'object') return { n: 0, median: null };
    const { n, median } = value as Record<string, unknown>;
    const usable = isInt(n) && n > 0 && typeof median === 'number' && Number.isFinite(median) && median >= 0;
    return usable ? { n, median } : { n: 0, median: null };
  };
  return {
    updatedAt,
    start,
    tip,
    synced: typeof raw.synced === 'boolean' ? raw.synced : undefined,
    chunkSize: isInt(raw.chunkSize) && raw.chunkSize > 0 ? raw.chunkSize : 0,
    price: parsePrice(raw.price),
    ranges: { '24H': range('24H'), '1W': range('1W'), '1M': range('1M'), ALL: start },
    capture: { '24H': capture('24H'), '1W': capture('1W'), '1M': capture('1M'), ALL: capture('ALL') },
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
    reward[index] = Math.max(0, subsidy(start + index) + (extra[index] ?? 0));
  }
  return { start, count, pools, time, pool, reward };
}

export const loadSummary = async () => parseSummary(await getJson('./data/summary.json'));

export async function loadChunk(index: number): Promise<BlockChunk> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Bad block details index');
  return parseChunk(await getJson(`./data/blocks/${index}.json`));
}
