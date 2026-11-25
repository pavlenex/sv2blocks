// A tiny stand-in for a mempool instance, serving made-up but well-formed blocks.
// Used by the tests and by `npm run data:sample` so the site can be developed offline.
import { createHash } from 'node:crypto';
import http from 'node:http';
import { subsidy } from './store.mjs';

const POOLS = ['Pool A', 'Pool B', 'Pool C', 'Pool D', 'Pool E', 'Pool F', 'Pool G', 'Pool H'];
const SV2_POOLS = ['MARA Pool', 'DMND', 'Pool B', 'Pool C', 'Pool D'];
const SV2_SHARES = [0.46, 0.68, 0.84, 0.94, 1];
const SV2_TAGS = ['Sv2/MARA//', '/Stratum V2/', '/sv2/', 'Sv2/DMND/GM/', 'Sv2/PoolB/HomeMiner/'];

const toHex = (text) => Buffer.from(text, 'latin1').toString('hex');
const unit = (seed) => createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32;
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function createFakeApi({ start, tip, tipTime = Math.floor(Date.now() / 1000) - 300, priceUsd = 98765.43, sv2Rate = (f) => 0.002 + 0.03 * f * f }) {
  const state = { tip, salt: new Map(), requests: 0, priceStatus: 200, priceUsd, files: new Map(), statuses: new Map(), rateLimitNext: 0, failBlocksAbove: Infinity, userAgents: new Set() };

  function block(height) {
    const salt = state.salt.get(height) ?? '';
    const span = Math.max(1, state.tip - start);
    const isSv2 = height !== start && unit(`sv2:${height}`) < sv2Rate((height - start) / span);
    let poolName;
    let coinbase;
    if (height === start) {
      poolName = 'DMND'; // the first known SV2 block carries no tag, as on the real chain
      coinbase = '002f444d4e442f474d2f00415fbf88';
    } else if (isSv2) {
      const pick = unit(`pool:${height}`);
      poolName = SV2_POOLS[SV2_SHARES.findIndex((share) => pick < share)];
      coinbase = toHex(SV2_TAGS[Math.floor(unit(`tag:${height}`) * SV2_TAGS.length)]) + '00a1b2';
    } else {
      poolName = POOLS[Math.floor(unit(`other:${height}`) * POOLS.length)];
      coinbase = toHex(`/${poolName}/`) + '00c3d4e5';
    }
    const fees = 200000 + Math.floor(unit(`fees:${height}`) * 4800000);
    return {
      id: createHash('sha256').update(`block:${height}:${salt}`).digest('hex'),
      height,
      timestamp: tipTime - (state.tip - height) * 600 + Math.floor(unit(`time:${height}:${salt}`) * 240) - 120,
      tx_count: 3000,
      extras: {
        reward: subsidy(height) + fees,
        totalFees: fees,
        coinbaseAddress: `bc1q${createHash('sha256').update(`addr:${poolName}`).digest('hex').slice(0, 38)}`,
        coinbaseRaw: `03${height.toString(16).padStart(6, '0')}${coinbase}`,
        pool: { id: 1, name: poolName, slug: slugOf(poolName) },
      },
    };
  }

  const server = http.createServer((request, response) => {
    state.requests++;
    const url = new URL(request.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (state.statuses.has(url.pathname)) return send(state.statuses.get(url.pathname), 'error', 'text/plain');
    if (state.files.has(url.pathname)) return send(200, state.files.get(url.pathname));
    if (url.pathname === '/api/blocks/tip/height') return send(200, String(state.tip), 'text/plain');
    if (url.pathname === '/api/v1/prices') {
      return state.priceStatus === 200 ? send(200, { time: tipTime, USD: state.priceUsd, EUR: 1 }) : send(state.priceStatus, 'no');
    }
    const match = /^\/api\/v1\/blocks\/(\d+)$/.exec(url.pathname);
    if (match) {
      state.userAgents.add(request.headers['user-agent']);
      if (state.rateLimitNext > 0) {
        state.rateLimitNext--;
        response.writeHead(429, { 'retry-after': '0.05' });
        return response.end('slow down');
      }
      if (Number(match[1]) > state.failBlocksAbove) return send(400, 'bad request', 'text/plain');
      const top = Math.min(Number(match[1]), state.tip);
      const list = [];
      for (let height = top; height > top - 15 && height >= 0; height--) list.push(block(height));
      return send(200, list);
    }
    send(404, 'Not found', 'text/plain');
  });

  return {
    state,
    block,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
