// Drives the extension's service worker logic in Node with a fake chrome.*
// and a fake fetch, so caching, stats and cost accounting are covered.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStubClient } from './stub-client.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo-transcript.json', import.meta.url), 'utf8'));

let listener;
const store = {};
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
  storage: {
    local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
      },
      async set(values) {
        Object.assign(store, structuredClone(values));
      }
    }
  }
};

const stub = createStubClient();
let fetchCalls = 0;
globalThis.fetch = async (url, init) => {
  fetchCalls += 1;
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.match(init.headers.authorization, /^Bearer apikey_test$/);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'jev-latest');
  const answer = await stub.systemOne(body);
  return { ok: true, status: 200, json: async () => answer };
};

function ask(message) {
  return new Promise((resolve) => listener(message, {}, resolve));
}

before(async () => {
  await import('../extension/background.js');
});

test('analyze needs a key, then finds the segment and records stats', async () => {
  const noKey = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /API key/);

  const saved = await ask({ type: 'set-settings', settings: { apiKey: 'apikey_test' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.autoSkip, true);

  const first = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.cached, false);
  assert.equal(first.result.status, 'found');
  assert.equal(first.result.segments.length, 1);
  assert.ok(first.result.segments[0].end.seconds > first.result.segments[0].start.seconds);
  assert.equal(first.requests, 4);
  assert.equal(fetchCalls, 4);
  assert.ok(first.usage.input_tokens > 0);
  assert.ok(Math.abs(first.cost - first.usage.input_tokens * 0.042 / 1e6) < 1e-12);

  const again = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues });
  assert.equal(again.cached, true);
  assert.equal(fetchCalls, 4, 'a cached video costs nothing');

  const forced = await ask({ type: 'analyze', videoId: 'abc', title: 't', cues: fixture.cues, force: true });
  assert.equal(forced.cached, false);
  assert.equal(fetchCalls, 8);

  const state = await ask({ type: 'get-state' });
  assert.equal(state.stats.videosAnalyzed, 2);
  assert.equal(state.stats.requests, 8);
  assert.equal(state.stats.sponsorsFound, 2);
  assert.equal(state.cachedVideos, 1);
  assert.ok(state.stats.estimatedCost > 0);

  const skipped = await ask({ type: 'skipped', seconds: 96 });
  assert.equal(skipped.stats.skips, 1);
  assert.equal(skipped.stats.secondsSkipped, 96);

  const reset = await ask({ type: 'reset-stats' });
  assert.equal(reset.stats.videosAnalyzed, 0);
  const cleared = await ask({ type: 'clear-cache' });
  assert.equal(cleared.cachedVideos, 0);
});

test('a changed price is reflected in the estimate', async () => {
  await ask({ type: 'set-settings', settings: { apiKey: 'apikey_test', pricePerMillionInput: 1 } });
  const r = await ask({ type: 'analyze', videoId: 'xyz', title: 't', cues: fixture.cues });
  assert.ok(Math.abs(r.cost - r.usage.input_tokens / 1e6) < 1e-12);
});
