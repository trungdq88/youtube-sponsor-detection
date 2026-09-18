// Service worker: holds the API keys, talks to TypeSafe, caches results per
// video and keeps the running stats. The content script never sees a key.
//
// Live mode adds an offscreen document (offscreen.js) that captures the tab's
// audio and streams it to a speech API; this worker relays its transcripts to
// the tab and answers the tab's "is this a sponsor read?" checks with Jev.

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
  pricePerMillionInput: 0.042,

  // Live mode: listen to the tab instead of reading the transcript.
  // 'transcript' is the original behaviour; 'live' skips in fixed steps as
  // soon as Jev hears a sponsor read. See lib/live.js.
  mode: 'transcript',
  liveProvider: 'deepgram',
  deepgramKey: '',
  liveModel: 'nova-3',
  liveLanguage: 'en',
  liveSkipSeconds: 10,
  // USD per minute of streamed audio (Deepgram Nova-3 pay-as-you-go, Sept 2026). Editable in the popup.
  sttPricePerMinute: 0.0077
};

const EMPTY_STATS = {
  videosAnalyzed: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  sponsorsFound: 0,
  skips: 0,
  secondsSkipped: 0,
  // Live mode
  liveSeconds: 0,
  liveChecks: 0,
  liveSkips: 0,
  liveSecondsSkipped: 0
};

const OFFSCREEN_URL = 'offscreen.html';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false; // for offscreen.js, not us
  handle(message, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true; // async response
});

async function handle(message, sender) {
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

    // Live mode: popup / panel
    case 'live-start':
      return liveStart(message);
    case 'live-stop':
      return liveStop();
    case 'live-state':
      return liveState(sender?.tab?.id);
    case 'live-failed':
      return liveFailed(message.error);
    // Live mode: content script
    case 'live-check':
      return liveCheck(message.request);
    case 'live-skipped':
      return recordLiveSkip(message.seconds);
    // Live mode: offscreen document
    case 'live-transcript':
      return relay(message);
    case 'live-status':
      return liveStatus(message);
    case 'live-audio-progress':
      return recordAudio(message.seconds);
    case 'live-log':
      return relay(message);
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
    stats: {
      ...s,
      estimatedCost: cost(s.inputTokens, merged.pricePerMillionInput),
      estimatedSttCost: (s.liveSeconds / 60) * (Number(merged.sttPricePerMinute) || 0)
    },
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

// ---- live mode ------------------------------------------------------------

/**
 * Start listening to a tab. The popup gets the stream id (that needs the
 * user's click) and hands it here; the offscreen document consumes it.
 */
async function liveStart({ tabId, streamId, title }) {
  const { settings } = await getState();
  if (!settings.apiKey) throw new Error('No TypeSafe API key. Add one first.');
  if (settings.liveProvider === 'deepgram' && !settings.deepgramKey) throw new Error('No Deepgram API key. Add one first.');

  await ensureOffscreen();
  const started = await sendToOffscreen({
    type: 'live-capture-start',
    tabId,
    streamId,
    provider: settings.liveProvider,
    key: settings.deepgramKey,
    model: settings.liveModel,
    language: settings.liveLanguage
  });
  if (!started?.ok) throw new Error(started?.error ?? 'Could not start capturing the tab.');

  await chrome.storage.local.set({ live: { active: true, tabId, title: title ?? '', state: 'connecting', since: Date.now(), error: null } });
  await setSettings({ mode: 'live' });
  return liveState();
}

async function liveStop() {
  if (await hasOffscreen()) {
    await sendToOffscreen({ type: 'live-capture-stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  const { live } = await chrome.storage.local.get('live');
  const next = { ...(live ?? {}), active: false, state: 'stopped', error: null };
  await chrome.storage.local.set({ live: next });
  if (live?.tabId) chrome.tabs.sendMessage(live.tabId, { type: 'live-status', state: 'stopped' }).catch(() => {});
  return liveState();
}

/** Current capture; `thisTab` tells a content script whether it is the tab being heard. */
/** The popup could not get a capture going; remember why so the panel can say. */
async function liveFailed(error) {
  const { live } = await chrome.storage.local.get('live');
  const next = { ...(live ?? {}), active: false, state: 'error', error: error ?? 'Could not start listening.' };
  await chrome.storage.local.set({ live: next });
  return liveState();
}

async function liveState(askingTabId) {
  const { live } = await chrome.storage.local.get('live');
  const current = live ?? { active: false, tabId: null, state: 'idle' };
  return { live: current, thisTab: askingTabId !== undefined && current.active && current.tabId === askingTabId };
}

/** A status change from the offscreen document: connected, error, ended. */
async function liveStatus({ tabId, state, error }) {
  const { live } = await chrome.storage.local.get('live');
  const next = { ...(live ?? {}), tabId, state, error: error ?? null, active: state !== 'ended' && state !== 'error' && state !== 'stopped' };
  await chrome.storage.local.set({ live: next });
  if (state === 'ended' || state === 'error') chrome.offscreen?.closeDocument?.().catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'live-status', state, error: error ?? null }).catch(() => {});
  return {};
}

function relay(message) {
  chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
  return {};
}

/** One "is the speaker in a sponsor read?" question from the tab, answered by Jev. */
async function liveCheck(request) {
  const { settings } = await getState();
  if (!settings.apiKey) throw new Error('No TypeSafe API key. Click the extension icon to add one.');
  if (!request?.state || !request?.questions) throw new Error('live-check needs a state and questions');

  const result = await callTypeSafe(settings, request);
  const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.requests += 1;
  next.liveChecks += 1;
  next.inputTokens += usage.input_tokens ?? 0;
  next.outputTokens += usage.output_tokens ?? 0;
  await chrome.storage.local.set({ stats: next });
  return { result, cost: cost(usage.input_tokens, settings.pricePerMillionInput) };
}

async function recordLiveSkip(seconds) {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.liveSkips += 1;
  next.liveSecondsSkipped += Math.max(0, Number(seconds) || 0);
  await chrome.storage.local.set({ stats: next });
  return getState();
}

async function recordAudio(seconds) {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
  const next = { ...EMPTY_STATS, ...stats };
  next.liveSeconds += Math.max(0, Number(seconds) || 0);
  await chrome.storage.local.set({ stats: next });
  return {};
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Listen to the tab audio so sponsor reads can be recognised as they play.'
  });
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
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
