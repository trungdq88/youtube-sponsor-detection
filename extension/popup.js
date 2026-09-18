const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

const MODE_HINTS = {
  smart: 'Needs both keys. A read is skipped to its end once the audio agrees with the transcript, so nothing real is cut. Without a transcript it falls back to listening; without audio it skips from the transcript alone.',
  transcript: 'Needs only the TypeSafe key. Reads are skipped from the transcript, cut at the phrase Jev is sure of.',
  live: 'Needs both keys. The first ten seconds or so of every read are heard before the first jump, and listening costs speech minutes for the whole video.'
};

async function load() {
  const r = await send({ type: 'get-state' });
  if (!r?.ok) return;
  const { settings, stats, cachedVideos } = r;

  // Keys
  keyState($('keyState'), settings.apiKey, 'TypeSafe');
  keyState($('deepgramKeyState'), settings.deepgramKey, 'Deepgram');

  // Mode
  const mode = settings.mode ?? 'transcript';
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === mode;
  $('modeHint').textContent = MODE_HINTS[mode] ?? '';
  $('stepField').hidden = mode === 'transcript';

  // Skipping
  $('autoSkip').checked = settings.autoSkip;
  $('threshold').value = settings.threshold;
  $('thresholdOut').textContent = `${Math.round(settings.threshold * 100)}%`;
  $('liveSkipSeconds').value = settings.liveSkipSeconds ?? 10;

  // Advanced
  $('model').value = settings.model;
  $('price').value = settings.pricePerMillionInput;
  $('sttPrice').value = settings.sttPricePerMinute ?? 0;

  // Usage
  const totalCost = (stats.estimatedCost ?? 0) + (stats.estimatedSttCost ?? 0);
  const saved = (stats.secondsSkipped ?? 0) + (stats.liveSecondsSkipped ?? 0);
  tiles([
    [stamp(saved), 'time saved'],
    [String((stats.skips ?? 0) + (stats.liveSkips ?? 0)), 'skips'],
    [`$${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}`, 'spent, est.']
  ]);
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
    ['Audio streamed', stamp(stats.liveSeconds)],
    ['Speech cost', `$${(stats.estimatedSttCost ?? 0).toFixed(4)}`],
    ['Audio checks with Jev', stats.liveChecks],
    ['Jumps by ear', stats.liveSkips],
    ['Time saved by ear', stamp(stats.liveSecondsSkipped)]
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

  await showStatus(settings);
}

function keyState(node, key, name) {
  node.textContent = key ? `saved …${key.slice(-4)}` : 'missing';
  node.className = `key-state ${key ? 'ok' : 'missing'}`;
  node.title = key ? `${name} key saved in this browser` : `Paste a ${name} key below`;
}

function tiles(items) {
  $('tiles').replaceChildren(
    ...items.map(([value, label]) => {
      const t = document.createElement('div');
      t.className = 'tile';
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      t.append(b, s);
      return t;
    })
  );
}

/** The pill top right and the line under Advanced. */
async function showStatus(settings, note) {
  const r = await send({ type: 'live-state' });
  const live = r?.live ?? { active: false };
  const mode = settings.mode ?? 'transcript';
  const pill = $('statusPill');
  const needsDeepgram = mode !== 'transcript' && !settings.deepgramKey;

  if (!settings.apiKey) {
    pill.textContent = 'needs TypeSafe key';
    pill.className = 'pill bad';
  } else if (needsDeepgram) {
    pill.textContent = 'needs Deepgram key';
    pill.className = 'pill bad';
  } else if (live.active) {
    pill.textContent = live.state === 'listening' ? 'listening' : 'connecting…';
    pill.className = `pill ${live.state === 'listening' ? 'on' : 'busy'}`;
  } else if (live.state === 'error' && live.error) {
    pill.textContent = 'audio stopped';
    pill.className = 'pill bad';
    pill.title = live.error;
  } else {
    pill.textContent = { smart: 'smart mode', transcript: 'transcript mode', live: 'listen mode' }[mode] ?? mode;
    pill.className = 'pill';
  }

  const out = $('liveState');
  const toggle = $('liveToggle');
  toggle.hidden = mode === 'transcript';
  toggle.textContent = live.active ? 'Stop listening' : 'Start listening in this tab';
  if (note) out.textContent = note;
  else if (mode === 'transcript') out.textContent = '';
  else if (live.active) out.textContent = `Listening in "${live.title || 'the video tab'}".`;
  else if (live.state === 'error' && live.error) out.textContent = `Audio stopped: ${live.error}`;
  else out.textContent = 'Audio starts by itself when a video plays. This button starts it now.';
}

// ---- events ---------------------------------------------------------------

$('modes').addEventListener('change', async (e) => {
  if (e.target.name !== 'mode') return;
  const mode = e.target.value;
  const r = await send({ type: 'set-settings', settings: { mode } });
  if (mode === 'transcript') await send({ type: 'live-stop' });
  load();
  if (r?.ok && mode !== 'transcript' && !r.settings.deepgramKey) $('deepgramKey').focus();
});

$('saveKey').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return;
  await send({ type: 'set-settings', settings: { apiKey } });
  $('apiKey').value = '';
  load();
});
$('saveDeepgramKey').addEventListener('click', async () => {
  const deepgramKey = $('deepgramKey').value.trim();
  if (!deepgramKey) return;
  await send({ type: 'set-settings', settings: { deepgramKey } });
  $('deepgramKey').value = '';
  load();
});
for (const id of ['apiKey', 'deepgramKey']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $(id === 'apiKey' ? 'saveKey' : 'saveDeepgramKey').click();
  });
}

$('autoSkip').addEventListener('change', (e) => send({ type: 'set-settings', settings: { autoSkip: e.target.checked } }));
$('threshold').addEventListener('input', (e) => {
  $('thresholdOut').textContent = `${Math.round(e.target.value * 100)}%`;
});
$('threshold').addEventListener('change', (e) => send({ type: 'set-settings', settings: { threshold: Number(e.target.value) } }));
$('liveSkipSeconds').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { liveSkipSeconds: Math.max(5, Number(e.target.value) || 10) } }).then(load)
);
$('model').addEventListener('change', (e) => send({ type: 'set-settings', settings: { model: e.target.value.trim() || 'jev-latest' } }));
$('price').addEventListener('change', (e) => send({ type: 'set-settings', settings: { pricePerMillionInput: Number(e.target.value) || 0 } }).then(load));
$('sttPrice').addEventListener('change', (e) =>
  send({ type: 'set-settings', settings: { sttPricePerMinute: Number(e.target.value) || 0 } }).then(load)
);
$('resetStats').addEventListener('click', () => send({ type: 'reset-stats' }).then(load));
$('clearCache').addEventListener('click', () => send({ type: 'clear-cache' }).then(load));

$('liveToggle').addEventListener('click', async () => {
  const r = await send({ type: 'live-state' });
  if (r?.live?.active) {
    await send({ type: 'live-stop' });
    load();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const started = tab ? await send({ type: 'live-start', tabId: tab.id }) : { ok: false, error: 'No active tab.' };
  const state = await send({ type: 'get-state' });
  if (started?.ok) load();
  else await showStatus(state.settings, `Could not start: ${started?.error ?? 'unknown error'}`);
});

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

load();
