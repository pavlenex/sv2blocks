#!/usr/bin/env node
// Writes made-up data to public/data so the site can be run without calling any API.
// The numbers are invented. Never deploy them: public/data/*.json is git-ignored for that reason.
import { loadConfig } from './lib/config.mjs';
import { createFakeApi } from './lib/fake-api.mjs';
import { updateData } from './update-data.mjs';

const config = await loadConfig();
const start = config.detection.startHeight;
const api = createFakeApi({ start, tip: start + 21857, priceUsd: 100000 });
const origin = await api.listen();
try {
  await updateData({
    argv: ['--rescan'],
    env: { ...process.env, SV2_MEMPOOL_API: `${origin}/api`, SV2_PRICE_SOURCE: 'mempool', SV2_REQUEST_DELAY_MS: '0', SV2_PREVIOUS_DATA_URL: '' },
  });
  console.log('[sv2blocks] Sample data written to public/data (invented numbers, for local development only).');
} finally {
  await api.close();
}
