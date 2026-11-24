import { readFile } from 'node:fs/promises';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import { clientConfig, loadConfig } from './scripts/lib/config.mjs';
import { embeddableJson } from './scripts/lib/embed.mjs';

// The browser may only load what this site itself serves: no third-party scripts, styles, fonts or requests.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // The site never turns text into HTML or script. This makes the browser refuse if any code ever tries.
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

export default defineConfig(async ({ command }) => {
  const config = await loadConfig();

  const html: Plugin = {
    name: 'sv2blocks-html',
    async transformIndexHtml(source, context) {
      const name = context.path.split('/').pop() || 'index.html';
      const title = name === 'embeds.html' ? `Embed widgets · ${config.site.title}` : config.site.title;
      const page = source
        .replace('<html lang="en">', `<html lang="en" data-default-theme="${escapeHtml(config.site.defaultTheme)}">`)
        .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace('content="__DESCRIPTION__"', `content="${escapeHtml(config.site.description)}"`);
      const tags: HtmlTagDescriptor[] = [];
      // What Discord, X, Telegram and others show when the dashboard's address is shared. They need
      // full addresses, so this is added only when "site.url" is set. The image is public/og.png.
      if (name === 'index.html' && config.site.url) {
        const image = new URL('og.png', config.site.url).href;
        const property = (key: string, content: string): HtmlTagDescriptor => ({ tag: 'meta', attrs: { property: key, content }, injectTo: 'head' });
        const named = (key: string, content: string): HtmlTagDescriptor => ({ tag: 'meta', attrs: { name: key, content }, injectTo: 'head' });
        tags.push(
          { tag: 'link', attrs: { rel: 'canonical', href: config.site.url }, injectTo: 'head' },
          property('og:type', 'website'),
          property('og:site_name', config.site.title),
          property('og:title', config.site.title),
          property('og:description', config.site.description),
          property('og:url', config.site.url),
          property('og:image', image),
          property('og:image:type', 'image/png'),
          property('og:image:width', '1200'),
          property('og:image:height', '630'),
          property('og:image:alt', `${config.site.title}: ${config.site.description}`),
          named('twitter:card', 'summary_large_image'),
          named('twitter:title', config.site.title),
          named('twitter:description', config.site.description),
          named('twitter:image', image),
        );
      }
      // The current summary travels inside the page, so the first paint does not wait for a second request.
      // It is inert data (not a script the browser runs); the page still re-checks summary.json afterwards.
      const summary = name === 'embeds.html' ? null : embeddableJson(await readFile('public/data/summary.json', 'utf8').catch(() => undefined));
      if (summary) tags.push({ tag: 'script', attrs: { type: 'application/json', id: 'summary-data' }, children: summary, injectTo: 'body' });
      // The dev server injects styles inline, so the policy is only added to real builds.
      // Only the snippets page shows frames, and only this site's own widgets.
      const policy = name === 'embeds.html' ? `${CSP}; frame-src 'self'` : CSP;
      if (command === 'build') tags.push({ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' });
      return { html: page, tags };
    },
  };

  return {
    base: './', // relative URLs, so the build works at a domain root and under /<repo>/ on GitHub Pages
    define: { __SV2_CONFIG__: JSON.stringify(clientConfig(config)) },
    plugins: [html],
    build: {
      target: 'es2022',
      sourcemap: false,
      assetsInlineLimit: 0,
      // index.html is the dashboard, embed.html a single widget for other sites to frame, embeds.html the snippets page.
      rollupOptions: { input: ['index.html', 'embed.html', 'embeds.html'] },
    },
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' },
  };
});
