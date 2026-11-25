// The block grid: one equal square per block, stacked from the bottom left with the newest on top.
// Drawn on a canvas so tens of thousands of blocks stay fast; hover, touch and keyboard pick a block.
import type { BlockInfo } from './types';

const ASPECT = 0.38; // height as a share of width
const MAX_CELL = 0.06; // a square never gets wider than this share of the grid
const ROUNDED_FROM = 12; // device pixels; smaller squares are drawn as plain rectangles
const TARGET_CELL = 2; // CSS pixels, when there is room to make a dense grid taller
const MAX_GRID_HEIGHT = 280; // CSS pixels
const MARKER_RADIUS = 4; // CSS pixels

export interface GridSource {
  count: number;
  isSv2(index: number): boolean;
  isJdp?(index: number): boolean;
  info(index: number): BlockInfo;
}

export interface GridElements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  outline: HTMLElement;
  tip: HTMLElement;
  tipHeight: HTMLElement;
  tipTag: HTMLElement;
  tipPool: HTMLElement;
  tipMeta: HTMLElement;
}

export interface GridOptions {
  describe(info: BlockInfo): { height: string; tag: string; pool: string; meta: string };
  open(info: BlockInfo): void;
}

interface Layout {
  width: number; // device pixels
  height: number;
  ratio: number;
  size: number;
  cols: number;
  offsetX: number;
  padding: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The largest square size at which every block fits. The size may be fractional; cells are snapped
 * to whole device pixels when drawn, so the grid fills its box instead of leaving a gap at the top.
 */
export function computeLayout(count: number, width: number, height: number): Pick<Layout, 'size' | 'cols' | 'offsetX'> {
  const cap = Math.max(1, width * MAX_CELL);
  let cols = Math.max(1, Math.floor(width / cap));
  if (count > 0) {
    cols = Math.max(cols, Math.ceil(Math.sqrt((count * width) / Math.max(1, height))));
    while (cols < width && cols * Math.floor(height / (width / cols)) < count) cols += 1;
  }
  const size = Math.min(cap, width / cols);
  return { size, cols, offsetX: 0 };
}

function cellCenter(layout: Layout, index: number) {
  return {
    x: layout.offsetX + ((index % layout.cols) + 0.5) * layout.size,
    y: layout.height - (Math.floor(index / layout.cols) + 0.5) * layout.size,
  };
}

export function createGrid(elements: GridElements, options: GridOptions) {
  const context = elements.canvas.getContext('2d');
  let source: GridSource = { count: 0, isSv2: () => false, info: () => ({ height: 0, time: 0, pool: '', reward: 0, sv2: false, id: '' }) };
  let layout: Layout | null = null;
  let markers: { index: number; x: number; y: number; jdp: boolean }[] = [];
  let selected = -1;
  let selectedBeforeTouch = -1;

  function draw() {
    if (!context) return;
    const cssWidth = elements.root.clientWidth;
    if (cssWidth <= 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const padding = Math.ceil((MARKER_RADIUS + 2) * ratio);
    const width = Math.max(1, Math.round(cssWidth * ratio) - 2 * padding);
    const heightForTargetCell = Math.ceil((source.count * (TARGET_CELL * ratio) ** 2) / width);
    const maxHeight = Math.max(1, Math.round(width * ASPECT), Math.min(Math.round(MAX_GRID_HEIGHT * ratio), heightForTargetCell));
    const cells = computeLayout(source.count, width, maxHeight);
    const rows = Math.ceil(source.count / cells.cols);
    const height = Math.max(1, Math.min(maxHeight, Math.round(rows * cells.size)));
    elements.canvas.width = width + 2 * padding;
    elements.canvas.height = height + 2 * padding;
    elements.canvas.style.height = `${elements.canvas.height / ratio}px`;
    const current = { width, height, ratio, padding, ...cells };
    layout = current;
    markers = [];

    const styles = getComputedStyle(document.documentElement);
    const dimColor = styles.getPropertyValue('--block-dim').trim() || 'rgba(128,128,128,0.2)';
    const accent = styles.getPropertyValue('--accent').trim() || '#00d4ff';
    const jdpColor = styles.getPropertyValue('--jdp').trim() || '#f59e0b';
    const background = styles.getPropertyValue('--bg').trim() || '#000000';
    const { size, cols, offsetX } = layout;
    const rounded = size >= ROUNDED_FROM && typeof context.roundRect === 'function';
    const gap = size >= ROUNDED_FROM ? Math.round(size * 0.14) : size >= 1.5 ? 1 : 0;
    const markSmallCells = size < 2 * MARKER_RADIUS * ratio;

    const trace = (index: number, inset: number) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const left = offsetX + Math.round(col * size);
      const right = offsetX + Math.round((col + 1) * size);
      const bottom = height - Math.round(row * size);
      const top = height - Math.round((row + 1) * size);
      const x = rounded ? left + inset / 2 : left;
      const y = rounded ? top + inset / 2 : top;
      const w = Math.max(1, right - left - inset);
      const h = Math.max(1, bottom - top - inset);
      if (rounded) context.roundRect(x, y, w, h, Math.min(w, h) * 0.22);
      else context.rect(x, y, w, h);
    };

    context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
    context.save();
    context.translate(padding, padding);
    context.beginPath();
    for (let index = 0; index < source.count; index++) if (!source.isSv2(index)) trace(index, gap);
    context.fillStyle = dimColor;
    context.fill();

    // Standard SV2 blocks (cyan).
    context.beginPath();
    for (let index = 0; index < source.count; index++) {
      if (!source.isSv2(index) || source.isJdp?.(index)) continue;
      trace(index, rounded ? gap : 0);
      if (markSmallCells) markers.push({ index, ...cellCenter(current, index), jdp: false });
    }
    context.fillStyle = accent;
    context.fill();

    // Job Declaration Protocol (JDP) blocks (amber).
    context.beginPath();
    for (let index = 0; index < source.count; index++) {
      if (!source.isSv2(index) || !source.isJdp?.(index)) continue;
      trace(index, rounded ? gap : 0);
      if (markSmallCells) markers.push({ index, ...cellCenter(current, index), jdp: true });
    }
    context.fillStyle = jdpColor;
    context.fill();

    // Outlines mark tiny SV2 / JDP cells and keep each cell at its original position and size.
    if (markers.length > 0) {
      const radius = MARKER_RADIUS * ratio;
      const drawRings = (subset: typeof markers, color: string) => {
        if (subset.length === 0) return;
        context.beginPath();
        for (const { x, y } of subset) {
          context.moveTo(x + radius, y);
          context.arc(x, y, radius, 0, 2 * Math.PI);
        }
        context.strokeStyle = background;
        context.lineWidth = 3 * ratio;
        context.stroke();
        context.strokeStyle = color;
        context.lineWidth = 1.25 * ratio;
        context.stroke();
      };
      drawRings(markers.filter((m) => !m.jdp), accent);
      drawRings(markers.filter((m) => m.jdp), jdpColor);
    }
    context.restore();

    select(selected < source.count ? selected : -1);
  }

  function indexAt(clientX: number, clientY: number): number {
    if (!layout) return -1;
    const rect = elements.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return -1;
    const x = ((clientX - rect.left) / rect.width) * elements.canvas.width - layout.padding;
    const y = ((clientY - rect.top) / rect.height) * elements.canvas.height - layout.padding;
    let nearest = -1;
    let distance = ((MARKER_RADIUS + 1) * layout.ratio) ** 2;
    for (const marker of markers) {
      const squared = (marker.x - x) ** 2 + (marker.y - y) ** 2;
      if (squared < distance) {
        nearest = marker.index;
        distance = squared;
      }
    }
    if (nearest >= 0) return nearest;
    if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return -1;
    const col = Math.floor((x - layout.offsetX) / layout.size);
    const row = Math.floor((layout.height - y) / layout.size);
    if (col < 0 || col >= layout.cols || row < 0) return -1;
    const index = row * layout.cols + col;
    return index < source.count ? index : -1;
  }

  function select(index: number) {
    selected = index;
    if (!layout || index < 0 || index >= source.count) {
      selected = -1;
      elements.outline.hidden = true;
      elements.tip.hidden = true;
      return;
    }
    const { size, ratio, padding } = layout;
    const { x, y } = cellCenter(layout, index);
    const cell = size / ratio;
    const centerX = (padding + x) / ratio;
    const centerY = (padding + y) / ratio;
    const box = Math.max(cell, 2 * (MARKER_RADIUS + 2));
    elements.outline.style.left = `${centerX - box / 2}px`;
    elements.outline.style.top = `${centerY - box / 2}px`;
    elements.outline.style.width = `${box}px`;
    elements.outline.style.height = `${box}px`;
    elements.outline.hidden = false;

    const info = source.info(index);
    const words = options.describe(info);
    elements.tipHeight.textContent = words.height;
    elements.tipTag.textContent = words.tag;
    elements.tipTag.classList.toggle('sv2', info.sv2 && !info.jdp);
    elements.tipTag.classList.toggle('jdp', Boolean(info.jdp));
    elements.tipPool.textContent = words.pool;
    elements.tipMeta.textContent = words.meta;
    elements.tip.hidden = false;
    const cssWidth = elements.canvas.width / ratio;
    const cssHeight = elements.canvas.height / ratio;
    const tipWidth = elements.tip.offsetWidth;
    elements.tip.style.left = `${clamp(centerX - tipWidth / 2, 0, Math.max(0, cssWidth - tipWidth))}px`;
    elements.tip.style.bottom = `${cssHeight - centerY + box / 2 + 8}px`;
  }

  function open(index: number) {
    if (index >= 0 && index < source.count) options.open(source.info(index));
  }

  elements.root.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const index = indexAt(event.clientX, event.clientY);
    if (index !== selected) select(index);
  });
  elements.root.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    selectedBeforeTouch = selected;
    select(indexAt(event.clientX, event.clientY));
  });
  elements.root.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch' && document.activeElement !== elements.root) select(-1);
  });
  elements.root.addEventListener('click', (event) => {
    const index = indexAt(event.clientX, event.clientY);
    if (index < 0) return;
    // On a touch screen the first tap shows the card and a second tap on the same square opens it.
    const touch = (event as PointerEvent).pointerType === 'touch';
    if (touch && index !== selectedBeforeTouch) return;
    open(index);
  });
  elements.root.addEventListener('focus', () => {
    if (selected < 0 && source.count > 0 && elements.root.matches(':focus-visible')) select(source.count - 1);
  });
  elements.root.addEventListener('blur', () => select(-1));
  elements.root.addEventListener('keydown', (event) => {
    if (!layout || source.count === 0) return;
    const current = selected < 0 ? source.count - 1 : selected;
    const moves: Record<string, number> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      ArrowUp: current + layout.cols,
      ArrowDown: current - layout.cols,
      Home: 0,
      End: source.count - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      select(clamp(moves[event.key] ?? current, 0, source.count - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(current);
    } else if (event.key === 'Escape') {
      select(-1);
    }
  });

  new ResizeObserver(() => draw()).observe(elements.root);

  return {
    setSource(next: GridSource, label: string) {
      source = next;
      selected = -1;
      elements.canvas.setAttribute('aria-label', label);
      draw();
    },
    redraw: draw,
    /** Re-reads the selected block, for when its details have just loaded. */
    refreshSelection() {
      if (selected >= 0) select(selected);
    },
  };
}
