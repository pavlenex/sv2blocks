// Decides whether a block counts as Stratum V2.
//
// A block is SV2 when its height is in overrides.include, or its coinbase text matches one of the
// configured patterns, or (optionally) its pool is in detection.poolSlugs. overrides.exclude always wins.
import { createHash } from 'node:crypto';

// Shortest readable run that is kept. Three, so a bare "sv2" between binary bytes still counts;
// the price is that random bytes spell it by chance now and then (use overrides.exclude for those).
const MIN_RUN = 3;
// Bump when the matching logic itself changes, so every stored block is checked again.
const RULE_VERSION = 2;

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
  if (text && regexes.some((regex) => regex.test(text))) return { reason: 'tag', tag: text.slice(0, 80) };
  if (poolSlug && poolSlugs.includes(poolSlug)) return { reason: 'pool', tag: text.slice(0, 80) };
  return null;
}
