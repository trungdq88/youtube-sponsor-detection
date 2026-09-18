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
  await showLiveState();

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

async function showLiveState() {
  const r = await send({ type: 'live-state' });
  const live = r?.live ?? { active: false };
  const out = $('liveState');
  if ($('mode').value !== 'live') {
    out.textContent = '';
    return;
  }
  if (live.active) {
    const where = live.title ? ` "${live.title}"` : '';
    out.textContent = live.state === 'listening' ? `Listening to the tab${where}.` : `Starting to listen${where}…`;
  } else if (live.state === 'error') {
    out.textContent = `Stopped: ${live.error}`;
  } else {
    out.textContent = 'Not listening. Open the YouTube tab, then pick Live audio again to start.';
  }
}

/**
 * Starting a capture needs the user's click, so it happens here: the popup
 * asks Chrome for a stream id for the active tab and hands it to the worker.
 */
async function startLiveOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  if (!/^https:\/\/www\.youtube\.com\//.test(tab.url ?? '')) {
    throw new Error('Open a YouTube video in this tab first.');
  }
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
  const r = await send({ type: 'live-start', tabId: tab.id, streamId, title: tab.title ?? '' });
  if (!r?.ok) throw new Error(r?.error ?? 'Could not start.');
}

$('mode').addEventListener('change', async (e) => {
  const mode = e.target.value;
  $('liveSettings').hidden = mode !== 'live';
  if (mode === 'live') {
    try {
      await startLiveOnActiveTab();
    } catch (error) {
      await send({ type: 'set-settings', settings: { mode: 'live' } });
      $('liveState').textContent = `Could not start listening: ${error.message}`;
      load();
      return;
    }
  } else {
    await send({ type: 'live-stop' });
    await send({ type: 'set-settings', settings: { mode: 'transcript' } });
  }
  load();
});
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
