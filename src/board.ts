// The pool leaderboard: Stratum V2 blocks grouped by pool, ranked by revenue. Shared by the
// dashboard and the embeddable widget.
import { fmtBtc, fmtInt, fmtUsd } from './format';
import type { Sv2Block } from './types';

export interface BoardRow {
  name: string;
  blocks: number;
  /** Subsidy plus fees of the pool's blocks, in satoshis. */
  sats: number;
}

export function boardRows(blocks: Sv2Block[], limit: number): BoardRow[] {
  const pools = new Map<string, BoardRow>();
  for (const block of blocks) {
    const entry = pools.get(block.slug) ?? { name: block.pool, blocks: 0, sats: 0 };
    entry.name = block.pool;
    entry.blocks += 1;
    entry.sats += block.reward;
    pools.set(block.slug, entry);
  }
  return [...pools.values()]
    .sort((a, b) => b.sats - a.sats || b.blocks - a.blocks || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** One list item per pool. `usd` is today's price when revenue should be shown in dollars, else null. */
export function boardItems(rows: BoardRow[], usd: number | null): HTMLLIElement[] {
  return rows.map((row, index) => {
    const item = document.createElement('li');
    item.className = index === 0 ? 'board-row lead' : 'board-row';
    const name = document.createElement('span');
    name.className = 'board-name';
    name.textContent = row.name;
    name.title = row.name;
    const count = document.createElement('span');
    count.className = 'board-count';
    count.textContent = `${fmtInt(row.blocks)} ${row.blocks === 1 ? 'block' : 'blocks'}`;
    const revenue = document.createElement('span');
    revenue.className = 'board-revenue';
    const amount = document.createElement('span');
    amount.textContent = usd === null ? fmtBtc(row.sats, 2) : fmtUsd((row.sats / 1e8) * usd);
    revenue.append(amount);
    if (usd === null) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = 'BTC';
      revenue.append(unit);
    }
    item.append(name, count, revenue);
    return item;
  });
}
