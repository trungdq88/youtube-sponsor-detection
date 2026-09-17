// Getting a transcript, and getting a video ID out of whatever gets pasted.

import { Innertube } from 'youtubei.js';

/** @typedef {import('./transcript.js').Cue} Cue */

/**
 * Accepts a full URL, a share link, an embed link, or a bare ID.
 * @param {string} input
 * @returns {string|null}
 */
export function parseVideoId(input) {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return clean(url.pathname.slice(1));
  if (!/(^|\.)youtube\.com$/.test(host) && host !== 'youtube-nocookie.com') return null;

  const v = url.searchParams.get('v');
  if (v) return clean(v);

  const path = url.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'live', 'v'].includes(path[0])) return clean(path[1]);
  return null;
}

function clean(id) {
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

let innertube;

/**
 * Fetch a video's transcript from YouTube.
 *
 * Two routes, tried in order, because neither is reliable on its own:
 *  1. the caption tracks in the player response, fetched as json3 (the same
 *     files the player uses for subtitles);
 *  2. the transcript panel behind YouTube's own "Show transcript" button.
 *
 * @param {string} videoId
 * @returns {Promise<{ title: string, cues: Cue[] }>}
 */
export async function fetchTranscript(videoId) {
  innertube ??= await Innertube.create({ generate_session_locally: true });

  const info = await innertube.getInfo(videoId);
  const title = info.basic_info?.title ?? videoId;
  const failures = [];

  for (const client of ['WEB', 'ANDROID']) {
    try {
      const source = client === 'WEB' ? info : await innertube.getBasicInfo(videoId, { client });
      const track = pickCaptionTrack(source.captions?.caption_tracks ?? []);
      if (!track) throw new Error(`no caption tracks in the ${client} player response`);
      const cues = await fetchCaptionTrack(track.base_url);
      if (cues.length) return { title, cues };
      throw new Error(`caption track "${track.language_code}" came back empty`);
    } catch (error) {
      failures.push(`captions via ${client}: ${error.message}`);
    }
  }

  try {
    const transcript = await info.getTranscript();
    const segments = transcript?.transcript?.content?.body?.initial_segments ?? [];
    const cues = segments
      .filter((s) => s.start_ms !== undefined && s.snippet)
      .map((s) => ({
        text: s.snippet.text ?? '',
        startMs: Number(s.start_ms),
        endMs: Number(s.end_ms ?? s.start_ms)
      }))
      .filter((c) => c.text.trim() && Number.isFinite(c.startMs));
    if (cues.length) return { title, cues };
    failures.push('transcript panel: no segments');
  } catch (error) {
    failures.push(`transcript panel: ${error.message}`);
  }

  throw new TranscriptUnavailable(
    'YouTube returned no transcript for this video. It may have captions turned off.',
    { cause: failures.join(' | ') }
  );
}

/** Prefer a human-made English track, then auto-generated English, then whatever is first. */
export function pickCaptionTrack(tracks) {
  if (!tracks.length) return null;
  const english = tracks.filter((t) => /^en\b/i.test(t.language_code ?? ''));
  return english.find((t) => t.kind !== 'asr') ?? english[0] ?? tracks[0];
}

async function fetchCaptionTrack(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`timedtext responded ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('timedtext responded with an empty body');
  return parseJson3(JSON.parse(body));
}

/**
 * Parse YouTube's json3 caption format into cues.
 * @param {{ events?: { tStartMs?: number, dDurationMs?: number, segs?: { utf8?: string }[] }[] }} data
 * @returns {Cue[]}
 */
export function parseJson3(data) {
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

export class TranscriptUnavailable extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TranscriptUnavailable';
  }
}

/**
 * Parse a transcript pasted from YouTube's own "Show transcript" panel:
 * a timestamp line followed by text, or "0:42 text" on one line.
 * Untimed text still works; it just gets evenly spaced seconds.
 * @param {string} text
 * @returns {Cue[]}
 */
export function parsePastedTranscript(text) {
  const rows = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  /** @type {Cue[]} */
  const cues = [];
  let pending = null;

  for (const row of rows) {
    const inline = row.match(/^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?\s+(.*)$/);
    const alone = row.match(/^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\])?$/);

    if (alone) {
      pending = toSeconds(alone[1]);
    } else if (inline) {
      push(cues, toSeconds(inline[1]), inline[2]);
      pending = null;
    } else if (pending !== null) {
      push(cues, pending, row);
      pending = null;
    } else {
      push(cues, null, row);
    }
  }

  // Fill in times for untimed rows so lines still carry a position.
  const APPROX_SECONDS_PER_ROW = 4;
  cues.forEach((cue, i) => {
    if (cue.startMs === null) cue.startMs = i * APPROX_SECONDS_PER_ROW * 1000;
  });
  cues.forEach((cue, i) => {
    cue.endMs = cues[i + 1]?.startMs ?? cue.startMs + APPROX_SECONDS_PER_ROW * 1000;
  });
  return cues;
}

function push(cues, seconds, text) {
  if (!text.trim()) return;
  cues.push({ text: text.trim(), startMs: seconds === null ? null : seconds * 1000, endMs: 0 });
}

function toSeconds(stamp) {
  const parts = stamp.split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}
