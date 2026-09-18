// Runs on youtube.com. Gets the captions for the current video, hands them to
// the background worker for Jev, then draws the panel and does the skipping.
//
// Smart mode (settings.mode === 'smart') runs both: the transcript gives the
// candidate reads with their ends, the audio confirms that a read is really
// playing, and only then does the video jump straight to the read's end.
// Listening is kept to the neighbourhood of the candidates to save on the
// speech API, unless the transcript found nothing, when it listens throughout.
//
// In live mode (settings.mode === 'live') there is no transcript: this script
// captures the <video> element's audio, streams it to the background worker
// (which feeds the speech API), gets back what was heard, lets the controller
// in lib/live.js decide when Jev should be asked, and jumps the video forward
// in fixed steps while the answer is "still a sponsor read".

const PANEL_ID = 'sponsor-skip-panel';
const MARKER_CLASS = 'sponsor-skip-marker';

const state = {
  videoId: null,
  title: null,
  analysis: null, // { result, usage, cost, cached, requests, elapsedMs }
  settings: null,
  stats: null,
  skipped: new Set(), // segment indices already skipped on this video
  paused: false, // user hit undo: no more auto-skips on this video
  busy: false,
  error: null,
  errorDetail: null, // which caption routes failed and how, shown under the error
  live: {
    thisTab: false, // is this the tab being listened to
    status: 'idle', // idle | connecting | listening | error | ended | stopped
    error: null,
    hearing: '', // latest interim text
    lastHeard: '', // latest final utterance
    checking: false,
    checks: 0,
    jumps: 0,
    secondsSkipped: 0,
    cost: 0,
    last: null, // last decision from the controller log
    log: [], // { at, kind, text } newest last; kind: status | heard | check | jump | error
    showLog: false
  }
};
let liveController = null;
let liveCapture = null; // { video, context, node, port, source }
let liveOptOut = false; // the user pressed Stop on this video: no auto-start until the next one
let livePauseTimer = null; // stops the capture a little after the video pauses

// ---- lifecycle ------------------------------------------------------------

document.addEventListener('yt-navigate-finish', () => onNavigate());
window.addEventListener('load', () => onNavigate());
setInterval(() => {
  if (currentVideoId() !== state.videoId) onNavigate();
}, 1500);
onNavigate();

document.addEventListener('timeupdate', onTimeUpdate, true);
document.addEventListener('play', onPlay, true);
document.addEventListener('pause', onPause, true);
document.addEventListener('click', onPageClick, true);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = state.settings ?? {};
  state.settings = changes.settings.newValue;
  const after = state.settings ?? {};
  if (before.liveSkipSeconds !== after.liveSkipSeconds || before.threshold !== after.threshold) liveController = null;
  if ((before.mode ?? 'transcript') !== (after.mode ?? 'transcript')) onModeChange(after.mode ?? 'transcript');
  render();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'live-transcript') onLiveTranscript(message);
  else if (message?.type === 'live-status') onLiveStatus(message);
  else if (message?.type === 'live-log') liveLog('status', message.text);
  else if (message?.type === 'live-begin') {
    // The popup's Start button: same thing as the panel's.
    startListening()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

setInterval(() => {
  if (usesAudio() && state.live.thisTab) driveLive();
}, 1000);

function mode() {
  return state.settings?.mode ?? 'transcript';
}
function isLive() {
  return mode() === 'live';
}
function isSmart() {
  return mode() === 'smart';
}
/** Modes that listen to the audio. */
function usesAudio() {
  return isLive() || isSmart();
}
/** Modes that read the transcript. */
function usesTranscript() {
  return !isLive();
}
/** Audio is actually being heard in this tab right now. */
function audioActive() {
  return Boolean(liveCapture) && state.live.thisTab && state.live.status === 'listening';
}
/** Audio is on its way (socket connecting): smart mode waits for it rather than skipping blind. */
function audioPending() {
  return Boolean(liveCapture) && state.live.status === 'connecting';
}

function currentVideoId() {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

async function onNavigate() {
  const videoId = currentVideoId();
  if (videoId === state.videoId) return;
  liveOptOut = false;

  state.videoId = videoId;
  state.analysis = null;
  state.error = null;
  state.errorDetail = null;
  state.skipped = new Set();
  state.paused = false;
  removeMarkers();

  if (!videoId) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }

  await refreshState();
  if (usesAudio()) {
    liveController?.reset();
    await refreshLiveState();
    if (liveCapture && liveCapture.video !== findVideo()) reattachCapture();
  }
  render();
  if (usesTranscript()) analyze(false);
  if (usesAudio()) autoListen();
}

async function onModeChange(next) {
  if (next === 'live' || next === 'smart') {
    liveController?.reset();
    await refreshLiveState();
    render();
    if (next === 'smart' && state.videoId && !state.analysis && !state.busy) analyze(false);
    autoListen();
  } else {
    stopCapture();
    if (state.videoId && !state.analysis && !state.busy) analyze(false);
  }
}

async function refreshState() {
  const response = await send({ type: 'get-state' });
  if (response?.ok) {
    state.settings = response.settings;
    state.stats = response.stats;
  }
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response);
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

// ---- analysis -------------------------------------------------------------

async function analyze(force) {
  const videoId = state.videoId;
  if (!videoId || state.busy) return;
  state.busy = true;
  state.error = null;
  state.errorDetail = null;
  render();

  try {
    const { cues, title } = await getCaptions(videoId);
    if (videoId !== state.videoId) return;
    state.title = title;

    const response = await send({ type: 'analyze', videoId, title, cues, force });
    if (videoId !== state.videoId) return;
    if (!response.ok) throw new Error(response.error);

    state.analysis = response;
    state.settings = response.settings ?? state.settings;
    await refreshState();
    drawMarkers();
  } catch (error) {
    state.error = error.message;
    state.errorDetail = error.detail ?? null;
  } finally {
    if (videoId === state.videoId) {
      state.busy = false;
      render();
    }
  }
}

/**
 * Captions for the video, from whichever route YouTube still serves:
 *  1. the caption track from the live player (or the watch page HTML), fetched as json3;
 *  2. the caption track the ANDROID client is given, which needs no token;
 *  3. the transcript panel behind YouTube's own "Show transcript" button,
 *     requested from the page itself with the page's cookies and signature;
 *  4. the same panel, requested anonymously from this content script.
 *
 * Route 1 is the same file the player uses for subtitles, but YouTube now
 * answers those URLs with an empty 200 unless the request carries a
 * proof-of-origin token the player generates internally. The others are the
 * routes transcript tools fell back to when that started.
 */
async function getCaptions(videoId) {
  let tracks = null;
  let title = null;
  let innertube = null;

  for (let attempt = 0; attempt < 6 && !tracks; attempt++) {
    const answer = await askPage();
    innertube ??= answer?.innertube ?? null;
    if (answer?.videoId === videoId && answer.tracks?.length) {
      tracks = answer.tracks;
      title = answer.title;
    } else {
      await sleep(500);
    }
  }

  if (!tracks) {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: 'include' })).text();
    const player = extractPlayerResponse(html);
    tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
    title = player?.videoDetails?.title ?? title;
    innertube ??= extractInnertubeConfig(html);
  }

  title ??= document.title.replace(/ - YouTube$/, '');
  const failures = [];

  const track = pickCaptionTrack(tracks ?? []);
  const routes = [
    ['caption file', () => (track ? fetchCaptionTrack(track.baseUrl) : Promise.reject(new Error('no caption tracks in the player response')))],
    ['android captions', () => fetchAndroidCaptions(videoId)],
    ['transcript panel (page)', () => fetchTranscriptPanelViaPage(videoId)],
    ['transcript panel', () => fetchTranscriptPanel(videoId, innertube)]
  ];
  for (const [name, run] of routes) {
    try {
      const cues = await run();
      if (cues.length) return { cues, title };
      failures.push(`${name}: no text`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  const detail = failures.join(' | ');
  console.warn('[sponsor-skip] no transcript:', detail);
  const error = new Error(
    track
      ? 'YouTube would not hand over the transcript for this video. Try again in a moment.'
      : 'This video has no captions, so there is no transcript to read.'
  );
  error.detail = detail;
  throw error;
}

async function fetchCaptionTrack(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`YouTube captions responded ${response.status}.`);
  const text = await response.text();
  if (!text.trim()) throw new Error('YouTube returned an empty caption file.');
  return parseJson3(JSON.parse(text));
}

// ---- android captions -----------------------------------------------------

/**
 * The ANDROID client's player response carries caption URLs that YouTube still
 * serves without a proof-of-origin token (the route youtube-transcript-api uses).
 */
async function fetchAndroidCaptions(videoId) {
  const context = { client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' } };
  const player = await innertubeCall('player', { videoId }, { apiKey: null, context }, { clientName: '3' });
  const status = player?.playabilityStatus;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickCaptionTrack(tracks);
  if (!track) throw new Error(status?.reason ?? status?.status ?? 'no caption tracks');
  return fetchCaptionTrack(track.baseUrl);
}

// ---- transcript panel -----------------------------------------------------

const INNERTUBE_FALLBACK = {
  apiKey: null,
  context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } }
};

/**
 * The transcript panel is two InnerTube calls: `next` gives the panel's
 * `getTranscriptEndpoint.params` for this video, `get_transcript` returns the
 * segments. Cookies are left out on purpose: with them, YouTube demands the
 * signed Authorization header the page adds, and answers 401 without it.
 */
async function fetchTranscriptPanel(videoId, innertube) {
  const config = innertube?.context ? innertube : INNERTUBE_FALLBACK;
  const next = await innertubeCall('next', { videoId }, config);
  const params = findTranscriptParams(next);
  if (!params) throw new Error('no transcript panel for this video');

  const data = await innertubeCall('get_transcript', { params }, config);
  return cuesFromTranscriptSegments(findKey(data, 'transcriptSegmentListRenderer')?.initialSegments ?? []);
}

/** The same two calls, made by the page bridge as the page itself would make them. */
async function fetchTranscriptPanelViaPage(videoId) {
  const answer = await askPageTranscript(videoId);
  if (!answer) throw new Error('page did not answer');
  if (answer.error) throw new Error(answer.error);
  return cuesFromTranscriptSegments(answer.segments ?? []);
}

function cuesFromTranscriptSegments(segments) {
  const cues = [];
  for (const item of segments) {
    const seg = item.transcriptSegmentRenderer;
    if (!seg?.snippet) continue;
    const text = (seg.snippet.runs ?? [])
      .map((r) => r.text ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const startMs = Number(seg.startMs);
    if (!text || !Number.isFinite(startMs)) continue;
    cues.push({ text, startMs, endMs: Number(seg.endMs ?? seg.startMs) });
  }
  return cues;
}

async function innertubeCall(endpoint, body, config, headers = {}) {
  const url = new URL(`https://www.youtube.com/youtubei/v1/${endpoint}`);
  url.searchParams.set('prettyPrint', 'false');
  if (config.apiKey) url.searchParams.set('key', config.apiKey);
  const client = config.context.client ?? {};
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': headers.clientName ?? '1',
      'x-youtube-client-version': client.clientVersion ?? INNERTUBE_FALLBACK.context.client.clientVersion
    },
    body: JSON.stringify({ context: config.context, ...body })
  });
  if (!response.ok) throw new Error(`${endpoint} responded ${response.status}`);
  return response.json();
}

function findTranscriptParams(next) {
  for (const panel of next?.engagementPanels ?? []) {
    const endpoint = findKey(panel, 'getTranscriptEndpoint');
    if (endpoint?.params) return endpoint.params;
  }
  return findKey(next, 'getTranscriptEndpoint')?.params ?? null;
}

/** Depth-first search for the first object stored under `key`. */
function findKey(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findKey(item, key, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node[key] && typeof node[key] === 'object') return node[key];
  for (const value of Object.values(node)) {
    const found = findKey(value, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractInnertubeConfig(html) {
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
  const at = html.indexOf('"INNERTUBE_CONTEXT":');
  if (at < 0) return null;
  const context = extractJsonObject(html, html.indexOf('{', at));
  return context ? { apiKey: key, context } : null;
}

function askPageTranscript(videoId) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 15000);
    function onMessage(event) {
      if (event.source !== window || event.data?.type !== 'sponsor-skip:transcript' || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'sponsor-skip:get-transcript', requestId, videoId }, '*');
  });
}

function askPage() {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, 800);
    function onMessage(event) {
      if (event.source !== window || event.data?.type !== 'sponsor-skip:captions' || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'sponsor-skip:get-captions', requestId }, '*');
  });
}

function extractPlayerResponse(html) {
  const at = html.indexOf('ytInitialPlayerResponse');
  if (at < 0) return null;
  return extractJsonObject(html, html.indexOf('{', at));
}

/** Parse the JSON object that opens at `open`, tracking braces through strings. */
function extractJsonObject(html, open) {
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function pickCaptionTrack(tracks) {
  if (!tracks.length) return null;
  const english = tracks.filter((t) => /^en\b/i.test(t.languageCode ?? ''));
  return english.find((t) => t.kind !== 'asr') ?? english[0] ?? tracks[0];
}

// Same as parseJson3 in src/youtube.js: auto-generated tracks time every
// word, and those offsets let a skip land on a word instead of a whole cue.
function parseJson3(data) {
  const cues = [];
  for (const event of data?.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = Number(event.tStartMs ?? 0);
    const cue = { text, startMs, endMs: startMs + Number(event.dDurationMs ?? 0) };
    // The first word of an event carries no tOffsetMs: it starts with the event.
    const words = event.segs
      .filter((s) => (s.utf8 ?? '').trim())
      .map((s) => ({ text: s.utf8.trim(), offsetMs: Number(s.tOffsetMs ?? 0) }));
    if (words.length > 1 && words.some((w) => w.offsetMs > 0)) cue.words = words;
    cues.push(cue);
  }
  return cues;
}

// ---- skipping -------------------------------------------------------------

function segments() {
  return state.analysis?.result?.segments ?? [];
}

function skippable(seg) {
  return seg.end && seg.confidence >= (state.settings?.threshold ?? 0.7);
}

function onTimeUpdate(event) {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement)) return;
  if (isSmart()) smartTick(video);
  if (!state.settings?.autoSkip || state.paused) return;
  // Smart mode with the audio running waits for the audio's confirmation
  // (see smartJumpTarget); without it, it skips from the transcript alone.
  if (isSmart() && (audioActive() || audioPending())) return;
  if (isLive()) return;

  segments().forEach((seg, index) => {
    if (state.skipped.has(index) || !skippable(seg)) return;
    const t = video.currentTime;
    if (t >= seg.start.seconds && t < seg.end.seconds - 0.5) {
      skipTo(video, seg, index, true);
    }
  });
}

function skipTo(video, seg, index, automatic) {
  const from = video.currentTime;
  video.currentTime = seg.end.seconds;
  state.skipped.add(index);
  const saved = Math.max(0, seg.end.seconds - from);
  send({ type: 'skipped', seconds: saved }).then((r) => {
    if (r?.ok) {
      state.stats = r.stats;
      render();
    }
  });
  toast(`${automatic ? 'Skipped' : 'Jumped past'} the sponsor read, ${stamp(from)} → ${stamp(seg.end.seconds)}`, () => {
    video.currentTime = from;
    state.paused = true;
    state.skipped.delete(index);
    render();
  });
}

// ---- live mode ------------------------------------------------------------

/** One line for the panel's log and the page console. */
function liveLog(kind, text) {
  const entry = { at: Date.now(), kind, text };
  state.live.log.push(entry);
  if (state.live.log.length > 200) state.live.log.shift();
  const fn = kind === 'error' ? console.warn : console.info;
  fn(`[sponsor-skip live] ${text}`);
}

// ---- smart mode -----------------------------------------------------------

/** How far around a candidate read the audio is listened to, in seconds. */
const SMART_BEFORE = 25;
const SMART_AFTER = 15;
/** A read is a candidate for confirmation from this confidence up (the MAYBE band). */
const SMART_CANDIDATE = 0.35;

function smartCandidates() {
  return segments().filter((seg) => seg.end && seg.confidence >= SMART_CANDIDATE);
}

/**
 * Should the audio be on at time t? While the transcript is still being
 * read, or when it gave nothing, listen throughout; otherwise only near the
 * candidates.
 */
function smartWantsAudio(t) {
  if (state.busy || state.error || !state.analysis) return true;
  const candidates = smartCandidates();
  if (!candidates.length) return true;
  return candidates.some((seg, i) => !state.skipped.has(segments().indexOf(seg)) && t >= seg.start.seconds - SMART_BEFORE && t < seg.end.seconds + SMART_AFTER);
}

let smartOffTimer = null;
function smartTick(video) {
  if (liveOptOut || video.paused) return;
  const want = smartWantsAudio(video.currentTime);
  if (want && !liveCapture) {
    clearTimeout(smartOffTimer);
    smartOffTimer = null;
    autoListen();
  } else if (!want && liveCapture && !smartOffTimer) {
    smartOffTimer = setTimeout(() => {
      smartOffTimer = null;
      const v = findVideo();
      if (liveCapture && v && !smartWantsAudio(v.currentTime)) {
        liveLog('status', 'Past the candidate reads, audio off until the next one');
        stopCapture(true);
        state.live.status = 'stopped';
        render();
      }
    }, 5000);
  }
}

/**
 * Where a confirmed read should jump to: the end of the transcript's read
 * around the playhead, or null when there is none (then it steps, like live
 * mode). Marks the read as skipped so the transcript path leaves it alone.
 */
function smartJumpTarget(t) {
  const segs = segments();
  const index = segs.findIndex((seg) => seg.end && seg.confidence >= SMART_CANDIDATE && t >= seg.start.seconds - 60 && t < seg.end.seconds - 1);
  if (index < 0) return null;
  state.skipped.add(index);
  return segs[index];
}

// ---- auto start / stop ----------------------------------------------------
//
// Listening follows playback: it starts when the video plays and stops a
// little after it pauses (so a short pause does not cost a reconnect), unless
// the user pressed Stop on this video.

const PAUSE_GRACE_MS = 20000;

function autoListen() {
  const video = findVideo();
  if (!usesAudio() || liveOptOut || liveCapture || !video || video.paused || !state.videoId) return;
  if (isSmart() && !smartWantsAudio(video.currentTime)) return;
  startListening().catch((error) => {
    state.live.status = 'error';
    state.live.error = error.message;
    render();
  });
}

function onPlay(event) {
  if (!(event.target instanceof HTMLVideoElement) || !usesAudio()) return;
  clearTimeout(livePauseTimer);
  livePauseTimer = null;
  if (liveCapture) {
    if (liveCapture.context.state === 'suspended') liveCapture.context.resume().catch(() => {});
    return;
  }
  autoListen();
}

function onPause(event) {
  if (!(event.target instanceof HTMLVideoElement) || !liveCapture) return;
  clearTimeout(livePauseTimer);
  livePauseTimer = setTimeout(() => {
    livePauseTimer = null;
    const video = findVideo();
    if (liveCapture && video?.paused) {
      liveLog('status', 'Video paused, stopped listening (starts again on play)');
      stopCapture(true);
      state.live.status = 'stopped';
      render();
    }
  }, PAUSE_GRACE_MS);
}

/** The browser may hold the audio graph until the page has been clicked. */
function onPageClick() {
  if (liveCapture?.context.state === 'suspended') liveCapture.context.resume().catch(() => {});
}

// ---- audio capture --------------------------------------------------------
//
// The audio comes from the <video> element itself (captureStream), not from
// Chrome's tab capture, which only works from a click on the extension icon.
// The element's own playback is untouched. Chunks of 16 kHz PCM go to the
// background worker over a port, base64 because ports carry JSON.

function findVideo() {
  return document.querySelector('video.html5-main-video') ?? document.querySelector('video');
}

/** Start listening in this tab: open the speech socket, then start streaming audio. */
async function startListening() {
  if (liveCapture) return;
  const video = findVideo();
  if (!video) throw new Error('No video on this page yet.');
  const title = document.title.replace(/ - YouTube$/, '');
  const r = await send({ type: 'live-start-here', title });
  if (!r?.ok) throw new Error(r?.error ?? 'Could not start listening.');
  state.live.thisTab = true;
  state.live.status = 'connecting';
  state.live.error = null;
  liveLog('status', 'Starting to listen in this tab');
  try {
    await attachCapture(video);
  } catch (error) {
    await send({ type: 'live-stop' });
    liveLog('error', `Could not capture the video audio: ${error.message}`);
    throw error;
  }
  render();
}

async function attachCapture(video) {
  const context = new AudioContext();
  await context.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
  const node = new AudioWorkletNode(context, 'pcm-capture');

  let source;
  const stream = typeof video.captureStream === 'function' ? video.captureStream() : null;
  const tracks = stream?.getAudioTracks() ?? [];
  if (tracks.length) {
    source = context.createMediaStreamSource(new MediaStream(tracks));
    liveLog('status', 'Capturing the video element\'s audio stream');
  } else {
    // Older path: route the element through the graph and back out to the speakers.
    source = context.createMediaElementSource(video);
    source.connect(context.destination);
    liveLog('status', 'Capturing the video element through an audio graph');
  }
  source.connect(node);
  // The worklet needs a sink to run; a silent gain keeps the captured audio out of the speakers.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(context.destination);
  if (context.state === 'suspended') await context.resume().catch(() => {});
  if (context.state === 'suspended') liveLog('status', 'The browser is holding the audio until the page is clicked once');

  const port = chrome.runtime.connect({ name: 'sponsor-skip-live' });
  port.onDisconnect.addListener(() => {
    if (liveCapture?.port === port) {
      stopCapture(false);
      liveLog('error', 'Lost the connection to the extension; press Start listening again.');
      render();
    }
  });
  node.port.onmessage = ({ data }) => {
    if (liveCapture?.port !== port) return;
    const bytes = new Uint8Array(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
    port.postMessage({ type: 'audio', pcm: btoa(binary) });
  };
  liveCapture = { video, context, node, port, source, stream };
}

/** YouTube swapped the <video> element (rare); move the capture to the new one. */
async function reattachCapture() {
  const video = findVideo();
  if (!video) return;
  stopCapture(false);
  try {
    await attachCapture(video);
    liveLog('status', 'Re-attached to the new video element');
  } catch (error) {
    liveLog('error', `Could not re-attach: ${error.message}`);
  }
}

function stopCapture(tellWorker = true) {
  clearTimeout(smartOffTimer);
  smartOffTimer = null;
  const c = liveCapture;
  liveCapture = null;
  if (c) {
    try { c.node.port.onmessage = null; c.port.disconnect(); } catch {}
    try { c.source.disconnect(); c.node.disconnect(); } catch {}
    if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
    c.context.close().catch(() => {});
  }
  if (tellWorker) send({ type: 'live-stop' });
  state.live.thisTab = false;
  state.live.hearing = '';
  liveController?.reset();
}

async function stopListening() {
  liveLog('status', 'Stopped listening on this video');
  liveOptOut = true;
  clearTimeout(livePauseTimer);
  stopCapture(true);
  state.live.status = 'stopped';
  render();
}

async function refreshLiveState() {
  const r = await send({ type: 'live-state' });
  if (!r?.ok) return;
  state.live.thisTab = Boolean(r.thisTab);
  if (r.thisTab) {
    state.live.status = r.live.state ?? 'connecting';
    state.live.error = r.live.error ?? null;
  } else if (state.live.status === 'listening' || state.live.status === 'connecting') {
    state.live.status = 'idle';
  }
}

async function liveControl() {
  if (liveController) return liveController;
  const mod = await import(chrome.runtime.getURL('lib/live.js'));
  liveController = mod.createLiveController({
    skipSeconds: state.settings?.liveSkipSeconds ?? 10,
    threshold: state.settings?.threshold ?? 0.7
  });
  return liveController;
}

let renderTimer = null;
function renderSoon() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 300);
}

function onLiveStatus({ state: status, error }) {
  liveLog(error ? 'error' : 'status', error ? `${status}: ${error}` : `Listening ${status}`);
  state.live.status = status;
  state.live.error = error ?? null;
  state.live.thisTab = status === 'connecting' || status === 'listening';
  if (!state.live.thisTab) stopCapture(false);
  render();
}

async function onLiveTranscript({ text, isFinal, heardAt, heardUntil }) {
  if (!usesAudio()) return;
  state.live.thisTab = true;
  if (state.live.status !== 'listening') state.live.status = 'listening';
  if (!isFinal) {
    state.live.hearing = text;
    renderSoon();
    return;
  }
  state.live.hearing = '';
  state.live.lastHeard = text;
  liveLog('heard', text);
  const ctl = await liveControl();
  ctl.hear({ text, heardAt, heardUntil });
  render();
  driveLive();
}

/** Ask the controller what to do; run a Jev check or a jump when it says so. */
async function driveLive() {
  if (!usesAudio() || !state.live.thisTab || state.live.checking) return;
  const ctl = await liveControl();
  const request = ctl.next(Date.now());
  if (!request) return;

  state.live.checking = true;
  const kind = ctl.phase === 'verifying' ? 'verify' : 'listen';
  const lines = Object.values(request.state).join('\n').split('\n').length;
  liveLog('check', kind === 'verify'
    ? `Asking Jev whether the read continues after the jump (${lines} lines)`
    : `Asking Jev whether this is a sponsor read (${lines} lines)`);
  render();
  const started = Date.now();
  let action = null;
  try {
    const r = await send({ type: 'live-check', request });
    if (!r?.ok) throw new Error(r?.error ?? 'Jev did not answer');
    state.live.checks += 1;
    state.live.cost += r.cost ?? 0;
    state.live.error = null;
    action = ctl.answer(r.result, Date.now());
    const last = ctl.log.at(-1);
    const usage = r.result?.usage?.input_tokens;
    liveLog('check', `Jev: ${last?.sponsor ? 'sponsor read' : 'not a sponsor read'} (${Math.round((last?.confidence ?? 0) * 100)}%, ${Date.now() - started}ms${usage ? `, ${usage} tokens` : ''})`);
  } catch (error) {
    ctl.answer(null, Date.now());
    state.live.error = error.message;
    liveLog('error', `Jev check failed: ${error.message}`);
  } finally {
    state.live.checking = false;
    state.live.last = ctl.log.at(-1) ?? null;
  }

  if (action && state.settings?.autoSkip && !state.paused) liveJump(ctl, action.skipSeconds);
  else if (action) {
    liveLog('status', 'Sponsor read heard, but auto-skip is off on this video');
    ctl.reset();
  }
  render();
}

function liveJump(ctl, seconds) {
  const video = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
  if (!video) return;
  const from = video.currentTime;
  // Smart mode, first jump of a read: the transcript knows where it ends.
  const target = isSmart() && ctl.phase === 'listening' ? smartJumpTarget(from) : null;
  let to = target ? target.end.seconds : from + seconds;
  if (Number.isFinite(video.duration)) to = Math.min(video.duration, to);
  video.currentTime = to;
  ctl.skipped(Date.now());
  liveLog('jump', target
    ? `Audio confirmed the read the transcript found (${stamp(target.start.seconds)} – ${stamp(target.end.seconds)}): jumped ${stamp(from)} → ${stamp(to)}`
    : `Jumped ${stamp(from)} → ${stamp(to)} (${ctl.consecutiveSkips} in a row)`);
  state.live.jumps += 1;
  state.live.secondsSkipped += to - from;
  send({ type: 'live-skipped', seconds: to - from }).then((r) => {
    if (r?.ok) {
      state.stats = r.stats;
      render();
    }
  });
  const n = ctl.consecutiveSkips;
  toast(target
    ? `Sponsor read confirmed, skipped to its end, ${stamp(from)} → ${stamp(to)}`
    : `Sponsor read heard, jumped ahead ${Math.round(seconds)}s${n > 1 ? ` (${n} in a row)` : ''}, ${stamp(from)} → ${stamp(to)}`, () => {
    video.currentTime = from;
    state.paused = true;
    ctl.reset();
    liveLog('status', `Undo: back to ${stamp(from)}, auto-skip paused on this video`);
    render();
  });
}

// ---- progress bar markers -------------------------------------------------

function drawMarkers() {
  removeMarkers();
  const bar = document.querySelector('.ytp-progress-bar');
  const video = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
  if (!bar || !video || !video.duration) {
    setTimeout(drawMarkers, 1000);
    return;
  }
  for (const seg of segments()) {
    const start = seg.start.seconds / video.duration;
    const end = (seg.end?.seconds ?? seg.start.seconds + 5) / video.duration;
    const marker = document.createElement('div');
    marker.className = MARKER_CLASS;
    marker.style.left = `${(start * 100).toFixed(3)}%`;
    marker.style.width = `${Math.max(0.3, (end - start) * 100).toFixed(3)}%`;
    marker.title = `Sponsor read ${stamp(seg.start.seconds)}${seg.end ? ` – ${stamp(seg.end.seconds)}` : ''}`;
    bar.appendChild(marker);
  }
}

function removeMarkers() {
  document.querySelectorAll(`.${MARKER_CLASS}`).forEach((m) => m.remove());
}

// ---- panel ----------------------------------------------------------------
//
// The panel is a fixed set of slots so nothing moves while it works: a
// status line, the reads (transcript modes), one audio line (audio modes),
// the controls, one line of usage, and a log that opens to a fixed height.

function render() {
  if (!state.videoId) return;
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }
  const collapsed = panel.dataset.collapsed === 'true';
  panel.replaceChildren(header(collapsed));
  if (!collapsed) panel.append(body());
}

function header(collapsed) {
  const h = el('div', 'ss-header');
  h.append(el('span', 'ss-title', 'Sponsor Skip'));
  h.append(el('span', 'ss-mode', { smart: 'Smart', live: 'Listen', transcript: 'Transcript' }[mode()] ?? mode()));
  const working = state.busy || state.live.checking || state.live.status === 'connecting';
  const bad = state.error && !usesAudio() ? true : state.live.status === 'error' && usesAudio() && !segments().length;
  h.append(el('span', `ss-light ${working ? 'busy' : bad ? 'bad' : segments().length || audioActive() ? 'found' : 'idle'}`));
  h.append(button(collapsed ? '▸' : '▾', () => {
    const panel = document.getElementById(PANEL_ID);
    panel.dataset.collapsed = collapsed ? 'false' : 'true';
    render();
  }, 'ss-icon'));
  return h;
}

/** The one-line summary at the top of the body. */
function statusText() {
  const segs = segments();
  if (isLive()) {
    const live = state.live;
    if (live.status === 'error' && live.error) return { text: live.error, bad: true };
    if (liveController?.phase === 'verifying') return { text: `Jumped ${liveController.consecutiveSkips}×, checking whether the read goes on` };
    if (live.checking) return { text: 'Asking Jev whether this is a sponsor read' };
    if (audioActive()) return { text: 'Listening for a sponsor read' };
    return { text: liveOptOut ? 'Off for this video' : 'Starts with playback' };
  }
  if (state.busy) return { text: 'Reading the transcript and asking Jev' };
  if (state.error) return { text: state.error, bad: true, detail: state.errorDetail };
  if (!state.analysis) return { text: 'Waiting for the video' };
  if (!segs.length) return { text: isSmart() && audioActive() ? 'No read in the transcript, listening instead' : 'No sponsor read found' };
  const n = `${segs.length} sponsor read${segs.length > 1 ? 's' : ''}`;
  if (isSmart()) return { text: `${n}, skipped when the audio agrees` };
  return { text: `${n}${state.analysis.cached ? ' (cached)' : ''}` };
}

function readsList() {
  const list = el('div', 'ss-reads');
  const video = document.querySelector('video');
  segments().forEach((seg, index) => {
    const row = el('div', 'ss-segment');
    row.append(el('span', 'ss-range', seg.end ? `${stamp(seg.start.seconds)} – ${stamp(seg.end.seconds)}` : `${stamp(seg.start.seconds)} – ?`));
    row.append(el('span', `ss-pill ${seg.confidence >= (state.settings?.threshold ?? 0.7) ? 'good' : 'warn'}`, `${Math.round(seg.confidence * 100)}%`));
    const skip = button(state.skipped.has(index) ? 'Skipped' : 'Skip', () => skipTo(video, seg, index, false), 'ss-small', !(seg.end && video) || state.skipped.has(index));
    row.append(skip);
    list.append(row);
  });
  return list;
}

/** One fixed-height line: audio state, what is being heard, Jev's last verdict. */
function audioLine() {
  const live = state.live;
  const row = el('div', 'ss-audio');
  const on = audioActive();
  const dotState = live.status === 'error' ? 'bad' : live.status === 'connecting' ? 'busy' : on ? 'on' : 'off';
  row.append(el('span', `ss-audio-dot ${dotState}`));

  const main = el('div', 'ss-audio-main');
  let label;
  if (live.status === 'error' && live.error) label = live.error;
  else if (live.status === 'connecting') label = 'Connecting to speech service';
  else if (on) label = live.checking ? 'Listening, asking Jev' : liveController?.phase === 'verifying' ? 'Listening after the jump' : 'Listening';
  else if (liveOptOut) label = 'Audio off for this video';
  else if (isSmart()) label = 'Audio off until near a read';
  else label = 'Audio starts with playback';
  const labelNode = el('div', 'ss-audio-label', label);
  labelNode.title = label;
  main.append(labelNode);
  const heard = on ? (live.hearing || live.lastHeard) : '';
  const heardNode = el('div', 'ss-audio-heard', heard ? `“${heard}”` : ' ');
  heardNode.title = heard;
  main.append(heardNode);
  row.append(main);

  const last = live.last && (live.last.kind === 'listen' || live.last.kind === 'verify') ? live.last : null;
  const verdict = el('span', `ss-verdict ${last ? (last.sponsor ? 'warn' : 'good') : ''}`, last ? `${last.sponsor ? 'sponsor' : 'content'} ${Math.round(last.confidence * 100)}%` : '–');
  verdict.title = last ? `Jev's last answer: ${last.sponsor ? 'a sponsor read is playing' : 'not a sponsor read'} (${Math.round(last.confidence * 100)}%)` : 'No Jev answer on the audio yet';
  row.append(verdict);
  return row;
}

function controls() {
  const row = el('div', 'ss-controls');
  const auto = el('label', 'ss-toggle');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(state.settings?.autoSkip);
  box.addEventListener('change', async () => {
    const r = await send({ type: 'set-settings', settings: { autoSkip: box.checked } });
    if (r?.ok) state.settings = r.settings;
    render();
  });
  auto.append(box, document.createTextNode(state.paused ? 'Auto-skip (paused here)' : 'Auto-skip'));
  auto.title = state.paused ? 'You undid a skip, so nothing more is skipped on this video' : 'Skip sponsor reads without asking';
  row.append(auto);

  const actions = el('div', 'ss-actions');
  if (usesAudio()) {
    if (state.live.thisTab) {
      actions.append(button('Stop', stopListening, 'ss-small ss-quiet', false));
    } else if (liveOptOut || state.live.status === 'error') {
      const listen = button('Listen', async () => {
        listen.disabled = true;
        liveOptOut = false;
        try {
          await startListening();
        } catch (error) {
          state.live.status = 'error';
          state.live.error = error.message;
          render();
        }
      }, 'ss-small ss-listen');
      actions.append(listen);
    } else {
      actions.append(button(' ', () => {}, 'ss-small ss-ghost', true)); // keeps the slot's width
    }
  }
  if (usesTranscript()) actions.append(button('Re-analyze', () => analyze(true), 'ss-small ss-quiet', state.busy));
  row.append(actions);
  return row;
}

/** One or two compact lines of usage. */
function usageLines() {
  const a = state.analysis;
  const s = state.stats;
  const l = state.live;
  const wrap = el('div', 'ss-stats');
  if (usesTranscript() && a) {
    wrap.append(statRow(a.cached ? 'Cached' : 'This video', `${fmtTokens(a.usage?.input_tokens)} tokens · ${a.requests ?? '?'} calls · ${money(a.cost)}`));
  }
  if (usesAudio()) {
    wrap.append(statRow('Audio', `${l.checks} checks · ${l.jumps} jumps · ${stamp(l.secondsSkipped)} skipped · ${money(l.cost)}`));
  }
  if (s) {
    const skips = usesAudio() ? s.skips + s.liveSkips : s.skips;
    const saved = usesAudio() ? s.secondsSkipped + s.liveSecondsSkipped : s.secondsSkipped;
    const spend = money(s.estimatedCost + (usesAudio() ? s.estimatedSttCost : 0));
    wrap.append(statRow('All time', `${skips} reads · ${stamp(saved)} saved · ${spend}`));
  }
  return wrap;
}

function logSection() {
  const wrap = el('div', 'ss-log');
  const head = el('div', 'ss-log-head');
  const toggle = button(`${state.live.showLog ? 'Hide log' : 'Log'} (${state.live.log.length})`, () => {
    state.live.showLog = !state.live.showLog;
    render();
  }, 'ss-link ss-log-toggle');
  head.append(toggle);
  if (state.live.showLog && state.live.log.length) {
    head.append(button('Copy', () => {
      const text = state.live.log.map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.text}`).join('\n');
      navigator.clipboard?.writeText(text);
    }, 'ss-link'));
  }
  wrap.append(head);
  if (!state.live.showLog) return wrap;
  const list = el('div', 'ss-log-list');
  if (!state.live.log.length) list.append(el('div', 'ss-log-line status', 'Nothing yet.'));
  for (const e of state.live.log.slice(-60)) {
    const line = el('div', `ss-log-line ${e.kind}`);
    line.append(el('span', 'ss-log-time', clock(e.at)), el('span', 'ss-log-text', e.text));
    list.append(line);
  }
  wrap.append(list);
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  return wrap;
}

function body() {
  const b = el('div', 'ss-body');
  const status = statusText();
  const line = el('div', `ss-status${status.bad ? ' ss-error' : ''}`, status.text);
  line.title = status.detail ?? status.text;
  b.append(line);
  if (usesTranscript() && segments().length) b.append(readsList());
  if (usesAudio()) b.append(audioLine());
  b.append(controls());
  b.append(usageLines());
  if (usesAudio()) b.append(logSection());
  return b;
}

function statRow(label, value) {
  const row = el('div', 'ss-stat');
  row.append(el('span', 'ss-stat-label', label), el('span', 'ss-stat-value', value));
  row.title = `${label}: ${value}`;
  return row;
}

function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function toast(text, onUndo) {
  document.querySelector('.ss-toast')?.remove();
  const t = el('div', 'ss-toast');
  t.append(el('span', '', text));
  if (onUndo) t.append(button('Undo', () => { onUndo(); t.remove(); }, 'ss-small'));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// ---- helpers --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, className = '', disabled = false) {
  const b = el('button', `ss-button ${className}`, text);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function money(usd) {
  const n = Number(usd) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTokens(n) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
