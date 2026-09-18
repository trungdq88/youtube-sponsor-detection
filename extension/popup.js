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

  const rows = [
    ['Videos analysed', stats.videosAnalyzed],
    ['Sponsor reads found', stats.sponsorsFound],
    ['Jev requests', stats.requests],
    ['Input tokens', stats.inputTokens.toLocaleString()],
    ['Output tokens (free)', stats.outputTokens.toLocaleString()],
    ['Estimated Jev cost', `$${stats.estimatedCost.toFixed(5)}`],
    ['Reads skipped', stats.skips],
    ['Time saved', stamp(stats.secondsSkipped)],
    ['Cached videos', cachedVideos]
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

function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

load();
