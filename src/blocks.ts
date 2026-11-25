import { loadSummary, loadSv2Blocks } from './data';
import { fmtBtc, fmtClock, fmtDay, fmtInt, fmtUsd } from './format';
import type { Sv2BlockDetail, Sv2BlocksData, Theme, Unit } from './types';

const config = __SV2_CONFIG__;
const fullDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

type TemplateFilter = 'all' | 'jdp';
type SortKey = 'h' | 't' | 'pool' | 'subsidy' | 'fees' | 'reward';

function $<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
}

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
      /* ignore unavailable storage */
    }
  },
};

const query = new URLSearchParams(window.location.search);
const initialTemplate = query.get('template')?.toLowerCase();

const state: {
  template: TemplateFilter;
  pool: string;
  search: string;
  unit: Unit;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
} = {
  template: initialTemplate === 'jdp' || initialTemplate === 'jd' ? 'jdp' : 'all',
  pool: query.get('pool') ?? '',
  search: '',
  unit: saved.get('unit') === 'USD' ? 'USD' : 'BTC',
  sortKey: 'h',
  sortDir: 'desc',
  page: 1,
  pageSize: 25,
};

let dataset: Sv2BlocksData | null = null;

const blockUrl = (height: number, id: string) =>
  id ? config.blockUrlByHash.replace('{hash}', id) : config.blockUrlByHeight.replace('{height}', String(height));

function fmtMoney(sats: number, usdPrice: number | null, btcDigits = 3): string {
  if (usdPrice !== null) return fmtUsd((sats / 1e8) * usdPrice);
  return `${fmtBtc(sats, btcDigits)} BTC`;
}

function filteredBlocks(): Sv2BlockDetail[] {
  if (!dataset) return [];
  const term = state.search.trim().toLowerCase();
  const rows = dataset.blocks.filter((block) => {
    if (state.template === 'jdp' && !block.jdp) return false;
    if (state.pool && block.slug !== state.pool) return false;
    if (term) {
      const hay = `${block.h} ${block.pool} ${block.miner ?? ''} ${block.tag} ${block.id}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });

  const dir = state.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    switch (state.sortKey) {
      case 'h':
        return (a.h - b.h) * dir;
      case 't':
        return (a.t - b.t) * dir || (a.h - b.h) * dir;
      case 'pool':
        return a.pool.localeCompare(b.pool) * dir || (b.h - a.h);
      case 'subsidy':
        return (a.subsidy - b.subsidy) * dir || (b.h - a.h);
      case 'fees':
        return (a.fees - b.fees) * dir || (b.h - a.h);
      case 'reward':
        return (a.reward - b.reward) * dir || (b.h - a.h);
    }
  });
  return rows;
}

function renderStats(rows: Sv2BlockDetail[], usdPrice: number | null) {
  const count = rows.length;
  const totalReward = rows.reduce((sum, b) => sum + b.reward, 0);
  const totalFees = rows.reduce((sum, b) => sum + b.fees, 0);

  $('stat-count').textContent = fmtInt(count);
  $('stat-revenue').textContent = count > 0 ? fmtMoney(totalReward, usdPrice, 2) : '-';
  $('stat-fees').textContent = count > 0 ? fmtMoney(totalFees, usdPrice, 4) : '-';
}

function renderPoolOptions(data: Sv2BlocksData) {
  const select = $<HTMLSelectElement>('filter-pool');
  const pools = new Map<string, string>();
  for (const block of data.blocks) pools.set(block.slug, block.pool);
  const sorted = [...pools.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const options = [new Option('All pools', '')];
  for (const [slug, name] of sorted) options.push(new Option(name, slug));
  select.replaceChildren(...options);
  select.value = pools.has(state.pool) ? state.pool : '';
  if (!pools.has(state.pool)) state.pool = '';
}

function renderControls(data: Sv2BlocksData | null) {
  for (const button of $('filter-template').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.template === state.template));
  }
  const hasPrice = Boolean(data?.price);
  $('unit').hidden = data !== null && !hasPrice;
  const unit: Unit = hasPrice ? state.unit : 'BTC';
  for (const button of $('unit').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.unit === unit));
  }
  for (const th of document.querySelectorAll<HTMLTableCellElement>('.data-table th')) {
    const key = th.querySelector<HTMLButtonElement>('.sort-btn')?.dataset.sort;
    if (key === state.sortKey) th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
}

function renderTable(rows: Sv2BlockDetail[], usdPrice: number | null) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const startIdx = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(startIdx, startIdx + state.pageSize);

  const tbody = $('blocks-tbody');
  tbody.replaceChildren(
    ...pageRows.map((block) => {
      const tr = document.createElement('tr');

      const tdBlock = document.createElement('td');
      const link = document.createElement('a');
      link.className = block.jdp ? 'cell-block is-jdp' : 'cell-block';
      link.href = blockUrl(block.h, block.id);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = fmtInt(block.h);
      tdBlock.append(link);

      const tdTime = document.createElement('td');
      tdTime.className = 'cell-time';
      const date = new Date(block.t * 1000);
      const time = document.createElement('time');
      time.dateTime = date.toISOString();
      time.textContent = `${fullDate.format(date)} · ${fmtClock(block.t)}`;
      tdTime.append(time);

      const tdPool = document.createElement('td');
      const entity = document.createElement('span');
      entity.className = 'cell-entity';
      const poolSpan = document.createElement('span');
      poolSpan.className = 'cell-pool';
      poolSpan.textContent = block.pool;
      entity.append(poolSpan);
      if (block.jdp) {
        const badge = document.createElement('span');
        badge.className = 'jdp-badge';
        badge.textContent = block.miner ? `JD · ${block.miner}` : 'JD';
        badge.title = block.miner
          ? `Job Declaration: block template built by miner "${block.miner}"`
          : 'Job Declaration: block template built by the miner';
        entity.append(badge);
      }
      tdPool.append(entity);

      const tdSubsidy = document.createElement('td');
      tdSubsidy.className = 'num cell-mono';
      tdSubsidy.textContent = fmtMoney(block.subsidy, usdPrice, 3);

      const tdFees = document.createElement('td');
      tdFees.className = 'num cell-mono';
      tdFees.textContent = fmtMoney(block.fees, usdPrice, 4);

      const tdTotal = document.createElement('td');
      tdTotal.className = 'num cell-mono';
      tdTotal.textContent = fmtMoney(block.reward, usdPrice, 3);

      const tdTag = document.createElement('td');
      const tagSpan = document.createElement('span');
      tagSpan.className = 'cell-tag';
      tagSpan.textContent = block.tag || '-';
      if (block.tag) tagSpan.title = block.tag;
      tdTag.append(tagSpan);

      tr.append(tdBlock, tdTime, tdPool, tdSubsidy, tdFees, tdTotal, tdTag);
      return tr;
    }),
  );

  $('table-scroll').hidden = total === 0;
  $('table-empty').hidden = total > 0;
  $('pagination').hidden = total === 0;
  $<HTMLButtonElement>('export-csv').disabled = total === 0;

  if (total > 0) {
    const endIdx = Math.min(total, startIdx + pageRows.length);
    $('page-summary').textContent = `Showing ${fmtInt(startIdx + 1)}-${fmtInt(endIdx)} of ${fmtInt(total)}`;
    $('page-indicator').textContent = `${state.page} / ${totalPages}`;
    $<HTMLButtonElement>('page-prev').disabled = state.page <= 1;
    $<HTMLButtonElement>('page-next').disabled = state.page >= totalPages;
  }
}

function render() {
  renderControls(dataset);
  if (!dataset) return;
  document.body.removeAttribute('data-loading');
  $('blocks-page').removeAttribute('aria-busy');

  const usdPrice = state.unit === 'USD' && dataset.price ? dataset.price.usd : null;
  const rows = filteredBlocks();
  renderStats(rows, usdPrice);
  renderTable(rows, usdPrice);

  const blockRange = dataset.tip >= dataset.start
    ? `Blocks ${fmtInt(dataset.start)} - ${fmtInt(dataset.tip)}`
    : `Tracking from block ${fmtInt(dataset.start)}`;
  $('indexed-tip').textContent = dataset.synced === false ? `Syncing · ${blockRange}` : blockRange;
  const indexedTime = $<HTMLTimeElement>('indexed-time');
  indexedTime.dateTime = new Date(dataset.updatedAt * 1000).toISOString();
  indexedTime.textContent = `${fmtDay(dataset.updatedAt)}, ${fmtClock(dataset.updatedAt)}`;
  $('data-freshness').hidden = false;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function exportCsv() {
  const rows = filteredBlocks();
  if (rows.length === 0) return;
  const header = [
    'height',
    'hash',
    'timestamp_utc',
    'pool',
    'pool_slug',
    'template_type',
    'miner_tag',
    'subsidy_sats',
    'fees_sats',
    'total_reward_sats',
    'coinbase_address',
    'coinbase_tag',
  ];
  const lines = [header.join(',')];
  for (const b of rows) {
    lines.push(
      [
        b.h,
        b.id,
        new Date(b.t * 1000).toISOString(),
        b.pool,
        b.slug,
        b.jdp ? 'JD' : 'pool',
        b.miner ?? '',
        b.subsidy,
        b.fees,
        b.reward,
        b.coinbaseAddress,
        b.tag,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sv2blocks-${state.template}.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

async function init() {
  try {
    dataset = await loadSv2Blocks();
  } catch {
    try {
      const summary = await loadSummary();
      dataset = {
        updatedAt: summary.updatedAt,
        start: summary.start,
        tip: summary.tip,
        synced: summary.synced,
        price: summary.price,
        blocks: summary.sv2.map((b) => {
          const halvings = Math.floor(b.h / 210_000);
          const sub = halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
          return {
            ...b,
            subsidy: sub,
            fees: Math.max(0, b.reward - sub),
            coinbaseAddress: '',
          };
        }),
      };
    } catch (error) {
      console.error(error);
      document.body.removeAttribute('data-loading');
      $('blocks-page').removeAttribute('aria-busy');
      $('status').textContent = 'Block data is not available yet.';
      $('status').hidden = false;
      return;
    }
  }
  renderPoolOptions(dataset);
  render();
}

$('site-title').textContent = config.title;
buildLinks();

$('filter-template').addEventListener('click', (event) => {
  const value = (event.target as HTMLElement).closest('button')?.dataset.template;
  if (value !== 'all' && value !== 'jdp') return;
  state.template = value;
  state.page = 1;
  render();
});

$('filter-pool').addEventListener('change', (event) => {
  state.pool = (event.target as HTMLSelectElement).value;
  state.page = 1;
  render();
});

$('filter-search').addEventListener('input', (event) => {
  state.search = (event.target as HTMLInputElement).value;
  state.page = 1;
  render();
});

$('unit').addEventListener('click', (event) => {
  const unit = (event.target as HTMLElement).closest('button')?.dataset.unit;
  if (unit !== 'BTC' && unit !== 'USD') return;
  state.unit = unit;
  saved.set('unit', unit);
  render();
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.sort-btn')) {
  button.addEventListener('click', () => {
    const key = button.dataset.sort as SortKey | undefined;
    if (!key) return;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    else {
      state.sortKey = key;
      state.sortDir = key === 'pool' ? 'asc' : 'desc';
    }
    state.page = 1;
    render();
  });
}

$('page-size').addEventListener('change', (event) => {
  const size = Number((event.target as HTMLSelectElement).value);
  if (Number.isInteger(size) && size > 0) {
    state.pageSize = size;
    state.page = 1;
    render();
  }
});

$('page-prev').addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    render();
  }
});

$('page-next').addEventListener('click', () => {
  state.page += 1;
  render();
});

$('export-csv').addEventListener('click', exportCsv);

function syncThemeLabel() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  $('theme-toggle').setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
}

syncThemeLabel();
$('theme-toggle').addEventListener('click', () => {
  const next: Theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  saved.set('theme', next);
  syncThemeLabel();
});

renderControls(null);
void init();
