// Runs on youtube.com. Gets the captions for the current video, hands them to
// the background worker for Jev, then draws the panel and does the skipping.

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
  error: null
};

// ---- lifecycle ------------------------------------------------------------

document.addEventListener('yt-navigate-finish', () => onNavigate());
window.addEventListener('load', () => onNavigate());
setInterval(() => {
  if (currentVideoId() !== state.videoId) onNavigate();
}, 1500);
onNavigate();

document.addEventListener('timeupdate', onTimeUpdate, true);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  state.settings = changes.settings.newValue;
  render();
});

function currentVideoId() {
  if (location.pathname !== '/watch') return null;
  return new URLSearchParams(location.search).get('v');
}

async function onNavigate() {
  const videoId = currentVideoId();
  if (videoId === state.videoId) return;

  state.videoId = videoId;
  state.analysis = null;
  state.error = null;
  state.skipped = new Set();
  state.paused = false;
  removeMarkers();

  if (!videoId) {
    document.getElementById(PANEL_ID)?.remove();
    return;
  }

  await refreshState();
  render();
  analyze(false);
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
  } finally {
    if (videoId === state.videoId) {
      state.busy = false;
      render();
    }
  }
}

/** Caption tracks from the live player first, then from the watch page HTML. */
async function getCaptions(videoId) {
  let tracks = null;
  let title = null;

  for (let attempt = 0; attempt < 6 && !tracks; attempt++) {
    const answer = await askPage();
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
  }

  const track = pickCaptionTrack(tracks ?? []);
  if (!track) throw new Error('This video has no captions, so there is no transcript to read.');

  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`YouTube captions responded ${response.status}.`);
  const text = await response.text();
  if (!text.trim()) throw new Error('YouTube returned an empty caption file.');

  const cues = parseJson3(JSON.parse(text));
  if (!cues.length) throw new Error('The caption file had no text in it.');
  return { cues, title: title ?? document.title.replace(/ - YouTube$/, '') };
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
  const key = 'ytInitialPlayerResponse';
  const at = html.indexOf(key);
  if (at < 0) return null;
  const open = html.indexOf('{', at);
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

function parseJson3(data) {
  const cues = [];
  for (const event of data?.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const startMs = Number(event.tStartMs ?? 0);
    cues.push({ text, startMs, endMs: startMs + Number(event.dDurationMs ?? 0) });
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
  if (!(video instanceof HTMLVideoElement) || !state.settings?.autoSkip || state.paused) return;

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
  const light = el('span', `ss-light ${state.busy ? 'busy' : state.error ? 'bad' : segments().length ? 'found' : 'idle'}`);
  h.append(light);
  const toggle = button(collapsed ? '▸' : '▾', () => {
    const panel = document.getElementById(PANEL_ID);
    panel.dataset.collapsed = collapsed ? 'false' : 'true';
    render();
  }, 'ss-icon');
  h.append(toggle);
  return h;
}

function body() {
  const b = el('div', 'ss-body');
  const segs = segments();

  if (state.busy) {
    b.append(el('div', 'ss-status', 'Reading the transcript and asking Jev…'));
  } else if (state.error) {
    b.append(el('div', 'ss-status ss-error', state.error));
  } else if (!state.analysis) {
    b.append(el('div', 'ss-status', 'Waiting for the video.'));
  } else if (!segs.length) {
    b.append(el('div', 'ss-status', 'No sponsor read found in this video.'));
  } else {
    b.append(el('div', 'ss-status', `${segs.length} sponsor read${segs.length > 1 ? 's' : ''} found${state.analysis.cached ? ' (cached)' : ''}`));
    segs.forEach((seg, index) => {
      const row = el('div', 'ss-segment');
      const range = seg.end ? `${stamp(seg.start.seconds)} – ${stamp(seg.end.seconds)}` : `${stamp(seg.start.seconds)} – ?`;
      row.append(el('span', 'ss-range', range));
      row.append(el('span', `ss-pill ${seg.confidence >= (state.settings?.threshold ?? 0.7) ? 'good' : 'warn'}`, `${Math.round(seg.confidence * 100)}%`));
      const video = document.querySelector('video');
      if (seg.end && video) {
        row.append(button(state.skipped.has(index) ? 'Skipped' : 'Skip', () => skipTo(video, seg, index, false), 'ss-small'));
      }
      b.append(row);
    });
  }

  // Controls
  const controls = el('div', 'ss-controls');
  const auto = el('label', 'ss-toggle');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = Boolean(state.settings?.autoSkip);
  box.addEventListener('change', async () => {
    const r = await send({ type: 'set-settings', settings: { autoSkip: box.checked } });
    if (r?.ok) state.settings = r.settings;
    render();
  });
  auto.append(box, document.createTextNode(state.paused ? 'Auto-skip (paused on this video)' : 'Auto-skip'));
  controls.append(auto);
  controls.append(button('Re-analyze', () => analyze(true), 'ss-small', state.busy));
  b.append(controls);

  // Stats
  const a = state.analysis;
  const s = state.stats;
  const stats = el('div', 'ss-stats');
  if (a) {
    stats.append(statRow('This video', `${fmtTokens(a.usage?.input_tokens)} tokens · ${a.requests ?? '?'} calls · ${money(a.cost)}${a.cached ? ' · cached' : ` · ${(a.elapsedMs / 1000).toFixed(1)}s`}`));
  }
  if (s) {
    stats.append(statRow('All time', `${s.videosAnalyzed} videos · ${fmtTokens(s.inputTokens)} tokens · ${money(s.estimatedCost)}`));
    stats.append(statRow('Skipped', `${s.skips} reads · ${stamp(s.secondsSkipped)} saved`));
  }
  b.append(stats);
  return b;
}

function statRow(label, value) {
  const row = el('div', 'ss-stat');
  row.append(el('span', 'ss-stat-label', label), el('span', 'ss-stat-value', value));
  return row;
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
