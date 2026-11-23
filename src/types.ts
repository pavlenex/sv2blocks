export type RangeKey = '24H' | '1W' | '1M' | 'ALL';
export type Unit = 'BTC' | 'USD';
export type Theme = 'dark' | 'light';

export interface ClientConfig {
  title: string;
  defaultRange: RangeKey;
  startHeight: number;
  blockUrlByHash: string;
  blockUrlByHeight: string;
  leaderboardSize: number;
  links: { label: string; href: string; icon: string }[];
}

export interface Sv2Block {
  h: number;
  id: string;
  t: number;
  pool: string;
  slug: string;
  /** Subsidy plus fees, in satoshis. */
  reward: number;
  reason: string;
  tag: string;
  /** Fees that were available when the block arrived, in satoshis. 0 when the data has no figure. */
  exp: number;
}

/** How much of the available fees a group of blocks collected: the median of fees / expected fees. */
export interface Capture {
  n: number;
  median: number | null;
}

export interface Price {
  usd: number;
  time: number;
  source: string;
}

export interface Summary {
  updatedAt: number;
  start: number;
  tip: number;
  synced?: boolean;
  /** Blocks per details file under data/blocks/. 0 when the data has none. */
  chunkSize: number;
  price: Price | null;
  ranges: Record<RangeKey, number>;
  /** Fee capture of the blocks that are not Stratum V2, per range. */
  capture: Record<RangeKey, Capture>;
  sv2: Sv2Block[];
}

/** Details for a run of consecutive blocks, as parallel columns. Index 0 is block `start`. */
export interface BlockChunk {
  start: number;
  count: number;
  pools: string[];
  time: Float64Array;
  pool: Uint16Array;
  reward: Float64Array;
}

/** One square in the block grid. */
export interface BlockInfo {
  height: number;
  time: number;
  pool: string;
  reward: number;
  sv2: boolean;
  id: string;
  /** Set while a block's details are still being fetched, or could not be. */
  state?: 'loading' | 'missing';
}
