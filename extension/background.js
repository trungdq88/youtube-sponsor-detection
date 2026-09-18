// Service worker: holds the API key, talks to TypeSafe, caches results per
// video and keeps the running stats. The content script never sees the key.

import { buildLines } from './lib/transcript.js';
import { findSponsorSegment } from './lib/jev.js';


export const DEFAULT_SETTINGS = {
  apiKey: '',
  autoSkip: true,
  threshold: 0.7,
  model: 'jev-latest',
  // Where the API lives; only worth changing to point at test/mock-typesafe-api.js.
  apiBase: 'https://api.typesafe.ai',
  // USD per million input tokens, from docs.typesafe.ai/models (Sept 2026).
  // Output tokens are free. Editable in the popup.
  pricePerMillionInput: 0.042
};

const EMPTY_STATS = {
  videosAnalyzed: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  sponsorsFound: 0,
  skips: 0,
  secondsSkipped: 0
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true; // async response
});

async function handle(message) {
  switch (message?.type) {
    case 'analyze':
      return analyze(message);
    case 'skipped':
      return recordSkip(message.seconds);
    case 'get-state':
      return getState();
    case 'set-settings':
      return setSettings(message.settings);
    case 'reset-stats':
      await chrome.storage.local.set({ stats: EMPTY_STATS });
      return getState();
    case 'clear-cache':
      await chrome.storage.local.set({ results: {} });
      return getState();
    default:
      throw new Error(`unknown message ${message?.type}`);
  }
}

async function getState() {
  const { settings, stats, results } = await chrome.storage.local.get(['settings', 'stats', 'results']);
  const merged = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const s = { ...EMPTY_STATS, ...(stats ?? {}) };
  return {
    settings: merged,
    stats: { ...s, estimatedCost: cost(s.inputTokens, merged.pricePerMillionInput) },
    cachedVideos: Object.keys(results ?? {}).length
  };
}

async function setSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(settings ?? {}), ...patch } });
  return getState();
}

async function analyze({ videoId, title, cues, force }) {
  const { settings } = await getState();
  if (!settings.apiKey) throw new Error('No TypeSafe API key. Click the extension icon to add one.');

  const { results = {} } = await chrome.storage.local.get('results');
  if (!force && results[videoId]) {
    return { cached: true, ...results[videoId], settings };
  }

  const lines = buildLines(cues);
  if (!lines.length) throw new Error('The transcript was empty.');

  let requests = 0;
  const client = {
    async systemOne(request) {
      requests += 1;
      return callTypeSafe(settings, request);
    }
  };

  const started = Date.now();
  const result = await findSponsorSegment(lines, { client, model: settings.model, title });
  const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
  const entry = {
    videoId,
    title,
    at: Date.now(),
    elapsedMs: Date.now() - started,
    requests,
    usage,
    cost: cost(usage.input_tokens, settings.pricePerMillionInput),
    result: slim(result)
  };

  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.videosAnalyzed += 1;
  next.requests += requests;
  next.inputTokens += usage.input_tokens;
  next.outputTokens += usage.output_tokens;
  if (result.status === 'found' || result.status === 'uncertain') next.sponsorsFound += 1;

  results[videoId] = entry;
  await chrome.storage.local.set({ results, stats: next });
  return { cached: false, ...entry, settings };
}

async function recordSkip(seconds) {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.skips += 1;
  next.secondsSkipped += Math.max(0, Number(seconds) || 0);
  await chrome.storage.local.set({ stats: next });
  return getState();
}

/** Keep only what the page needs; the full context slice is big. */
function slim(result) {
  return {
    status: result.status,
    confidence: result.confidence ?? result.presence ?? 0,
    start: result.start ? { seconds: result.start.seconds, text: result.start.text, probability: result.start.probability } : null,
    end: result.end ? { seconds: result.end.seconds, text: result.end.text, probability: result.end.probability } : null,
    segments: (result.segments ?? []).map((seg) => ({
      confidence: seg.confidence,
      start: { seconds: seg.start.seconds, text: seg.start.text, probability: seg.start.probability },
      end: seg.end ? { seconds: seg.end.seconds, text: seg.end.text, probability: seg.end.probability } : null
    })),
    windows: (result.windows ?? []).map((w) => ({ from: w.from, to: w.to, presence: w.presence }))
  };
}

function cost(inputTokens, pricePerMillion) {
  return (Number(inputTokens) || 0) * (Number(pricePerMillion) || 0) / 1e6;
}

async function callTypeSafe(settings, request) {
  const body = JSON.stringify({ model: settings.model, ...request });
  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${settings.apiBase.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body
    });
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) throw new Error('TypeSafe rejected the API key.');

    const text = (await response.text()).slice(0, 200);
    lastError = new Error(`TypeSafe responded ${response.status}: ${text}`);
    if (response.status !== 429 && response.status < 500) throw lastError;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastError;
}
