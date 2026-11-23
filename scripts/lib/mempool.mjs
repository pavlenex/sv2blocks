// Minimal client for the mempool REST API (https://mempool.space/docs/api/rest).
// Works with any instance: the base URL comes from sv2blocks.config.json.

export const PAGE_SIZE = 15; // GET /v1/blocks/:height returns that block and the 14 before it

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
  }
}

/** The server answered, but not with JSON (for example a parking or error page). Not worth retrying. */
export class NotJsonError extends Error {
  constructor(url) {
    super(`Response from ${url} is not JSON`);
  }
}

/** GET with a timeout, and retries with backoff on rate limits, server errors and network failures. */
export async function fetchWithRetry(url, { timeoutMs = 20000, retries = 6, as = 'json', log = () => {}, userAgent = 'sv2blocks-data-job', onRateLimit = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let waitMs = Math.min(60000, 1000 * 2 ** attempt);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': userAgent },
      });
      if (response.ok) {
        const body = await response.text();
        if (as === 'text') return body;
        try {
          return JSON.parse(body);
        } catch {
          throw new NotJsonError(url);
        }
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (response.status === 429) onRateLimit();
      if (!retryable) throw new HttpError(response.status, url);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(120000, retryAfter * 1000);
      if (attempt >= retries) throw new HttpError(response.status, url);
      log(`HTTP ${response.status}, retrying in ${Math.round(waitMs / 1000)}s: ${url}`);
    } catch (error) {
      if (error instanceof HttpError || error instanceof NotJsonError) throw error;
      if (attempt >= retries) throw new Error(`Request failed after ${retries + 1} attempts: ${url} (${error.message})`);
      log(`${error.name || 'Error'}, retrying in ${Math.round(waitMs / 1000)}s: ${url}`);
    }
    await sleep(waitMs);
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Pool names come from a third party: keep printable characters only and cap the length.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);
}

/** Picks the few fields the site uses out of a mempool block object, rejecting anything malformed. */
export function parseBlock(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('block is not an object');
  const { height, id, timestamp, extras } = raw;
  if (!Number.isInteger(height) || height < 0) throw new Error('block has no valid height');
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error(`block ${height} has no valid hash`);
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error(`block ${height} has no valid timestamp`);
  if (extras === null || typeof extras !== 'object') throw new Error(`block ${height} has no "extras" (is this a mempool instance with mining data enabled?)`);
  const reward = Number(extras.reward);
  if (!Number.isSafeInteger(reward) || reward < 0) throw new Error(`block ${height} has no valid reward`);
  const pool = extras.pool && typeof extras.pool === 'object' ? extras.pool : {};
  const slug = cleanText(pool.slug, 48).toLowerCase();
  const coinbaseRaw = typeof extras.coinbaseRaw === 'string' && /^[0-9a-f]*$/i.test(extras.coinbaseRaw) ? extras.coinbaseRaw.slice(0, 400) : '';
  return {
    height,
    id,
    timestamp,
    reward,
    poolSlug: /^[a-z0-9_-]+$/.test(slug) ? slug : 'unknown',
    poolName: cleanText(pool.name, 48) || 'Unknown',
    coinbaseRaw,
  };
}

export function createClient({ apiBase, timeoutMs, log, userAgent, onRateLimit }) {
  const options = { timeoutMs, log, userAgent, onRateLimit };
  return {
    async tipHeight() {
      const text = await fetchWithRetry(`${apiBase}/blocks/tip/height`, { ...options, as: 'text' });
      const height = Number(text.trim());
      if (!Number.isInteger(height) || height < 0) throw new Error(`Unexpected tip height from ${apiBase}: ${text.slice(0, 40)}`);
      return height;
    },
    /** Blocks top, top-1, ... (up to 15), as a Map keyed by height. */
    async blocksEndingAt(top) {
      const list = await fetchWithRetry(`${apiBase}/v1/blocks/${top}`, options);
      if (!Array.isArray(list)) throw new Error(`Unexpected response for blocks ending at ${top}`);
      const byHeight = new Map();
      for (const raw of list) {
        const block = parseBlock(raw);
        byHeight.set(block.height, block);
      }
      return byHeight;
    },
    json(url) {
      return fetchWithRetry(url, options);
    },
  };
}
