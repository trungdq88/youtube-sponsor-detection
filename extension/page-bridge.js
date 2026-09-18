// Runs in the page's own world, where YouTube's player object lives. The
// content script cannot see it, so it asks here and gets the caption tracks
// for the video that is actually playing (not a stale one after SPA navigation).

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'sponsor-skip:get-captions') return;

  let tracks = null;
  let videoId = null;
  let title = null;
  let innertube = null;
  try {
    const player = document.getElementById('movie_player');
    const response = player?.getPlayerResponse?.();
    tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
    videoId = response?.videoDetails?.videoId ?? null;
    title = response?.videoDetails?.title ?? null;
    const cfg = window.ytcfg?.get ? window.ytcfg : null;
    const context = cfg?.get('INNERTUBE_CONTEXT') ?? null;
    if (context) innertube = { apiKey: cfg.get('INNERTUBE_API_KEY') ?? null, context };
  } catch {
    // fall through; the content script has a fallback
  }

  window.postMessage(
    {
      type: 'sponsor-skip:captions',
      requestId: event.data.requestId,
      videoId,
      title,
      innertube: innertube ? JSON.parse(JSON.stringify(innertube)) : null,
      tracks: tracks ? JSON.parse(JSON.stringify(tracks)) : null
    },
    '*'
  );
});

(() => {
// The transcript panel, fetched the way the page's own "Show transcript"
// button fetches it: same InnerTube context, cookies, and the signed
// Authorization header YouTube expects when a Google session is present.
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.data?.type !== 'sponsor-skip:get-transcript') return;
  const { requestId, videoId } = event.data;
  let segments = null;
  let error = null;
  try {
    const next = await innertube('next', { videoId });
    const params = findKey(next, 'getTranscriptEndpoint')?.params;
    if (!params) throw new Error('no transcript panel for this video');
    const data = await innertube('get_transcript', { params });
    segments = findKey(data, 'transcriptSegmentListRenderer')?.initialSegments ?? [];
  } catch (err) {
    error = err?.message ?? String(err);
  }
  window.postMessage({ type: 'sponsor-skip:transcript', requestId, segments, error }, '*');
});

async function innertube(endpoint, body) {
  const cfg = window.ytcfg?.get ? window.ytcfg : null;
  const context = cfg?.get('INNERTUBE_CONTEXT');
  if (!context) throw new Error('page config not available');
  const url = new URL(`https://www.youtube.com/youtubei/v1/${endpoint}`);
  url.searchParams.set('prettyPrint', 'false');
  const key = cfg.get('INNERTUBE_API_KEY');
  if (key) url.searchParams.set('key', key);

  const headers = {
    'content-type': 'application/json',
    'x-origin': 'https://www.youtube.com',
    'x-youtube-client-name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
    'x-youtube-client-version': String(cfg.get('INNERTUBE_CLIENT_VERSION') ?? context.client?.clientVersion ?? ''),
    'x-goog-authuser': String(cfg.get('SESSION_INDEX') ?? 0)
  };
  const visitor = cfg.get('VISITOR_DATA');
  if (visitor) headers['x-goog-visitor-id'] = visitor;
  const auth = await sapisidHash();
  if (auth) headers.authorization = auth;

  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ context, ...body })
  });
  if (!response.ok) throw new Error(`${endpoint} responded ${response.status}`);
  return response.json();
}

/** The Authorization header YouTube's own requests carry when signed in. */
async function sapisidHash() {
  const cookie = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/)?.[1];
  if (!cookie || !crypto?.subtle) return null;
  const ts = Math.floor(Date.now() / 1000);
  const bytes = new TextEncoder().encode(`${ts} ${cookie} https://www.youtube.com`);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

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
})();
