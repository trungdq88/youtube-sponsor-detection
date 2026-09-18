// Runs in the page's own world, where YouTube's player object lives. The
// content script cannot see it, so it asks here and gets the caption tracks
// for the video that is actually playing (not a stale one after SPA navigation).

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'sponsor-skip:get-captions') return;

  let tracks = null;
  let videoId = null;
  let title = null;
  try {
    const player = document.getElementById('movie_player');
    const response = player?.getPlayerResponse?.();
    tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
    videoId = response?.videoDetails?.videoId ?? null;
    title = response?.videoDetails?.title ?? null;
  } catch {
    // fall through; the content script has a fallback
  }

  window.postMessage(
    {
      type: 'sponsor-skip:captions',
      requestId: event.data.requestId,
      videoId,
      title,
      tracks: tracks ? JSON.parse(JSON.stringify(tracks)) : null
    },
    '*'
  );
});
