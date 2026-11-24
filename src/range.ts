// Time ranges: which Stratum V2 blocks fall inside one, how to name it, and what the growth chart
// should draw for it. Shared by the dashboard and the embeddable widgets.
import type { ChartModel } from './chart';
import { fmtClock, fmtDay, fmtInt } from './format';
import type { RangeKey, Summary, Sv2Block } from './types';

export const RANGES: RangeKey[] = ['24H', '1W', '1M', 'ALL'];
export const WINDOW_SECONDS: Record<Exclude<RangeKey, 'ALL'>, number> = { '24H': 86400, '1W': 7 * 86400, '1M': 30 * 86400 };

/** Index of the first SV2 block at or above a height (the list is sorted by height). */
export function firstAtOrAbove(blocks: Sv2Block[], height: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((blocks[middle]?.h ?? Infinity) < height) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The Stratum V2 blocks inside a range, oldest first. */
export function blocksInRange(data: Summary, range: RangeKey): Sv2Block[] {
  return data.sv2.slice(firstAtOrAbove(data.sv2, data.ranges[range]));
}

export function describeRange(range: RangeKey, start: number): string {
  const words: Record<RangeKey, string> = {
    '24H': 'past 24 hours',
    '1W': 'past week',
    '1M': 'past 30 days',
    ALL: `since block ${fmtInt(start)}`,
  };
  return words[range];
}

/** What the growth chart draws for a range: its model and the four labels under it. */
export function chartInput(data: Summary, range: RangeKey, inRange: Sv2Block[]): { model: ChartModel; ticks: string[] } {
  const times = inRange.map((block) => block.t).sort((a, b) => a - b);
  const tEnd = data.updatedAt;
  const tStart = range === 'ALL' ? Math.min(times[0] ?? tEnd - 86400, tEnd - 1) : tEnd - WINDOW_SECONDS[range];
  const shortLabel = range === '24H' ? fmtClock : fmtDay;
  const label = (time: number) => (range === '24H' ? fmtClock(time) : range === '1W' ? `${fmtDay(time)} ${fmtClock(time)}` : fmtDay(time));
  const span = tEnd - tStart;
  return {
    model: { times, before: data.sv2.length - inRange.length, tStart, tEnd, label },
    ticks: [shortLabel(tStart), shortLabel(tStart + span / 3), shortLabel(tStart + (2 * span) / 3), shortLabel(tEnd)],
  };
}
