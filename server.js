// Sponsor-skip demo server. The API key stays here, server-side: the browser
// only ever talks to this process.

import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TypeSafeClient } from '@typesafe-ai/sdk';

import { parseVideoId, fetchTranscript, parsePastedTranscript, TranscriptUnavailable } from './src/youtube.js';
import { buildLines, formatTimestamp } from './src/transcript.js';
import { findSponsorSegment } from './src/jev.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(here, 'public')));

const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
// One client for the process: it holds the key, retry policy and timeouts.
const client = hasKey ? new TypeSafeClient({ timeout: 30_000 }) : null;

app.get('/api/health', (_req, res) => {
  res.json({ typesafeKey: hasKey });
});

app.post('/api/analyze', async (req, res) => {
  const { url, transcript } = req.body ?? {};

  if (!hasKey) {
    return res.status(503).json({
      error: 'No TYPESAFE_API_KEY set. Put your TypeSafe key in .env and restart the server.'
    });
  }

  try {
    const source = await loadTranscript({ url, transcript });
    const lines = buildLines(source.cues);
    if (!lines.length) return res.status(422).json({ error: 'That transcript came back empty.' });

    const started = Date.now();
    const result = await findSponsorSegment(lines, { client });

    res.json({
      video: { id: source.videoId, title: source.title, source: source.kind },
      transcript: { lines: lines.length, seconds: lines[lines.length - 1].end },
      result: decorate(result),
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    if (error instanceof TranscriptUnavailable) {
      if (error.cause) console.warn(`transcript unavailable: ${error.cause}`);
      return res.status(422).json({ error: error.message, detail: error.cause ?? null, canPaste: true });
    }
    if (error?.status === 401) {
      return res.status(502).json({ error: 'TypeSafe rejected the API key.' });
    }
    console.error(error);
    res.status(500).json({ error: error?.message ?? 'Something went wrong.' });
  }
});

async function loadTranscript({ url, transcript }) {
  if (typeof transcript === 'string' && transcript.trim()) {
    const cues = parsePastedTranscript(transcript);
    if (!cues.length) throw new TranscriptUnavailable('That pasted transcript had no readable lines.');
    return { cues, videoId: parseVideoId(url), title: 'Pasted transcript', kind: 'pasted' };
  }

  if (url === 'demo') {
    const fixture = JSON.parse(await readFile(path.join(here, 'fixtures/demo-transcript.json'), 'utf8'));
    return { cues: fixture.cues, videoId: null, title: fixture.title, kind: 'demo' };
  }

  const videoId = parseVideoId(url);
  if (!videoId) throw new TranscriptUnavailable('That does not look like a YouTube link.');

  const { title, cues } = await fetchTranscript(videoId);
  return { cues, videoId, title, kind: 'youtube' };
}

/** Add the human-readable timestamps; the model never sees or produces these. */
function decorate(result) {
  if (result.start) result.start.timestamp = formatTimestamp(result.start.seconds);
  if (result.end) result.end.timestamp = formatTimestamp(result.end.seconds);
  for (const w of result.windows ?? []) {
    w.fromTimestamp = formatTimestamp(w.from);
    w.toTimestamp = formatTimestamp(w.to);
  }
  return result;
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Sponsor skip demo on http://localhost:${port}`);
  if (!hasKey) console.log('No TYPESAFE_API_KEY found — set one in .env before analysing a video.');
});
