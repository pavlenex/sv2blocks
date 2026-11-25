// Loads and validates sv2blocks.config.json. Used by the data job and by the site build.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RANGES = ['24H', '1W', '1M', 'ALL'];

function fail(message) {
  throw new Error(`sv2blocks.config.json: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only https, or http to this machine (for a local mempool instance or tests). */
export function assertSafeUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a valid URL: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.local');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    fail(`${label} must use https (http is allowed only for localhost and .local hosts): ${value}`);
  }
  if (url.username || url.password) fail(`${label} must not contain credentials`);
  return url;
}

export function validateConfig(raw) {
  if (!isObject(raw)) fail('must be a JSON object');
  const { site, mempool, price, detection, leaderboard, links } = raw;

  if (!isObject(site)) fail('"site" is missing');
  if (typeof site.title !== 'string' || !site.title.trim()) fail('"site.title" must be text');
  if (!['dark', 'light', 'system'].includes(site.defaultTheme)) fail('"site.defaultTheme" must be dark, light or system');
  if (!RANGES.includes(site.defaultRange)) fail(`"site.defaultRange" must be one of ${RANGES.join(', ')}`);
  // Optional: the public address of the site. Link previews (Discord, X, Telegram) need full addresses.
  let siteUrl = '';
  if (site.url !== undefined && site.url !== '') {
    if (typeof site.url !== 'string') fail('"site.url" must be text');
    const url = assertSafeUrl(site.url, '"site.url"');
    if (url.search || url.hash) fail('"site.url" must not contain ? or #');
    siteUrl = url.href.endsWith('/') ? url.href : `${url.href}/`;
  }

  if (!isObject(mempool)) fail('"mempool" is missing');
  const apiBase = String(mempool.apiBase ?? '').replace(/\/+$/, '');
  assertSafeUrl(apiBase, '"mempool.apiBase"');
  for (const key of ['blockUrlByHash', 'blockUrlByHeight']) {
    if (typeof mempool[key] !== 'string') fail(`"mempool.${key}" must be text`);
    assertSafeUrl(mempool[key].replace('{hash}', 'x').replace('{height}', '1'), `"mempool.${key}"`);
  }
  if (!mempool.blockUrlByHash.includes('{hash}')) fail('"mempool.blockUrlByHash" must contain {hash}');
  if (!mempool.blockUrlByHeight.includes('{height}')) fail('"mempool.blockUrlByHeight" must contain {height}');
  const requestDelayMs = Number(mempool.requestDelayMs ?? 250);
  const timeoutMs = Number(mempool.timeoutMs ?? 20000);
  if (!(requestDelayMs >= 0 && requestDelayMs <= 60000)) fail('"mempool.requestDelayMs" must be 0 to 60000');
  if (!(timeoutMs >= 1000 && timeoutMs <= 120000)) fail('"mempool.timeoutMs" must be 1000 to 120000');

  if (!isObject(price) || !isObject(price.sources)) fail('"price.sources" is missing');
  if (typeof price.source !== 'string' || !isObject(price.sources[price.source])) {
    fail(`"price.source" must name one of: ${Object.keys(price.sources).join(', ')}`);
  }
  for (const [name, source] of Object.entries(price.sources)) {
    if (!isObject(source)) fail(`"price.sources.${name}" must be an object`);
    if ('value' in source) {
      if (!(Number(source.value) > 0)) fail(`"price.sources.${name}.value" must be a positive number`);
    } else {
      if (typeof source.url !== 'string' || typeof source.path !== 'string') {
        fail(`"price.sources.${name}" needs "url" and "path", or a fixed "value"`);
      }
      assertSafeUrl(source.url.replace('{mempoolApi}', apiBase), `"price.sources.${name}.url"`);
    }
  }

  if (!isObject(detection)) fail('"detection" is missing');
  if (!Number.isInteger(detection.startHeight) || detection.startHeight < 0) fail('"detection.startHeight" must be a block height');
  if (!Array.isArray(detection.coinbasePatterns)) fail('"detection.coinbasePatterns" must be a list');
  for (const pattern of detection.coinbasePatterns) {
    if (typeof pattern !== 'string' || !pattern) fail('"detection.coinbasePatterns" entries must be text');
    try {
      new RegExp(pattern, 'i');
    } catch {
      fail(`"detection.coinbasePatterns" has an invalid pattern: ${pattern}`);
    }
  }
  const poolSlugs = detection.poolSlugs ?? [];
  if (!Array.isArray(poolSlugs) || poolSlugs.some((slug) => typeof slug !== 'string')) fail('"detection.poolSlugs" must be a list of text');
  if (typeof detection.overridesFile !== 'string') fail('"detection.overridesFile" must be a path');

  const size = Number(leaderboard?.size ?? 5);
  if (!Number.isInteger(size) || size < 1 || size > 50) fail('"leaderboard.size" must be 1 to 50');

  if (!Array.isArray(links)) fail('"links" must be a list');
  for (const link of links) {
    if (!isObject(link) || typeof link.label !== 'string' || typeof link.href !== 'string' || typeof link.icon !== 'string') {
      fail('each link needs "label", "href" and "icon"');
    }
    assertSafeUrl(link.href, `link "${link.label}"`);
    if (!/^[A-Za-z0-9_\-/.]+\.svg$/.test(link.icon) || link.icon.includes('..') || link.icon.startsWith('/')) {
      fail(`link "${link.label}": "icon" must be a relative path to an .svg file in public/`);
    }
  }

  return {
    site: {
      title: site.title.trim(),
      description: String(site.description ?? ''),
      url: siteUrl,
      defaultTheme: site.defaultTheme,
      defaultRange: site.defaultRange,
    },
    mempool: {
      apiBase,
      blockUrlByHash: mempool.blockUrlByHash,
      blockUrlByHeight: mempool.blockUrlByHeight,
      requestDelayMs,
      timeoutMs,
    },
    price: { source: price.source, sources: price.sources },
    detection: {
      startHeight: detection.startHeight,
      coinbasePatterns: [...detection.coinbasePatterns],
      poolSlugs: poolSlugs.map((slug) => slug.toLowerCase()),
      overridesFile: detection.overridesFile,
    },
    leaderboard: { size },
    links: links.map((link) => ({ label: link.label, href: link.href, icon: link.icon })),
  };
}

/** Environment variables win over the file, so a workflow can switch instance or price source without a commit. */
export function applyEnv(raw, env = process.env) {
  const next = structuredClone(raw);
  if (env.SV2_MEMPOOL_API) next.mempool = { ...next.mempool, apiBase: env.SV2_MEMPOOL_API };
  if (env.SV2_PRICE_SOURCE) next.price = { ...next.price, source: env.SV2_PRICE_SOURCE };
  if (env.SV2_REQUEST_DELAY_MS !== undefined && env.SV2_REQUEST_DELAY_MS !== '') {
    next.mempool = { ...next.mempool, requestDelayMs: Number(env.SV2_REQUEST_DELAY_MS) };
  }
  return next;
}

export async function loadConfig({ file = path.join(ROOT, 'sv2blocks.config.json'), env = process.env } = {}) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`could not be read (${error.message})`);
  }
  return validateConfig(applyEnv(raw, env));
}

/** The part of the config the browser needs. Nothing else is shipped to visitors. */
export function clientConfig(config) {
  return {
    title: config.site.title,
    defaultRange: config.site.defaultRange,
    startHeight: config.detection.startHeight,
    blockUrlByHash: config.mempool.blockUrlByHash,
    blockUrlByHeight: config.mempool.blockUrlByHeight,
    leaderboardSize: config.leaderboard.size,
    links: config.links,
  };
}

export async function loadOverrides(config) {
  const file = path.resolve(ROOT, config.detection.overridesFile);
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { include: [], exclude: [], jdp: {} };
    throw new Error(`${config.detection.overridesFile}: could not be read (${error.message})`);
  }
  const clean = (list, label) => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((h) => !Number.isInteger(h) || h < 0)) {
      throw new Error(`${config.detection.overridesFile}: "${label}" must be a list of block heights`);
    }
    return [...new Set(list)].sort((a, b) => a - b);
  };
  const jdp = {};
  if (raw.jdp !== undefined) {
    if (Array.isArray(raw.jdp)) {
      for (const h of raw.jdp) {
        if (!Number.isInteger(h) || h < 0) throw new Error(`${config.detection.overridesFile}: "jdp" heights must be non-negative integers`);
        jdp[h] = '';
      }
    } else if (isObject(raw.jdp)) {
      for (const [key, value] of Object.entries(raw.jdp)) {
        const h = Number(key);
        if (!Number.isInteger(h) || h < 0 || String(h) !== key) {
          throw new Error(`${config.detection.overridesFile}: "jdp" key "${key}" must be a block height`);
        }
        if (typeof value !== 'string') {
          throw new Error(`${config.detection.overridesFile}: "jdp.${key}" must be a miner tag string`);
        }
        jdp[h] = value.trim().slice(0, 32);
      }
    } else {
      throw new Error(`${config.detection.overridesFile}: "jdp" must be an object or list of block heights`);
    }
  }
  return { include: clean(raw.include, 'include'), exclude: clean(raw.exclude, 'exclude'), jdp };
}
