const $ = (id) => document.getElementById(id);
const form = $('form');
const urlInput = $('url');
const goButton = $('go');
const pasteBox = $('paste-box');
const banner = $('banner');
const statusEl = $('status');
const resultEl = $('result');

pasteBox.hidden = true;

$('toggle-paste').addEventListener('click', () => {
  pasteBox.hidden = !pasteBox.hidden;
  if (!pasteBox.hidden) {
    pasteBox.open = true;
    $('transcript').focus();
  }
});

$('demo').addEventListener('click', () => {
  urlInput.value = '';
  $('transcript').value = '';
  analyze({ url: 'demo' });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const transcript = $('transcript').value.trim();
  analyze({ url: urlInput.value.trim(), transcript: transcript || undefined });
});

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    if (!h.typesafeKey) show(banner, 'error', 'No TypeSafe API key on the server. Set TYPESAFE_API_KEY in .env and restart.');
  })
  .catch(() => {});

async function analyze(body) {
  banner.hidden = true;
  resultEl.hidden = true;
  goButton.disabled = true;
  show(statusEl, '', 'Fetching the transcript and asking Jev…');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    statusEl.hidden = true;

    if (!response.ok) {
      show(banner, 'error', data.detail ? `${data.error ?? 'That did not work.'} (${data.detail})` : data.error ?? 'That did not work.');
      if (data.canPaste) {
        pasteBox.hidden = false;
        pasteBox.open = true;
      }
      return;
    }
    render(data);
  } catch (error) {
    statusEl.hidden = true;
    show(banner, 'error', `Could not reach the server: ${error.message}`);
  } finally {
    goButton.disabled = false;
  }
}

function show(el, cls, text) {
  el.className = el === banner ? `banner ${cls}` : `status ${cls}`;
  el.textContent = text;
  el.hidden = false;
}

function render(data) {
  const { result, video, transcript, elapsedMs } = data;
  resultEl.innerHTML = '';
  resultEl.hidden = false;

  const card = el('div', 'card');

  if (result.status === 'not-found' || result.status === 'no-transcript') {
    card.append(
      el('div', 'verdict', [el('div', 'stamp', 'None'), el('div', 'verdict-label', 'Jev found no sponsor read in this video.')])
    );
    resultEl.append(card, windowsPanel(result), metaLine(video, transcript, result, elapsedMs));
    return;
  }

  const segments = result.segments ?? [];
  const plural = segments.length > 1;
  card.append(
    el('div', 'verdict', [
      el('div', 'stamp', segments.map((s) => s.start.timestamp).join('  ·  ')),
      el('div', 'verdict-label', plural ? `${segments.length} sponsor reads found` : 'is where the sponsor read starts')
    ])
  );

  for (const seg of segments) {
    const confident = seg.confidence >= 0.7;
    const line = el('div', 'segment');
    const range = seg.end
      ? `${seg.start.timestamp} – ${seg.end.timestamp}, about ${Math.round(seg.end.seconds - seg.start.seconds)} seconds`
      : `${seg.start.timestamp}, end not pinned down`;
    line.append(el('span', '', range), el('span', `pill ${confident ? 'good' : 'warn'}`, `${(seg.confidence * 100).toFixed(0)}% confident`));
    if (video.id) {
      const actions = el('span', 'actions inline');
      actions.append(link(`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(seg.start.seconds)}s`, 'Open here'));
      if (seg.end) actions.append(link(`https://www.youtube.com/watch?v=${video.id}&t=${Math.ceil(seg.end.seconds)}s`, 'Skip past it'));
      line.append(actions);
    }
    card.append(line);
  }

  if (video.id) {
    const frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.allow = 'accelerometer; encrypted-media; picture-in-picture';
    frame.src = `https://www.youtube-nocookie.com/embed/${video.id}?start=${Math.floor(segments[0].start.seconds)}`;
    card.append(frame);
  }

  resultEl.append(card);
  for (const seg of segments) resultEl.append(contextPanel(seg, plural));
  resultEl.append(windowsPanel(result));
  resultEl.append(metaLine(video, transcript, result, elapsedMs));
}

function contextPanel(result, plural) {
  const wrap = document.createElement('div');
  wrap.append(el('h2', '', plural ? `Around the read at ${result.start.timestamp}` : 'Around the boundary'));
  const box = el('div', 'lines');

  const from = result.start.seconds - 45;
  const to = (result.end?.seconds ?? result.start.seconds + 120) + 30;
  for (const line of (result.context ?? []).filter((l) => l.end >= from && l.start <= to)) {
    const isStart = line.id === result.start.lineId;
    const inside = line.start >= result.start.seconds && (!result.end || line.end <= result.end.seconds + 0.01);
    const row = el('div', isStart ? 'start' : inside ? 'in' : '');
    row.append(el('span', 't', timestamp(line.start)), el('span', '', line.text));
    box.append(row);
  }
  wrap.append(box);
  return wrap;
}

function windowsPanel(result) {
  const wrap = document.createElement('div');
  wrap.append(el('h2', '', 'What Jev returned'));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Part of the video</th><th>“A sponsor read begins here”</th><th>Top line</th></tr></thead>';
  const body = document.createElement('tbody');

  for (const w of result.windows ?? []) {
    const tr = document.createElement('tr');
    const bar = el('span', 'bar');
    bar.append(Object.assign(document.createElement('span'), { style: `width:${(w.presence * 100).toFixed(0)}%` }));
    const prob = el('td', 'num');
    prob.append(bar, document.createTextNode(` ${w.presence.toFixed(2)}`));
    tr.append(el('td', '', `${w.fromTimestamp} – ${w.toTimestamp}`), prob, el('td', 'num', w.startLineId ? `${w.startLineId} (${w.startLineProbability.toFixed(2)})` : '—'));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function metaLine(video, transcript, result, elapsedMs) {
  const footer = el('footer', 'meta');
  const bits = [
    video.title,
    `${transcript.lines} transcript lines`,
    `${Math.round(result.usage.input_tokens ?? 0).toLocaleString()} input tokens`,
    `${(elapsedMs / 1000).toFixed(1)}s`
  ].filter(Boolean);
  footer.textContent = bits.join(' · ');
  return footer;
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else if (Array.isArray(content)) node.append(...content);
  return node;
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
