import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';
import { createChart } from './chart';
import { loadChunk, loadSummary, parseSummary, subsidy } from './data';
import { fmtAgo, fmtBtc, fmtClock, fmtDay, fmtInt, fmtPercent, fmtUsd } from './format';
import { createGrid, type GridSource } from './grid';
import type { BlockChunk, BlockInfo, RangeKey, Summary, Sv2Block, Theme, Unit } from './types';

const config = __SV2_CONFIG__;
const RANGES: RangeKey[] = ['24H', '1W', '1M', 'ALL'];
const WINDOW_SECONDS: Record<Exclude<RangeKey, 'ALL'>, number> = { '24H': 86400, '1W': 7 * 86400, '1M': 30 * 86400 };
const REFRESH_MS = 5 * 60 * 1000;
const AGO_REFRESH_MS = 60 * 1000;
const PREFETCH_CHUNKS = 2;
const RECENT_BLOCK_LIMIT = 5;
const blockDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function $<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
}

// Preferences live in this browser only. Storage can be unavailable (private mode), so every call is guarded.
const saved = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`sv2blocks:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`sv2blocks:${key}`, value);
    } catch {
      /* not saved; the choice still applies to this visit */
    }
  },
};

const savedRange = saved.get('range') as RangeKey | null;
const state: { range: RangeKey; unit: Unit } = {
  range: savedRange && RANGES.includes(savedRange) ? savedRange : config.defaultRange,
  unit: saved.get('unit') === 'USD' ? 'USD' : 'BTC',
};
let summary: Summary | null = embeddedSummary();
let shownKey = '';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const tweens = new WeakMap<Element, number>();
let refreshing = false;
// Per-block details for the grid's hover card. They are not needed to draw the grid, so they are
// fetched in small files only once someone points at it.
const chunks = new Map<number, BlockChunk | 'loading' | 'missing'>();

const blockUrl = (height: number, id: string) =>
  id ? config.blockUrlByHash.replace('{hash}', id) : config.blockUrlByHeight.replace('{height}', String(height));

const chart = createChart({
  root: $('chart'),
  svg: $<SVGElement>('chart-svg'),
  guides: $<SVGPathElement>('chart-guides'),
  line: $<SVGPathElement>('chart-line'),
  area: $<SVGPathElement>('chart-area'),
  dot: $('chart-dot'),
  cursor: $('chart-cursor'),
  cursorDot: $('chart-cursor-dot'),
  readout: $('chart-readout'),
  scale: $('chart-scale'),
  ticks: $('chart-ticks'),
});

const grid = createGrid(
  {
    root: $('grid'),
    canvas: $<HTMLCanvasElement>('grid-canvas'),
    outline: $('grid-outline'),
    tip: $('grid-tip'),
    tipHeight: $('tip-height'),
    tipTag: $('tip-tag'),
    tipPool: $('tip-pool'),
    tipMeta: $('tip-meta'),
  },
  {
    describe: (info: BlockInfo) => ({
      height: fmtInt(info.height),
      tag: info.sv2 ? 'SV2' : 'Other',
      pool: info.state === 'loading' ? 'Loading…' : info.state === 'missing' ? 'Details unavailable' : info.pool,
      meta: info.state ? '' : `${fmtBtc(info.reward, 3)} BTC · ${fmtDay(info.time)} ${fmtClock(info.time)}`,
    }),
    open: (info: BlockInfo) => {
      window.open(blockUrl(info.height, info.id), '_blank', 'noopener,noreferrer');
    },
  },
);

/** Index of the first SV2 block at or above a height (the list is sorted by height). */
function firstAtOrAbove(blocks: Sv2Block[], height: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((blocks[middle]?.h ?? Infinity) < height) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rangeWords(data: Summary): string {
  const words: Record<RangeKey, string> = {
    '24H': 'past 24 hours',
    '1W': 'past week',
    '1M': 'past 30 days',
    ALL: `since block ${fmtInt(data.start)}`,
  };
  return words[state.range];
}

function renderControls(data: Summary | null) {
  for (const button of $('range').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
  }
  const hasPrice = Boolean(data?.price);
  $('unit').hidden = data !== null && !hasPrice;
  const unit: Unit = hasPrice ? state.unit : 'BTC';
  for (const button of $('unit').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.unit === unit));
  }
}

function renderLeaderboard(data: Summary, inRange: Sv2Block[]) {
  const pools = new Map<string, { name: string; blocks: number; sats: number }>();
  for (const block of inRange) {
    const entry = pools.get(block.slug) ?? { name: block.pool, blocks: 0, sats: 0 };
    entry.name = block.pool;
    entry.blocks += 1;
    entry.sats += block.reward;
    pools.set(block.slug, entry);
  }
  const rows = [...pools.values()]
    .sort((a, b) => b.sats - a.sats || b.blocks - a.blocks || a.name.localeCompare(b.name))
    .slice(0, config.leaderboardSize);
  const usd = state.unit === 'USD' && data.price ? data.price.usd : null;

  $('board-list').replaceChildren(
    ...rows.map((row, index) => {
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
    }),
  );
  $('board-empty').hidden = rows.length > 0;
  $('board-list').hidden = rows.length === 0;
}

function renderRecentBlocks(inRange: Sv2Block[]) {
  $('recent-blocks').hidden = inRange.length === 0;
  $('recent-list').replaceChildren(...inRange.slice(-RECENT_BLOCK_LIMIT).reverse().map((block) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'recent-row';
    link.href = blockUrl(block.h, block.id);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    const height = document.createElement('span');
    height.className = 'recent-height';
    height.textContent = fmtInt(block.h);
    const pool = document.createElement('span');
    pool.className = 'recent-pool';
    pool.textContent = block.pool;
    pool.title = block.pool;
    const date = new Date(block.t * 1000);
    const time = document.createElement('time');
    time.dateTime = date.toISOString();
    time.textContent = blockDate.format(date);

    link.append(height, pool, time);
    item.append(link);
    return item;
  }));
}

function requestChunk(data: Summary, index: number) {
  if (!data.chunkSize || index < 0 || chunks.has(index)) return;
  chunks.set(index, 'loading');
  const expectedStart = data.start + index * data.chunkSize;
  loadChunk(index)
    .then((chunk) => {
      if (chunk.start !== expectedStart) throw new Error('Block details do not line up with the summary');
      // Skip the result if the cache was cleared while this was in flight.
      if (chunks.get(index) === 'loading') chunks.set(index, chunk);
    })
    .catch((error) => {
      console.error(error);
      if (chunks.get(index) === 'loading') chunks.set(index, 'missing');
    })
    .finally(() => grid.refreshSelection());
}

function blockDetails(data: Summary, height: number): { time: number; pool: string; reward: number } | 'loading' | 'missing' {
  if (!data.chunkSize) return 'missing';
  const index = Math.floor((height - data.start) / data.chunkSize);
  const chunk = chunks.get(index);
  if (chunk === undefined) {
    requestChunk(data, index);
    return 'loading';
  }
  if (chunk === 'loading' || chunk === 'missing') return chunk;
  const offset = height - chunk.start;
  // A file older than the summary lacks the newest blocks; it is fetched again after the next update.
  if (offset < 0 || offset >= chunk.count) return 'missing';
  return { time: chunk.time[offset] ?? 0, pool: chunk.pools[chunk.pool[offset] ?? -1] ?? 'Unknown', reward: chunk.reward[offset] ?? 0 };
}

/** Fetches details for the newest blocks in view as soon as the pointer or focus reaches the grid. */
function prefetchDetails() {
  if (!summary?.chunkSize) return;
  const last = Math.floor((summary.tip - summary.start) / summary.chunkSize);
  const first = Math.floor((summary.ranges[state.range] - summary.start) / summary.chunkSize);
  for (let index = last; index >= Math.max(first, last - PREFETCH_CHUNKS + 1); index--) requestChunk(summary, index);
}

/** The grid is drawn from the summary alone: how many blocks, and which of them are Stratum V2. */
function gridSource(data: Summary, inRange: Sv2Block[], rangeStart: number): GridSource {
  const byHeight = new Map(inRange.map((block) => [block.h, block]));
  return {
    count: Math.max(0, data.tip - rangeStart + 1),
    isSv2: (index) => byHeight.has(rangeStart + index),
    info: (index) => {
      const height = rangeStart + index;
      const block = byHeight.get(height);
      if (block) return { height, time: block.t, pool: block.pool, reward: block.reward, sv2: true, id: block.id };
      const details = blockDetails(data, height);
      if (typeof details === 'string') return { height, time: 0, pool: '', reward: 0, sv2: false, id: '', state: details };
      return { height, ...details, sv2: false, id: '' };
    },
  };
}

const middle = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length >> 1;
  return sorted.length === 0 ? null : sorted.length % 2 ? (sorted[half] ?? null) : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
};

/** Fees collected against fees on offer: the Stratum V2 blocks in range beside every other block. */
function renderCapture(data: Summary, inRange: Sv2Block[], words: string) {
  const other = data.capture[state.range];
  // An instance that does not audit blocks has no figures at all; the tile then has nothing to say.
  const tracked = data.sv2.some((block) => block.exp > 0) || data.capture.ALL.n > 0;
  $('capture').hidden = !tracked;
  if (!tracked) return;
  const ratios = inRange.filter((block) => block.exp > 0).map((block) => Math.max(0, block.reward - subsidy(block.h)) / block.exp);
  const sv2 = middle(ratios);
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const show = (id: string, value: number | null) => {
    $(id).textContent = value === null ? '–' : percent(value);
    $(`${id}-bar`).style.width = `${Math.min(100, Math.max(0, (value ?? 0) * 100))}%`;
  };
  if (sv2 === null) {
    const value = $('capture-value');
    cancelAnimationFrame(tweens.get(value) ?? 0);
    delete value.dataset.value;
    value.textContent = '–';
  } else {
    tweenNumber($('capture-value'), sv2 * 100, (value) => `${value.toFixed(2)}%`);
  }
  show('capture-sv2', sv2);
  show('capture-other', other.median);
  const blocks = (count: number, kind: string) => `${fmtInt(count)} ${kind} ${count === 1 ? 'block' : 'blocks'}`;
  $('capture-count').textContent = `${blocks(ratios.length, 'Stratum V2')} and ${blocks(other.n, 'other')}, ${words}`;
  $('capture-help').hidden = false;
}

function renderLatest(data: Summary) {
  const latest = data.sv2[data.sv2.length - 1];
  const latestLink = $<HTMLAnchorElement>('latest-height');
  if (latest) {
    latestLink.textContent = fmtInt(latest.h);
    latestLink.href = blockUrl(latest.h, latest.id);
    $('latest-meta').textContent = `${latest.pool} · ${fmtAgo(latest.t, Math.floor(Date.now() / 1000))}`;
  } else {
    latestLink.textContent = '–';
    latestLink.removeAttribute('href');
    $('latest-meta').textContent = '';
  }
}

/** The build writes the current summary into the page; reading it here saves the first round trip. */
function embeddedSummary(): Summary | null {
  try {
    const text = document.getElementById('summary-data')?.textContent;
    return text ? parseSummary(JSON.parse(text)) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** Counts a figure from the value it showed before to its new one. */
function tweenNumber(element: HTMLElement, to: number, format: (value: number) => string) {
  const from = Number(element.dataset.value ?? 0);
  element.dataset.value = String(to);
  cancelAnimationFrame(tweens.get(element) ?? 0);
  if (reduceMotion.matches || from === to || !Number.isFinite(from)) {
    element.textContent = format(to);
    return;
  }
  const started = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / 700);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(progress < 1 ? from + (to - from) * eased : to);
    if (progress < 1) tweens.set(element, requestAnimationFrame(step));
  };
  element.textContent = format(from);
  tweens.set(element, requestAnimationFrame(step));
}

/** Restarts a CSS entrance animation on an element. */
function replay(element: HTMLElement, name: string) {
  element.classList.remove(name);
  void element.offsetWidth;
  element.classList.add(name);
}

/** Swaps the loading placeholders for real content (or, on failure, for the plain empty state). */
function finishLoading() {
  document.body.removeAttribute('data-loading');
  $('dashboard').removeAttribute('aria-busy');
}

function render() {
  renderControls(summary);
  if (!summary) return;
  finishLoading();
  const data = summary;
  const rangeStart = data.ranges[state.range];
  const inRange = data.sv2.slice(firstAtOrAbove(data.sv2, rangeStart));
  const total = data.sv2.length;
  const delta = inRange.length;
  const before = total - delta;
  const blocksInRange = Math.max(0, data.tip - rangeStart + 1);
  const words = rangeWords(data);
  // Entrance animations play on first show, on a range change and when a new Stratum V2 block lands,
  // not on every redraw (BTC/USD) or routine background refresh.
  const key = `${state.range}|${total}`;
  const entering = key !== shownKey;
  if (!entering) for (const id of ['board-list', 'recent-list']) $(id).classList.remove('is-entering');

  const indexed = data.tip >= data.start
    ? `Indexed through block ${fmtInt(data.tip)}`
    : `Tracking starts at block ${fmtInt(data.start)}`;
  $('indexed-tip').textContent = data.synced === false ? `Backfill incomplete · ${indexed}` : indexed;
  const indexedTime = $<HTMLTimeElement>('indexed-time');
  indexedTime.dateTime = new Date(data.updatedAt * 1000).toISOString();
  indexedTime.textContent = `${fmtDay(data.updatedAt)} at ${fmtClock(data.updatedAt)}`;
  $('data-freshness').hidden = false;

  tweenNumber($('total'), total, (value) => fmtInt(Math.round(value)));
  $('tracked-scope').textContent = `since block ${fmtInt(data.start)}`;
  $('tracking-help').hidden = false;
  $('hero-change').hidden = state.range === 'ALL';
  $('delta').textContent = `${fmtInt(delta)} ${delta === 1 ? 'block' : 'blocks'}`;
  $('delta').classList.toggle('flat', delta === 0);
  $('range-text').textContent = words;

  const times = inRange.map((block) => block.t).sort((a, b) => a - b);
  const tEnd = data.updatedAt;
  const tStart = state.range === 'ALL' ? Math.min(times[0] ?? tEnd - 86400, tEnd - 1) : tEnd - WINDOW_SECONDS[state.range];
  const shortLabel = state.range === '24H' ? fmtClock : fmtDay;
  const longLabel = (time: number) => (state.range === '24H' ? fmtClock(time) : state.range === '1W' ? `${fmtDay(time)} ${fmtClock(time)}` : fmtDay(time));
  const span = tEnd - tStart;
  $('chart-wrap').hidden = false;
  chart.render(
    { times, before, tStart, tEnd, label: longLabel },
    [shortLabel(tStart), shortLabel(tStart + span / 3), shortLabel(tStart + (2 * span) / 3), shortLabel(tEnd)],
  );

  const boardRange = $('board-range');
  boardRange.textContent = state.range === 'ALL' ? '' : words;
  boardRange.hidden = !boardRange.textContent;
  renderLeaderboard(data, inRange);

  renderLatest(data);
  renderCapture(data, inRange, words);

  const share = fmtPercent(delta, blocksInRange);
  tweenNumber($('share'), blocksInRange > 0 ? (delta / blocksInRange) * 100 : 0, (value) => (blocksInRange > 0 ? `${value.toFixed(2)}%` : '0%'));
  $('share-count').textContent = `${fmtInt(delta)} of ${fmtInt(blocksInRange)} blocks`;
  $('share-range').textContent = words;
  $('share-help').hidden = false;

  const gridShare = $('grid-share');
  gridShare.textContent = `${share} SV2`;
  gridShare.hidden = false;
  renderRecentBlocks(inRange);
  const source = gridSource(data, inRange, rangeStart);
  const gridStatus = $('grid-status');
  $('block-visual').hidden = source.count === 0;
  gridStatus.hidden = source.count > 0;
  if (source.count > 0) {
    grid.setSource(source, `Block grid: ${fmtInt(delta)} Stratum V2 blocks out of ${fmtInt(source.count)}, ${words}`);
  } else {
    gridStatus.textContent = 'No blocks to show in this range';
  }

  if (entering) {
    shownKey = key;
    replay($('chart'), 'is-drawing');
    replay($('board-list'), 'is-entering');
    replay($('recent-list'), 'is-entering');
    replay($('block-visual'), 'is-entering');
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await loadSummary();
    const changed = !summary || next.updatedAt !== summary.updatedAt || next.tip !== summary.tip || next.synced !== summary.synced;
    // Details fetched earlier can be out of date once the chain has moved (new blocks, or a reorg near the tip).
    if (summary && (next.tip !== summary.tip || next.start !== summary.start || next.chunkSize !== summary.chunkSize)) chunks.clear();
    // Anything that failed to load gets another try.
    for (const [index, chunk] of chunks) if (chunk === 'missing') chunks.delete(index);
    summary = next;
    $('status').hidden = true;
    if (changed) render();
    else renderLatest(next);
  } catch (error) {
    console.error(error);
    if (!summary) {
      finishLoading();
      $('status').textContent = 'Block data is not available yet.';
      $('status').hidden = false;
    }
  } finally {
    refreshing = false;
  }
}

function buildLinks() {
  $('links').replaceChildren(
    ...config.links.map((link) => {
      const anchor = document.createElement('a');
      anchor.className = 'icon-button glass';
      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.title = link.label;
      anchor.setAttribute('aria-label', link.label);
      const icon = document.createElement('span');
      icon.className = 'link-icon';
      icon.setAttribute('aria-hidden', 'true');
      const image = `url("./${link.icon}")`;
      icon.style.setProperty('-webkit-mask-image', image);
      icon.style.setProperty('mask-image', image);
      anchor.append(icon);
      return anchor;
    }),
  );
}

$('site-title').textContent = config.title;
buildLinks();

for (const help of document.querySelectorAll<HTMLDetailsElement>('.metric-help')) {
  let previewing = false;
  const close = () => {
    previewing = false;
    help.open = false;
  };

  help.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || help.open) return;
    previewing = true;
    help.open = true;
  });

  help.addEventListener('pointerleave', () => {
    if (previewing) close();
  });

  help.querySelector('summary')?.addEventListener('click', (event) => {
    if (!previewing) return;
    event.preventDefault();
    previewing = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && help.open) close();
  });

  document.addEventListener('pointerdown', (event) => {
    if (help.open && event.target instanceof Node && !help.contains(event.target)) close();
  });
}

$('grid').addEventListener('pointerenter', prefetchDetails);
$('grid').addEventListener('focus', prefetchDetails);

$('range').addEventListener('click', (event) => {
  const range = (event.target as HTMLElement).closest('button')?.dataset.range as RangeKey | undefined;
  if (!range || !RANGES.includes(range)) return;
  state.range = range;
  saved.set('range', range);
  render();
});

$('unit').addEventListener('click', (event) => {
  const unit = (event.target as HTMLElement).closest('button')?.dataset.unit;
  if (unit !== 'BTC' && unit !== 'USD') return;
  state.unit = unit;
  saved.set('unit', unit);
  render();
});

$('theme-toggle').addEventListener('click', () => {
  const next: Theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  saved.set('theme', next);
  grid.redraw();
});

render();
void refresh();
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
// Keeps "12 min ago" on the latest-block tile current between data updates.
window.setInterval(() => {
  if (summary && document.visibilityState === 'visible') renderLatest(summary);
}, AGO_REFRESH_MS);
