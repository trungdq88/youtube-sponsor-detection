const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function load() {
  const r = await send({ type: 'get-state' });
  if (!r?.ok) return;
  const { settings, stats, cachedVideos } = r;

  $('keyState').textContent = settings.apiKey ? `Key saved (…${settings.apiKey.slice(-6)})` : 'No key yet. Get one at typesafe.ai.';
  $('autoSkip').checked = settings.autoSkip;
  $('threshold').value = settings.threshold;
  $('thresholdOut').textContent = `${Math.round(settings.threshold * 100)}%`;
  $('model').value = settings.model;
  $('price').value = settings.pricePerMillionInput;

  $('mode').value = settings.mode ?? 'transcript';
  $('liveSettings').hidden = $('mode').value !== 'live';
  $('deepgramKeyState').textContent = settings.deepgramKey
    ? `Deepgram key saved (…${settings.deepgramKey.slice(-4)})`
    : 'No Deepgram key yet. Get one at console.deepgram.com.';
  $('liveSkipSeconds').value = settings.liveSkipSeconds ?? 10;
  $('sttPrice').value = settings.sttPricePerMinute ?? 0;
  if (!/^Could not start/.test($('liveState').textContent)) await showLiveState();

  const rows = [
    ['Videos analysed', stats.videosAnalyzed],
    ['Sponsor reads found', stats.sponsorsFound],
    ['Jev requests', stats.requests],
    ['Input tokens', stats.inputTokens.toLocaleString()],
    ['Output tokens (free)', stats.outputTokens.toLocaleString()],
    ['Estimated Jev cost', `$${stats.estimatedCost.toFixed(5)}`],
    ['Reads skipped', stats.skips],
    ['Time saved', stamp(stats.secondsSkipped)],
    ['Cached videos', cachedVideos],
    ['Live: audio streamed', stamp(stats.liveSeconds)],
    ['Live: speech cost', `$${(stats.estimatedSttCost ?? 0).toFixed(4)}`],
    ['Live: Jev checks', stats.liveChecks],
    ['Live: jumps', stats.liveSkips],
    ['Live: time skipped', stamp(stats.liveSecondsSkipped)]
  ];
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      const b = document.createElement('td');
      a.textContent = k;
      b.textContent = String(v);
      tr.append(a, b);
      return tr;
    })
  );
}

$('saveKey').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return;
  await send({ type: 'set-settings', settings: { apiKey } });
  $('apiKey').value = '';
  load();
});
$('autoSkip').addEventListener('change', (e) => send({ type: 'set-settings', settings: { autoSkip: e.target.checked } }));
$('threshold').addEventListener('input', (e) => {
  $('thresholdOut').textContent = `${Math.round(e.target.value * 100)}%`;
});
$('threshold').addEventListener('change', (e) => send({ type: 'set-settings', settings: { threshold: Number(e.target.value) } }));
$('model').addEventListener('change', (e) => send({ type: 'set-settings', settings: { model: e.target.value.trim() || 'jev-latest' } }));
$('price').addEventListener('change', (e) => send({ type: 'set-settings', settings: { pricePerMillionInput: Number(e.target.value) || 0 } }).then(load));
$('resetStats').addEventListener('click', () => send({ type: 'reset-stats' }).then(load));
$('clearCache').addEventListener('click', () => send({ type: 'clear-cache' }).then(load));

// ---- live mode ------------------------------------------------------------

async function showLiveState(note) {
  const r = await send({ type: 'live-state' });
  const live = r?.live ?? { active: false };
  const out = $('liveState');
  const toggle = $('liveToggle');
  if ($('mode').value !== 'live') {
    out.textContent = '';
    return;
  }
  toggle.textContent = live.active ? 'Stop listening' : 'Start listening in this tab';
  if (note) {
    out.textContent = note;
  } else if (live.active) {
    const where = live.title ? ` "${live.title}"` : '';
    out.textContent = live.state === 'listening' ? `Listening to the tab${where}.` : `Starting to listen${where}…`;
  } else if (live.state === 'error' && live.error) {
    out.textContent = `Stopped: ${live.error}`;
  } else {
    out.textContent = 'Not listening. It starts by itself when a YouTube video plays; this button starts it now.';
  }
}

/** Same as the panel's button: the page in the active tab does the capturing. */
async function startLiveOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  const r = await send({ type: 'live-start', tabId: tab.id });
  if (!r?.ok) throw new Error(r?.error ?? 'Could not start.');
}

$('mode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  $('liveSettings').hidden = mode !== 'live';
  await send({ type: 'set-settings', settings: { mode } });
  if (mode === 'live') {
    await startOrExplain();
  } else {
    await send({ type: 'live-stop' });
  }
  load();
});

$('liveToggle').addEventListener('click', async () => {
  const r = await send({ type: 'live-state' });
  if (r?.live?.active) {
    await send({ type: 'live-stop' });
    load();
  } else {
    await startOrExplain();
    load();
  }
});

/** Start on the active tab; when that fails, keep the reason on screen. */
async function startOrExplain() {
  try {
    await startLiveOnActiveTab();
  } catch (error) {
    await send({ type: 'live-failed', error: error.message });
    await showLiveState(`Could not start listening: ${error.message}`);
    return false;
  }
  return true;
}
$('saveDeepgramKey').addEventListener('click', async () => {
  const deepgramKey = $('deepgramKey').value.trim();
  if (!deepgramKey) return;
  await send({ type: 'set-settings', settings: { deepgramKey } });
  $('deepgramKey').value = '';
  load();
});
$('liveSkipSeconds').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { liveSkipSeconds: Math.max(5, Number(e.target.value) || 10) } }).then(load)
);
$('sttPrice').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { sttPricePerMinute: Number(e.target.value) || 0 } }).then(load)
);

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

load();
