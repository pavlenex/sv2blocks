// One dashboard tile on a bare page, meant to be shown in an <iframe> on another site.
//   embed.html?widget=blocks        the block count with its growth chart (default)
//   embed.html?widget=leaderboard   pools ranked by Stratum V2 revenue
// Options: theme=dark|light|auto, range=24h|1w|1m|all, unit=btc|usd, rows=1..10, link=0.
// Like the dashboard, it reads only this site's own data files and never turns text into HTML.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';
import './embed.css';
import { boardItems, boardRows } from './board';
import { createChart } from './chart';
import { loadSummary, parseSummary } from './data';
import { fmtInt } from './format';
import { initHelp } from './help';
import { RANGES, blocksInRange, chartInput, describeRange } from './range';
import type { RangeKey, Summary, Unit } from './types';

const config = __SV2_CONFIG__;
const REFRESH_MS = 5 * 60 * 1000;

function $<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
}

/** Options come from the address only. Anything unrecognised falls back to the site's default. */
function readOptions() {
  const query = new URLSearchParams(window.location.search);
  const text = (name: string) => (query.get(name) ?? '').trim().toUpperCase();
  const range = RANGES.find((key) => key === text('range'));
  const rows = Number(query.get('rows'));
  return {
    widget: text('widget') === 'LEADERBOARD' ? ('leaderboard' as const) : ('blocks' as const),
    followSystem: !['DARK', 'LIGHT'].includes(text('theme')) && (text('theme') !== '' || document.documentElement.dataset.defaultTheme === 'system'),
    range: (range ?? config.defaultRange) as RangeKey,
    unit: (text('unit') === 'USD' ? 'USD' : 'BTC') as Unit,
    rows: Number.isInteger(rows) && rows >= 1 && rows <= 10 ? rows : config.leaderboardSize,
    link: !['0', 'FALSE', 'NO', 'OFF'].includes(text('link')),
  };
}

const options = readOptions();
const state: { unit: Unit } = { unit: options.unit };
const widget = $(options.widget === 'blocks' ? 'widget-blocks' : 'widget-leaderboard');
let summary: Summary | null = embeddedSummary();
let refreshing = false;
let reportedHeight = 0;

const chart =
  options.widget === 'blocks'
    ? createChart({
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
      })
    : null;

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

function finishLoading() {
  document.body.removeAttribute('data-loading');
}

function renderBlocks(data: Summary) {
  const inRange = blocksInRange(data, options.range);
  $('total').textContent = fmtInt(data.sv2.length);
  $('tracked-scope').textContent = `since block ${fmtInt(data.start)}`;
  $('tracking-help').hidden = false;
  $('hero-change').hidden = options.range === 'ALL';
  $('delta').textContent = `${fmtInt(inRange.length)} ${inRange.length === 1 ? 'block' : 'blocks'}`;
  $('delta').classList.toggle('flat', inRange.length === 0);
  $('range-text').textContent = describeRange(options.range, data.start);
  const { model, ticks } = chartInput(data, options.range, inRange);
  $('chart-wrap').hidden = false;
  chart?.render(model, ticks);
}

function renderLeaderboard(data: Summary) {
  const hasPrice = Boolean(data.price);
  const unit: Unit = hasPrice ? state.unit : 'BTC';
  $('unit').hidden = !hasPrice;
  for (const button of $('unit').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.unit === unit));
  }
  const caption = $('board-range');
  caption.textContent = options.range === 'ALL' ? '' : describeRange(options.range, data.start);
  caption.hidden = !caption.textContent;
  const rows = boardRows(blocksInRange(data, options.range), options.rows);
  $('board-list').replaceChildren(...boardItems(rows, unit === 'USD' && data.price ? data.price.usd : null));
  $('board-list').hidden = rows.length === 0;
  $('board-empty').hidden = rows.length > 0;
}

function render() {
  if (!summary) return;
  finishLoading();
  if (options.widget === 'blocks') renderBlocks(summary);
  else renderLeaderboard(summary);
  reportHeight();
}

/**
 * Tells the embedding page how tall the widget would like to be, so a page that wants a perfect fit
 * can size the iframe (see embeds.html). The message carries a height and nothing else.
 */
function reportHeight() {
  if (window.parent === window) return;
  document.body.classList.add('is-measuring');
  const height = Math.ceil(widget.getBoundingClientRect().height);
  document.body.classList.remove('is-measuring');
  if (height === reportedHeight || height <= 0) return;
  reportedHeight = height;
  window.parent.postMessage({ type: 'sv2blocks:height', widget: options.widget, height }, '*');
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await loadSummary();
    const changed = !summary || next.updatedAt !== summary.updatedAt || next.tip !== summary.tip;
    summary = next;
    $('status').hidden = true;
    if (changed) render();
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

// A quiet link back to the full dashboard, unless the embedding page asked for none.
for (const link of document.querySelectorAll<HTMLAnchorElement>('.widget-link')) {
  link.href = new URL('./', window.location.href).href;
  link.textContent = `${config.title} ↗`;
  link.hidden = !options.link;
}

document.getElementById('unit')?.addEventListener('click', (event) => {
  const unit = (event.target as HTMLElement).closest('button')?.dataset.unit;
  if (unit !== 'BTC' && unit !== 'USD') return;
  state.unit = unit;
  render();
});

if (options.followSystem) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
    document.documentElement.setAttribute('data-theme', event.matches ? 'light' : 'dark');
  });
}

// Only the chosen widget stays in the page.
$(options.widget === 'blocks' ? 'widget-leaderboard' : 'widget-blocks').remove();

initHelp();
window.addEventListener('resize', reportHeight);
// Text can change size once the fonts arrive.
void document.fonts?.ready.then(reportHeight);
render();
void refresh();
window.setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
