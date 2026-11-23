import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddableJson } from '../scripts/lib/embed.mjs';

test('embedded summary cannot close its script block or open a comment', () => {
  const hostile = { v: 1, sv2: [{ pool: '</script><script>alert(1)</script>', tag: '<!-- & \u2028 -->' }] };
  const out = embeddableJson(JSON.stringify(hostile));
  assert.ok(out);
  assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), hostile);
});

test('embedded summary is skipped when the file is not a JSON object or is oversized', () => {
  assert.equal(embeddableJson('not json'), null);
  assert.equal(embeddableJson('[1,2]'), null);
  assert.equal(embeddableJson('null'), null);
  assert.equal(embeddableJson(undefined), null);
  assert.equal(embeddableJson(JSON.stringify({ pad: 'x'.repeat(300_000) })), null);
});
