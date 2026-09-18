// End-to-end check of the Chrome extension against a fake youtube.com.
//
// Playwright routes www.youtube.com to a small stand-in watch page (with a
// real <video> so timeupdate fires), serves the caption file from the demo
// fixture, and pre-seeds a Jev result in the extension's storage. That covers
// injection, caption extraction, messaging, the panel, progress-bar markers,
// auto-skip and the stats — everything except the live Jev call.
//
//   npm i -D playwright && npx playwright install chromium
//   npm run test:ext
//
// Set CHROME=/path/to/chrome to use a specific binary.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const extension = path.join(root, 'extension');
const fixture = JSON.parse(await readFile(path.join(root, 'fixtures/demo-transcript.json'), 'utf8'));
const VIDEO_ID = 'demo00000001';

// Caption file in YouTube's json3 shape, from the demo transcript.
const json3 = {
  events: fixture.cues.map((c) => ({ tStartMs: c.startMs, dDurationMs: c.endMs - c.startMs, segs: [{ utf8: c.text }] }))
};
const playerResponse = {
  videoDetails: { videoId: VIDEO_ID, title: 'Demo video' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + VIDEO_ID + '&lang=en', languageCode: 'en', kind: 'asr' }]
    }
  }
};
const watchHtml = (await readFile(path.join(root, 'test/fixtures/fake-watch.html'), 'utf8')).replace(
  '__PLAYER_RESPONSE__',
  JSON.stringify(playerResponse)
);

// 400 s of silence as a WAV so the <video> has a duration and a clock.
const wav = (() => {
  const rate = 8000; // Chrome's demuxer rejects lower sample rates
  const n = rate * 400;
  const buf = Buffer.alloc(44 + n, 128);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  return buf;
})();

const userDataDir = await mkdtemp(path.join(tmpdir(), 'sponsor-skip-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath: process.env.CHROME || undefined,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--headless=new', '--autoplay-policy=no-user-gesture-required']
});

await context.route('https://www.youtube.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: watchHtml });
  if (url.pathname === '/api/timedtext') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(json3) });
  if (url.pathname === '/media/silence.wav') {
    // Honour range requests, which Chrome needs in order to seek.
    const range = route.request().headers()['range']?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : wav.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'audio/wav',
      body: wav.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': String(end - start + 1) }
    });
  }
  return route.fulfill({ status: 404, body: '' });
});

let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const errors = [];
context.on('weberror', (e) => errors.push(String(e.error)));

// Seed a key and a ready-made Jev result so no live call is needed. Extension
// pages have the chrome.* APIs; the popup is a handy one to evaluate in.
const extensionId = new URL(worker.url()).host;
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
const seconds = (i) => fixture.cues[i].startMs / 1000;
await popup.evaluate(
  async ({ videoId, start, end }) => {
    await chrome.storage.local.set({
      settings: { apiKey: 'apikey_test', autoSkip: true, threshold: 0.7, model: 'jev-latest', apiBase: 'https://api.typesafe.ai', pricePerMillionInput: 0.042 },
      results: {
        [videoId]: {
          videoId, title: 'Demo video', at: Date.now(), elapsedMs: 1234, requests: 3,
          usage: { input_tokens: 2400, output_tokens: 36 }, cost: 2400 * 0.042 / 1e6,
          result: { status: 'found', confidence: 0.94, segments: [{ confidence: 0.94, start: { seconds: start, text: 'x', probability: 0.9 }, end: { seconds: end, text: 'y', probability: 0.9 } }] }
        }
      }
    });
  },
  { videoId: VIDEO_ID, start: seconds(14), end: seconds(27) }
);

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);

// Panel shows the cached segment.
await page.waitForSelector('#sponsor-skip-panel .ss-segment', { timeout: 15000 });
const range = await page.textContent('#sponsor-skip-panel .ss-range');
assert.match(range, /^1:2\d – 2:5\d$/, `range ${range}`);
const status = await page.textContent('#sponsor-skip-panel .ss-status');
assert.match(status, /1 sponsor read found \(cached\)/, status);
const thisVideo = await page.textContent('#sponsor-skip-panel .ss-stat-value');
assert.match(thisVideo, /2,400 tokens · 3 calls · \$0\.0001/, thisVideo);

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

// Marker on the progress bar.
await page.waitForSelector('.sponsor-skip-marker', { timeout: 15000, state: 'attached' }).catch(async (e) => {
  console.log('video state:', await page.evaluate(() => { const v = document.querySelector('video'); return { duration: v.duration, readyState: v.readyState, err: v.error && v.error.message }; }));
  throw e;
});
const left = await page.$eval('.sponsor-skip-marker', (m) => parseFloat(m.style.left));
assert.ok(left > 20 && left < 25, `marker at ${left}% of a 400 s bar`);

// Auto-skip: seek into the sponsor read and play.
const skipStart = seconds(14);
const played = await page.evaluate(async (t) => {
  const v = document.querySelector('video');
  v.muted = true;
  try { await v.play(); } catch (e) { return { error: String(e) }; }
  await new Promise((r) => v.addEventListener('timeupdate', r, { once: true }));
  v.currentTime = t + 1;
  await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  await new Promise((r) => setTimeout(r, 800));
  return { paused: v.paused, currentTime: v.currentTime, readyState: v.readyState, duration: v.duration, err: v.error && v.error.message };
}, skipStart);
console.log('video after play():', played);
await page.waitForFunction((end) => document.querySelector('video').currentTime >= end, seconds(27), { timeout: 15000 });
await page.waitForSelector('.ss-toast');
const toast = await page.textContent('.ss-toast');
assert.match(toast, /Skipped the sponsor read/, toast);
await page.waitForFunction(() => /1 reads/.test(document.querySelector('#sponsor-skip-panel .ss-stats').textContent));

// A fresh video with no cached result goes to the background, which hits the
// API; whatever it answers (blocked network or a real key error), the panel
// must show it rather than hang.
await popup.evaluate(async () => chrome.storage.local.set({ results: {} }));
await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
await page.waitForSelector('#sponsor-skip-panel .ss-status', { timeout: 15000 });
await page.waitForFunction(() => !/asking Jev/.test(document.querySelector('#sponsor-skip-panel .ss-status').textContent), null, { timeout: 30000 });
const outcome = await page.textContent('#sponsor-skip-panel .ss-status');
console.log('uncached outcome:', outcome);

// Live mode: the panel's Start button captures the element's audio and the
// worker gets chunks. The speech socket itself cannot be reached from here;
// what is checked is that the capture attaches without page errors and that
// audio flows to the worker.
await popup.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, mode: 'live', deepgramKey: 'dg_test' } });
});
await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
await page.waitForSelector('#sponsor-skip-panel .ss-body', { timeout: 15000 });
// Listening starts on its own once the video plays.
await page.evaluate(async () => { const v = document.querySelector('video'); v.muted = true; await v.play().catch(() => {}); });
await page.waitForFunction(() => /Capturing the video element/.test(document.querySelector('#sponsor-skip-panel .ss-log-list')?.textContent ?? ''), null, { timeout: 15000 })
  .catch(async (e) => { console.log('live log:', await page.textContent('#sponsor-skip-panel .ss-body')); throw e; });
await page.waitForFunction(() => document.querySelector('#sponsor-skip-panel .ss-controls')?.textContent.includes('Stop listening'), null, { timeout: 5000 });
const liveLog = await page.textContent('#sponsor-skip-panel .ss-log-list');
console.log('live log:', liveLog.replace(/\s+/g, ' ').slice(0, 300));
const heardSeconds = await popup.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 11000));
  const { stats } = await chrome.storage.local.get('stats');
  return stats?.liveSeconds ?? 0;
});
console.log('audio relayed to the worker (s):', heardSeconds);
assert.ok(heardSeconds > 5, `expected ~10 s of audio to reach the offscreen document, got ${heardSeconds}`);
// Stop is an opt-out for this video: the button comes back and play does not restart it.
await page.click('#sponsor-skip-panel .ss-controls .ss-button');
await page.waitForSelector('#sponsor-skip-panel .ss-start .ss-button', { timeout: 5000 });
await page.evaluate(async () => { const v = document.querySelector('video'); v.pause(); await v.play().catch(() => {}); });
await new Promise((r) => setTimeout(r, 1500));
assert.match(await page.textContent('#sponsor-skip-panel .ss-status'), /Listening is off for this video/);
await popup.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, mode: 'transcript' } });
});

// Popup renders stats.
await popup.reload();
await popup.waitForSelector('#stats tr');
const rows = await popup.$$eval('#stats tr', (trs) => trs.map((t) => t.textContent));
assert.ok(rows.some((r) => /Reads skipped1/.test(r)), rows.join('\n'));
assert.ok(rows.some((r) => /Time saved/.test(r)));

await context.close();
if (errors.length) {
  console.error('page/worker errors:', errors);
  process.exit(1);
}
console.log('extension e2e: ok');
