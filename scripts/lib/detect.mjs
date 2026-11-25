// Decides whether a block counts as Stratum V2, and whether it uses Job Declaration Protocol (JDP).
//
// A block is SV2 when its height is in overrides.include, or its coinbase text matches one of the
// configured patterns (or the Sv2/pool_tag/miner_tag/ JDP convention), or (optionally) its pool is
// in detection.poolSlugs. overrides.exclude always wins.
import { createHash } from 'node:crypto';

// Shortest readable run that is kept. Three, so a bare "sv2" between binary bytes still counts;
// the price is that random bytes spell it by chance now and then (use overrides.exclude for those).
const MIN_RUN = 3;
// Bump when the matching logic itself changes, so every stored block is checked again.
const RULE_VERSION = 2;

// Stratum V2 coinbase tag convention (stratum-mining/stratum#2141):
//   Sv2/<pool_tag>/<miner_tag>/   (non-empty miner_tag indicates Job Declaration Protocol)
// Bare "v2/<pool_tag>/<miner_tag>/" requires the trailing slash to avoid random binary false hits.
const JDP_SV2_RE = /(?:^|\/)(?:stratum ?v2|sv2)\/([^/\s][^/]{0,31})\/([^/\s][^/]{0,31})(?:\/|$)/i;
const JDP_V2_RE = /(?:^|\/)v2\/([^/\s][^/]{0,31})\/([^/\s][^/]{0,31})\//i;

/**
 * The readable text inside a coinbase scriptSig. Bytes outside printable ASCII split the text into
 * runs; runs shorter than three characters are dropped so random binary data rarely looks like a tag.
 */
export function coinbaseText(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return '';
  const runs = [];
  let run = '';
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte >= 0x20 && byte <= 0x7e) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= MIN_RUN) runs.push(run);
      run = '';
    }
  }
  if (run.length >= MIN_RUN) runs.push(run);
  return runs.join(' ').trim().slice(0, 200);
}

/**
 * Decodes valid printable UTF-8 runs from a coinbase hex string (preserving non-ASCII pool tags
 * such as emoji in "Sv2/MARA🇺🇸🇺🇸//") while splitting on control bytes or invalid UTF-8 bytes.
 */
export function coinbaseUtf8Runs(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return [];
  const bytes = Buffer.from(hex, 'hex');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const text = decoder.decode(bytes);
  const runs = [];
  let current = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && ch !== '\uFFFD' && !(code >= 0x80 && code <= 0x9f)) {
      current += ch;
    } else {
      if (current.length >= MIN_RUN) runs.push(current);
      current = '';
    }
  }
  if (current.length >= MIN_RUN) runs.push(current);
  return runs;
}

/**
 * Parses a Stratum V2 Job Declaration coinbase tag (`Sv2/<pool_tag>/<miner_tag>/` or `v2/<pool_tag>/<miner_tag>/`).
 * Returns `{ poolTag, minerTag, matched }` when a non-empty miner tag is present, else `null`.
 */
export function parseJdpTag(hex) {
  for (const run of coinbaseUtf8Runs(hex)) {
    const match = JDP_SV2_RE.exec(run) ?? JDP_V2_RE.exec(run);
    if (!match) continue;
    const poolTag = match[1].trim();
    const minerTag = match[2].trim();
    if (!poolTag || !minerTag) continue;
    return { poolTag: poolTag.slice(0, 32), minerTag: minerTag.slice(0, 32), matched: match[0].slice(0, 80) };
  }
  return null;
}

export function compilePatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, 'i'));
}

/** Changes when the automatic rule changes, which forces a full rescan of stored blocks. */
export function detectionFingerprint(detection) {
  const basis = JSON.stringify({ rule: RULE_VERSION, patterns: detection.coinbasePatterns, pools: detection.poolSlugs });
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** The automatic part of the rule (tag or pool). Overrides are applied later, see store.mjs. */
export function autoDetect({ coinbaseRaw, poolSlug }, regexes, poolSlugs) {
  const text = coinbaseText(coinbaseRaw);
  const utf8 = coinbaseUtf8Runs(coinbaseRaw).join(' ').trim();
  const displayTag = (utf8 || text).slice(0, 80);
  const jdp = parseJdpTag(coinbaseRaw);
  if (jdp) return { reason: 'tag', tag: (displayTag || jdp.matched).slice(0, 80), jdp: true, miner: jdp.minerTag };
  if (text && regexes.some((regex) => regex.test(text))) return { reason: 'tag', tag: displayTag, jdp: false, miner: '' };
  if (poolSlug && poolSlugs.includes(poolSlug)) return { reason: 'pool', tag: displayTag, jdp: false, miner: '' };
  return null;
}
