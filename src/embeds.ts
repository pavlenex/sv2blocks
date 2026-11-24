// The snippets page: live previews of the embeddable widgets and the code to paste.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';
import './embed.css';

const WIDGETS = [
  { id: 'blocks', title: 'Stratum V2 blocks', height: 420 },
  { id: 'leaderboard', title: 'Stratum V2 leaderboard', height: 320 },
] as const;
const chosen = { theme: 'dark', range: 'all' };

function $<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as unknown as T;
}

/** The widget's address on whichever site this page is served from. */
function widgetUrl(widget: string): URL {
  const url = new URL('embed.html', window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('widget', widget);
  url.searchParams.set('theme', chosen.theme);
  if (chosen.range !== 'all') url.searchParams.set('range', chosen.range);
  return url;
}

function render() {
  for (const widget of WIDGETS) {
    const url = widgetUrl(widget.id);
    const frame = $<HTMLIFrameElement>(`preview-${widget.id}`);
    if (frame.src !== url.href) frame.src = url.href;
    $(`code-${widget.id}`).textContent =
      `<iframe src="${url.href.replaceAll('&', '&amp;')}" title="${widget.title}" width="100%" height="${widget.height}" loading="lazy" style="border:0;border-radius:24px;display:block"></iframe>`;
  }
  const origin = window.location.origin;
  $('code-fit').textContent = [
    '<script>',
    "  addEventListener('message', function (event) {",
    `    if (event.origin !== '${origin}' || !event.data || event.data.type !== 'sv2blocks:height') return;`,
    "    document.querySelectorAll('iframe').forEach(function (frame) {",
    "      if (frame.contentWindow === event.source) frame.style.height = event.data.height + 'px';",
    '    });',
    '  });',
    '</' + 'script>',
  ].join('\n');
}

function wire(groupId: string, key: keyof typeof chosen) {
  const group = $(groupId);
  group.addEventListener('click', (event) => {
    const value = (event.target as HTMLElement).closest('button')?.dataset.value;
    if (!value) return;
    chosen[key] = value;
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
    render();
  });
}

wire('opt-theme', 'theme');
wire('opt-range', 'range');

for (const button of document.querySelectorAll<HTMLButtonElement>('.embed-copy')) {
  button.addEventListener('click', async () => {
    const text = $(button.dataset.copy ?? '').textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // No clipboard access (an old browser, or a page not served over https): select the code instead.
      window.getSelection()?.selectAllChildren($(button.dataset.copy ?? ''));
      button.textContent = 'Selected';
    }
    window.setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
}

// The leaderboard preview is kept an exact fit, the same way the snippet above does it for other sites.
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'sv2blocks:height') return;
  const height = Number(event.data.height);
  const frame = $<HTMLIFrameElement>('preview-leaderboard');
  if (event.source === frame.contentWindow && Number.isFinite(height) && height > 0 && height < 4000) frame.style.height = `${Math.ceil(height)}px`;
});

render();
