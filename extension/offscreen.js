// Offscreen document for live mode. It holds the speech API's socket, which
// a service worker cannot keep open. The audio itself is captured on the
// page (content.js, from the <video> element), relayed here in 100 ms chunks
// by the background worker, and each transcript goes back with the
// wall-clock time that audio played at.

let session = null; // { tabId, socket, base, sentSamples, reportedSeconds, timer }

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  run(message)
    .then((data) => sendResponse({ ok: true, ...(data ?? {}) }))
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));
  return true;
});

async function run(message) {
  switch (message.type) {
    case 'live-capture-start':
      await stop();
      return start(message);
    case 'live-audio':
      return feed(message);
    case 'live-capture-stop':
      return stop();
    case 'live-capture-state':
      return { active: Boolean(session), tabId: session?.tabId ?? null };
    default:
      throw new Error(`unknown offscreen message ${message.type}`);
  }
}

function report(message) {
  chrome.runtime.sendMessage(message).catch?.(() => {});
}

async function start({ tabId, provider, key, model, language }) {
  const status = (state, extra = {}) => report({ type: 'live-status', tabId, state, ...extra });
  const log = (text) => report({ type: 'live-log', tabId, text });
  const impl = PROVIDERS[provider ?? 'deepgram'];
  if (!impl) throw new Error(`unknown speech provider ${provider}`);

  const s = { tabId, base: 0, sentSamples: 0, reportedSeconds: 0, socket: null, timer: null };
  s.socket = impl.open({
    key,
    model,
    language,
    onOpen: () => status('listening'),
    onLog: log,
    onTranscript: ({ text, isFinal, start, duration }) => {
      if (!s.base) return;
      report({
        type: 'live-transcript',
        tabId,
        text,
        isFinal,
        heardAt: s.base + start * 1000,
        heardUntil: s.base + (start + duration) * 1000
      });
    },
    onError: (error) => status('error', { error })
  });
  s.timer = setInterval(() => {
    const seconds = s.sentSamples / 16000;
    const delta = seconds - s.reportedSeconds;
    s.reportedSeconds = seconds;
    if (delta > 0) report({ type: 'live-audio-progress', tabId, seconds: delta });
  }, 10000);
  session = s;
  status('connecting');
  log(`Connecting to ${provider ?? 'deepgram'} ${model || ''}`.trim());
  return { tabId };
}

/** One chunk of 16 kHz PCM from the page, base64 because ports carry JSON. */
function feed({ tabId, pcm }) {
  if (!session || session.tabId !== tabId) return {};
  const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  if (!session.base) session.base = Date.now();
  session.sentSamples += bytes.length / 2;
  session.socket.send(bytes.buffer);
  return {};
}

async function stop() {
  if (!session) return { active: false };
  const s = session;
  session = null;
  clearInterval(s.timer);
  try { s.socket.close(); } catch {}
  return { active: false };
}

// ---- speech providers -----------------------------------------------------
//
// Each provider opens a socket that takes 16 kHz mono 16-bit PCM and calls
// back with utterances timed in seconds from the start of the stream. Adding
// another low-latency API means adding an entry here.

const PROVIDERS = {
  deepgram: {
    open({ key, model, language, onOpen, onTranscript, onError, onLog }) {
      if (!key) throw new Error('No Deepgram API key. Add one in the extension popup.');
      const url = new URL('wss://api.deepgram.com/v1/listen');
      url.searchParams.set('model', model || 'nova-3');
      url.searchParams.set('language', language || 'en');
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', '16000');
      url.searchParams.set('channels', '1');
      url.searchParams.set('interim_results', 'true');
      url.searchParams.set('smart_format', 'true');
      url.searchParams.set('endpointing', '300');

      let ws = null;
      let closed = false;
      let attempts = 0;
      let keepAlive = null;
      const queue = [];

      const connect = () => {
        ws = new WebSocket(url, ['token', key]);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          onLog?.('Deepgram socket open, streaming 16 kHz audio');
          attempts = 0;
          while (queue.length) ws.send(queue.shift());
          keepAlive = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'KeepAlive' })), 5000);
          onOpen();
        };
        ws.onmessage = (event) => {
          let m;
          try { m = JSON.parse(event.data); } catch { return; }
          if (m.type !== 'Results') return;
          const text = m.channel?.alternatives?.[0]?.transcript ?? '';
          if (!text.trim()) return;
          onTranscript({ text, isFinal: Boolean(m.is_final), start: Number(m.start) || 0, duration: Number(m.duration) || 0 });
        };
        ws.onclose = (event) => {
          clearInterval(keepAlive);
          if (closed) return;
          onLog?.(`Deepgram socket closed (code ${event.code}${event.reason ? `, ${event.reason}` : ''})`);
          if (event.code === 1008 || event.code === 4001 || /401|403/.test(event.reason ?? '')) {
            onError('Deepgram rejected the API key.');
            closed = true;
            return;
          }
          if (attempts >= 5) {
            onError(`Deepgram connection lost (code ${event.code}).`);
            closed = true;
            return;
          }
          attempts += 1;
          onLog?.(`Reconnecting to Deepgram, attempt ${attempts}`);
          setTimeout(connect, 500 * 2 ** attempts);
        };
        ws.onerror = () => {};
      };
      connect();

      return {
        send(buffer) {
          if (closed) return;
          if (ws?.readyState === 1) ws.send(buffer);
          else if (queue.length < 50) queue.push(buffer); // ~5 s while reconnecting
        },
        close() {
          closed = true;
          clearInterval(keepAlive);
          if (ws?.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
          }
          ws?.close();
        }
      };
    }
  }
};
