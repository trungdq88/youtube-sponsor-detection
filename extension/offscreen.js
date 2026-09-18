// Offscreen document for live mode. Manifest V3 service workers cannot hold
// a media stream, so this page does: it takes the tab's audio, plays it back
// so the viewer still hears the video, feeds 16 kHz PCM to the speech API's
// socket, and forwards each transcript to the background worker with the
// wall-clock time that audio played at.

let capture = null; // { tabId, stream, contexts, provider, timers }

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
    case 'live-capture-stop':
      return stop();
    case 'live-capture-state':
      return { active: Boolean(capture), tabId: capture?.tabId ?? null };
    default:
      throw new Error(`unknown offscreen message ${message.type}`);
  }
}

function report(message) {
  chrome.runtime.sendMessage(message).catch?.(() => {});
}

async function start({ tabId, streamId, provider, key, model, language }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  // Capturing a tab silences it for the viewer; play the stream back so it stays audible.
  const playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);

  // A second context at 16 kHz does the resampling for the speech API.
  const analysis = new AudioContext({ sampleRate: 16000 });
  await analysis.audioWorklet.addModule('pcm-worklet.js');
  const worklet = new AudioWorkletNode(analysis, 'pcm-capture');
  analysis.createMediaStreamSource(stream).connect(worklet);

  const status = (state, extra = {}) => report({ type: 'live-status', tabId, state, ...extra });
  const session = PROVIDERS[provider ?? 'deepgram'];
  if (!session) throw new Error(`unknown speech provider ${provider}`);

  let base = 0; // epoch ms when the first audio sample went out: stream second 0
  let sentSamples = 0;
  let reportedSeconds = 0;
  const socket = session.open({
    key,
    model,
    language,
    onOpen: () => status('listening'),
    onTranscript: ({ text, isFinal, start, duration }) => {
      if (!base) return;
      report({
        type: 'live-transcript',
        tabId,
        text,
        isFinal,
        heardAt: base + start * 1000,
        heardUntil: base + (start + duration) * 1000
      });
    },
    onError: (error) => status('error', { error })
  });

  worklet.port.onmessage = ({ data }) => {
    if (!base) base = Date.now();
    sentSamples += data.byteLength / 2;
    socket.send(data);
  };

  const progress = setInterval(() => {
    const seconds = sentSamples / 16000;
    const delta = seconds - reportedSeconds;
    reportedSeconds = seconds;
    if (delta > 0) report({ type: 'live-audio-progress', tabId, seconds: delta });
  }, 10000);

  const [track] = stream.getAudioTracks();
  track.addEventListener('ended', () => {
    stop().then(() => status('ended'));
  });

  capture = { tabId, stream, contexts: [playback, analysis], socket, timers: [progress], track };
  status('connecting');
  return { tabId };
}

async function stop() {
  if (!capture) return { active: false };
  const c = capture;
  capture = null;
  c.timers.forEach(clearInterval);
  try { c.socket.close(); } catch {}
  c.stream.getTracks().forEach((t) => t.stop());
  await Promise.all(c.contexts.map((ctx) => ctx.close().catch(() => {})));
  return { active: false };
}

// ---- speech providers -----------------------------------------------------
//
// Each provider opens a socket that takes 16 kHz mono 16-bit PCM and calls
// back with utterances timed in seconds from the start of the stream. Adding
// another low-latency API means adding an entry here.

const PROVIDERS = {
  deepgram: {
    open({ key, model, language, onOpen, onTranscript, onError }) {
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
