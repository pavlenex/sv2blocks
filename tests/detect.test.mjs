import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoDetect, coinbaseText, compilePatterns, detectionFingerprint } from '../scripts/lib/detect.mjs';

const hex = (text) => Buffer.from(text, 'latin1').toString('hex');
const regexes = compilePatterns(['sv2', 'stratum ?v2']);

test('reads the text out of the real coinbase of block 955,318', () => {
  const raw = '03b6930e002f444d4e442f474d2f00415fbf8800000000000000000008b744447844440000000005351000000000';
  assert.equal(coinbaseText(raw), '/DMND/GM/ DDxDD');
  // No SV2 tag in it: this block only counts through data/overrides.json.
  assert.equal(autoDetect({ coinbaseRaw: raw, poolSlug: 'dmnd' }, regexes, []), null);
});

test('matches the tags in any case and spelling', () => {
  for (const tag of ['/Stratum V2/', '/stratumv2/', 'Mined by SV2 pool', '/sv2/abc', 'STRATUM V2 rocks', 'Sv2/MARA']) {
    const found = autoDetect({ coinbaseRaw: `03b6930e${hex(tag)}00ff`, poolSlug: 'x' }, regexes, []);
    assert.equal(found?.reason, 'tag', tag);
    assert.ok(found.tag.includes(tag));
  }
});

test('matches a bare three-letter tag with nothing readable beside it', () => {
  for (const raw of ['03b6930e00ff7376320001', `03b6930e00${hex('SV2')}0a`]) {
    assert.equal(autoDetect({ coinbaseRaw: raw, poolSlug: 'x' }, regexes, [])?.reason, 'tag', raw);
  }
});

test('does not match ordinary tags or binary noise', () => {
  for (const raw of [`03b6930e${hex('/Foundry USA Pool #dropgold/')}`, '03b6930e00ff73760001', 'zz', '', `${hex('sv')}00${hex('2abc')}`]) {
    assert.equal(autoDetect({ coinbaseRaw: raw, poolSlug: 'x' }, regexes, []), null, raw);
  }
});

test('the optional pool list matches by slug', () => {
  const block = { coinbaseRaw: `03b6930e${hex('/DMND/GM/')}`, poolSlug: 'dmnd' };
  assert.equal(autoDetect(block, regexes, ['dmnd'])?.reason, 'pool');
  assert.equal(autoDetect(block, regexes, ['other']), null);
});

test('the fingerprint follows the automatic rule only', () => {
  const base = { coinbasePatterns: ['sv2'], poolSlugs: [] };
  assert.equal(detectionFingerprint(base), detectionFingerprint({ ...base, overridesFile: 'x' }));
  assert.notEqual(detectionFingerprint(base), detectionFingerprint({ ...base, poolSlugs: ['dmnd'] }));
});
