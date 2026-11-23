// Today's BTC price in USD, from whichever source sv2blocks.config.json selects.
// A source is either { "url", "path" } (a JSON endpoint and the dotted path to the number) or { "value" }.

// A fetched price more than twice, or less than half, the previous one is treated as a glitch and
// rejected, unless the previous price is more than a day old (then a real move that large is possible).
const MAX_STEP = 2;
const STEP_WINDOW_SEC = 24 * 3600;

export async function fetchPrice(config, getJson, now = Math.floor(Date.now() / 1000), previous = null) {
  const name = config.price.source;
  const source = config.price.sources[name];
  if ('value' in source) return { usd: Number(source.value), time: now, source: name };

  const url = source.url.replace('{mempoolApi}', config.mempool.apiBase);
  const json = await getJson(url);
  let value = json;
  for (const key of source.path.split('.')) {
    value = value === null || value === undefined ? undefined : value[key];
  }
  // Only a number, or a string holding one: Number(true) and Number([5]) would otherwise pass as prices.
  const usd = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`Price source "${name}": no positive number at "${source.path}" in the response from ${url}`);
  }
  if (previous && previous.usd > 0 && now - previous.time < STEP_WINDOW_SEC) {
    const ratio = usd / previous.usd;
    if (ratio > MAX_STEP || ratio < 1 / MAX_STEP) {
      throw new Error(`Price source "${name}" returned $${usd}, too far from the last price $${previous.usd} to trust`);
    }
  }
  return { usd: Math.round(usd * 100) / 100, time: now, source: name };
}
