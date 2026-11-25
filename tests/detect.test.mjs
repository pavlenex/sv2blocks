import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoDetect, coinbaseText, compilePatterns, detectionFingerprint, parseJdpTag } from '../scripts/lib/detect.mjs';
import { parseBlock } from '../scripts/lib/mempool.mjs';

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

test('detects Job Declaration Protocol tags (Sv2/pool/miner/ and v2/pool/miner/) and extracts miner tag', () => {
  for (const [tag, expectedMiner] of [
    ['Sv2/DMND/GM/', 'GM'],
    ['/SV2/Braiins/Alice/', 'Alice'],
    ['/sv2/Ocean/HomeMiner', 'HomeMiner'],
    ['/v2/DMND/GoMining/', 'GoMining'],
    ['v2/PoolX/Miner-1/', 'Miner-1'],
  ]) {
    const raw = `03b6930e${hex(tag)}00ff`;
    const parsed = parseJdpTag(raw);
    assert.equal(parsed?.minerTag, expectedMiner, tag);
    const detected = autoDetect({ coinbaseRaw: raw, poolSlug: 'x' }, regexes, []);
    assert.equal(detected?.jdp, true, tag);
    assert.equal(detected?.miner, expectedMiner, tag);
  }
});

test('does not flag pool-built templates with empty miner slot (e.g. MARA Sv2/MARA🇺🇸🇺🇸//) as JDP', () => {
  const mara977145 =
    '03f9e80e1a5376322f4d415241f09f87baf09f87b8f09f87baf09f87b82f2f140100001600000000000000000000156700317af5';
  assert.equal(parseJdpTag(mara977145), null);
  const detected = autoDetect({ coinbaseRaw: mara977145, poolSlug: 'marapool' }, regexes, []);
  assert.equal(detected?.reason, 'tag');
  assert.equal(detected?.tag, 'Sv2/MARA🇺🇸🇺🇸//');
  assert.equal(detected?.jdp, false);
  assert.equal(detected?.miner, '');

  // parseBlock prefers UTF-8 decoding of coinbaseRaw over mempool's Latin-1 coinbaseSignatureAscii.
  const parsed = parseBlock({
    height: 977145,
    id: '0'.repeat(64),
    timestamp: 1795407270,
    extras: {
      reward: 314045276,
      totalFees: 1545276,
      pool: { name: 'MARA Pool', slug: 'marapool' },
      coinbaseRaw: mara977145,
      coinbaseSignatureAscii: 'ùèSv2/MARAð\u009f\u0087ºð\u009f\u0087¸ð\u009f\u0087ºð\u009f\u0087¸//g1zõ',
    },
  });
  assert.equal(parsed.details.coinbaseTag, 'Sv2/MARA🇺🇸🇺🇸//');
  assert.equal(parsed.details.coinbaseRaw, mara977145);

  for (const nonJdp of ['Sv2/MARA//', '/Sv2/PoolX/', '/v2/PoolX/', 'ff7632aa']) {
    const raw = nonJdp === 'ff7632aa' ? nonJdp : `03b6930e${hex(nonJdp)}00ff`;
    assert.equal(parseJdpTag(raw), null, nonJdp);
  }
});
