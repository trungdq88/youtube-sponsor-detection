// Takes the README screenshots of the extension in headless Chromium, against
// the same stand-in youtube.com page the e2e test uses. No network needed.
//
//   npm run screenshots        -> docs/popup.png, docs/panel.png

import { chromium } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const extension = path.join(root, 'extension');
const fixture = JSON.parse(await readFile(path.join(root, 'fixtures/demo-transcript.json'), 'utf8'));
const VIDEO_ID = 'demo00000001';

const playerResponse = {
  videoDetails: { videoId: VIDEO_ID, title: 'Demo video' },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + VIDEO_ID + '&lang=en', languageCode: 'en', kind: 'asr' }] } }
};
const json3 = { events: fixture.cues.map((c) => ({ tStartMs: c.startMs, dDurationMs: c.endMs - c.startMs, segs: [{ utf8: c.text }] })) };
const watchHtml = (await readFile(path.join(root, 'test/fixtures/fake-watch.html'), 'utf8')).replace('__PLAYER_RESPONSE__', JSON.stringify(playerResponse));
const wav = (() => {
  const rate = 8000, n = rate * 400;
  const buf = Buffer.alloc(44 + n, 128);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
  return buf;
})();

const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'sponsor-skip-shots-')), {
  headless: true,
  executablePath: process.env.CHROME || undefined,
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--headless=new', '--autoplay-policy=no-user-gesture-required']
});
await context.route('https://www.youtube.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: watchHtml });
  if (url.pathname === '/api/timedtext') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(json3) });
  if (url.pathname === '/media/silence.wav') {
    const range = route.request().headers()['range']?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : wav.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': String(end - start + 1) } });
  }
  return route.fulfill({ status: 404, body: '' });
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;
const seconds = (i) => fixture.cues[i].startMs / 1000;

const popup = await context.newPage();
await popup.setViewportSize({ width: 392, height: 900 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
await popup.evaluate(async ({ videoId, start, end }) => {
  await chrome.storage.local.set({
    settings: { apiKey: 'apikey_demo', deepgramKey: 'dg_demo', mode: 'smart', autoSkip: true, threshold: 0.7, liveSkipSeconds: 10, model: 'jev-latest', apiBase: 'https://api.typesafe.ai', pricePerMillionInput: 0.042 },
    stats: { videosAnalyzed: 12, sponsorsFound: 15, requests: 51, inputTokens: 148200, outputTokens: 610, estimatedCost: 0.00622, skips: 14, secondsSkipped: 1263, liveSeconds: 1120, estimatedSttCost: 0.0803, liveChecks: 37, liveSkips: 1, liveSecondsSkipped: 20 },
    results: { [videoId]: {
      videoId, title: 'Demo video', at: Date.now(), elapsedMs: 1830, requests: 4,
      usage: { input_tokens: 3313, output_tokens: 48 }, cost: 3313 * 0.042 / 1e6,
      result: { status: 'found', confidence: 0.94, segments: [
        { confidence: 0.94, start: { seconds: start, text: 'okay so with that out of the way', probability: 0.9 }, end: { seconds: end, text: 'now let us get back', probability: 0.9 } }
      ] }
    } }
  });
}, { videoId: VIDEO_ID, start: seconds(14), end: seconds(27) });
await popup.reload();
await popup.waitForSelector('#stats tr');
// Crop after the usage tiles; the detail table below is long.
const tiles = await popup.locator('#tiles').boundingBox();
await popup.screenshot({ path: path.join(root, 'docs/popup.png'), fullPage: true, clip: { x: 0, y: 0, width: 392, height: tiles.y + tiles.height + 16 } });

const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 720 });
await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
await page.waitForSelector('#sponsor-skip-panel .ss-segment', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
await page.locator('#sponsor-skip-panel').screenshot({ path: path.join(root, 'docs/panel.png') });
await context.close();
console.log('wrote docs/popup.png and docs/panel.png');
