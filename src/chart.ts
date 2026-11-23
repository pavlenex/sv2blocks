// The growth chart: cumulative Stratum V2 blocks over time, drawn as one SVG path.
import { fmtInt } from './format';

const WIDTH = 1000;
const HEIGHT = 300;
const TOP = 14;
const BOTTOM = 292;
const STEP_LIMIT = 40; // few blocks: draw honest steps; many: a line through them reads better

export interface ChartModel {
  /** Timestamps of the SV2 blocks inside the range, oldest first. */
  times: number[];
  /** SV2 blocks mined before the range starts. */
  before: number;
  tStart: number;
  tEnd: number;
  label: (unixSeconds: number) => string;
}

export interface ChartElements {
  root: HTMLElement;
  svg: SVGElement;
  guides: SVGPathElement;
  line: SVGPathElement;
  area: SVGPathElement;
  dot: HTMLElement;
  cursor: HTMLElement;
  cursorDot: HTMLElement;
  readout: HTMLElement;
  scale: HTMLElement;
  ticks: HTMLElement;
}

const round = (value: number) => String(Math.round(value * 10) / 10);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Number of entries in a sorted list that are <= value. */
function countUpTo(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? Infinity) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createChart(elements: ChartElements) {
  let model: ChartModel | null = null;

  const span = (m: ChartModel) => Math.max(1, m.tEnd - m.tStart);
  const xOf = (m: ChartModel, time: number) => clamp((time - m.tStart) / span(m), 0, 1) * WIDTH;
  const yOf = (m: ChartModel, count: number) =>
    m.times.length === 0 ? HEIGHT / 2 : BOTTOM - ((count - m.before) / m.times.length) * (BOTTOM - TOP);

  function hideCursor() {
    elements.cursor.hidden = true;
    elements.cursorDot.hidden = true;
    elements.readout.hidden = true;
  }

  function showCursor(clientX: number) {
    if (!model) return;
    const rect = elements.root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    const time = model.tStart + fraction * span(model);
    const count = model.before + countUpTo(model.times, time);
    const left = `${fraction * 100}%`;
    elements.cursor.style.left = left;
    elements.cursorDot.style.left = left;
    elements.cursorDot.style.top = `${(yOf(model, count) / HEIGHT) * 100}%`;
    elements.readout.textContent = `${fmtInt(count)} · ${model.label(time)}`;
    elements.readout.hidden = false;
    const half = elements.readout.offsetWidth / 2;
    elements.readout.style.left = `${clamp(fraction * rect.width, half, Math.max(half, rect.width - half))}px`;
    elements.cursor.hidden = false;
    elements.cursorDot.hidden = false;
  }

  elements.root.addEventListener('pointermove', (event) => showCursor(event.clientX));
  elements.root.addEventListener('pointerdown', (event) => showCursor(event.clientX));
  elements.root.addEventListener('pointerleave', hideCursor);
  elements.root.addEventListener('pointercancel', hideCursor);

  return {
    render(next: ChartModel, tickLabels: string[]) {
      model = next;
      hideCursor();
      const stepped = next.times.length <= STEP_LIMIT;
      let path = `M0 ${round(yOf(next, next.before))}`;
      next.times.forEach((time, index) => {
        const x = round(xOf(next, time));
        const y = round(yOf(next, next.before + index + 1));
        path += stepped ? `H${x}V${y}` : `L${x} ${y}`;
      });
      path += `H${WIDTH}`;
      elements.line.setAttribute('d', path);
      elements.area.setAttribute('d', `${path}V${HEIGHT}H0Z`);
      const total = next.before + next.times.length;
      elements.dot.style.top = `${(yOf(next, total) / HEIGHT) * 100}%`;
      elements.svg.setAttribute('aria-label', `Cumulative Stratum V2 blocks: ${fmtInt(next.before)} at the start of the range, ${fmtInt(total)} at the last update`);

      const levels = [...new Set([next.before, next.before + Math.floor(next.times.length / 2), total])];
      elements.guides.setAttribute('d', levels.map((count) => `M0 ${round(yOf(next, count))}H${WIDTH}`).join(' '));
      elements.scale.replaceChildren(...levels.map((count) => {
        const tick = document.createElement('span');
        tick.textContent = fmtInt(count);
        tick.style.top = `${(yOf(next, count) / HEIGHT) * 100}%`;
        return tick;
      }));
      elements.ticks.replaceChildren(
        ...tickLabels.map((label) => {
          const tick = document.createElement('span');
          tick.textContent = label;
          return tick;
        }),
      );
    },
  };
}
