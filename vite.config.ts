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
    async transformIndexHtml(source) {
      const page = source
        .replace('<html lang="en">', `<html lang="en" data-default-theme="${escapeHtml(config.site.defaultTheme)}">`)
        .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(config.site.title)}</title>`)
        .replace('content="__DESCRIPTION__"', `content="${escapeHtml(config.site.description)}"`);
      const tags: HtmlTagDescriptor[] = [];
      // The current summary travels inside the page, so the first paint does not wait for a second request.
      // It is inert data (not a script the browser runs); the page still re-checks summary.json afterwards.
      const summary = embeddableJson(await readFile('public/data/summary.json', 'utf8').catch(() => undefined));
      if (summary) tags.push({ tag: 'script', attrs: { type: 'application/json', id: 'summary-data' }, children: summary, injectTo: 'body' });
      // The dev server injects styles inline, so the policy is only added to real builds.
      if (command === 'build') tags.push({ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' });
      return { html: page, tags };
    },
  };

  return {
    base: './', // relative URLs, so the build works at a domain root and under /<repo>/ on GitHub Pages
    define: { __SV2_CONFIG__: JSON.stringify(clientConfig(config)) },
    plugins: [html],
    build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' },
  };
});
