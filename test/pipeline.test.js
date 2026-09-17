import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildLines, windowLines, estimateTokens, formatTimestamp, WINDOW_LINES } from '../src/transcript.js';
import { findSponsorSegment, scanQuestions, refineQuestions } from '../src/jev.js';
import { parseVideoId, parsePastedTranscript } from '../src/youtube.js';
import { createStubClient } from './stub-client.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/demo-transcript.json', import.meta.url), 'utf8'));
const SPONSOR_STARTS_NEAR = 89; // "who is making today's video possible"

test('video ids come out of every link shape we accept', () => {
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s'), 'dQw4w9WgXcQ');
  assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(parseVideoId('youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseVideoId('https://vimeo.com/12345'), null);
  assert.equal(parseVideoId(''), null);
});

test('pasted transcripts keep their timestamps', () => {
  const cues = parsePastedTranscript('0:00\nhey everyone\n1:30 and we are back\n1:02:03\nlast bit');
  assert.equal(cues.length, 3);
  assert.equal(cues[1].startMs, 90_000);
  assert.equal(cues[2].startMs, 3_723_000);
});

test('lines carry ids and the timestamps stay in code', () => {
  const lines = buildLines(fixture.cues);
  assert.ok(lines.length > 10);
  assert.equal(lines[0].id, 'L001');
  assert.ok(lines.every((l, i) => i === 0 || l.start >= lines[i - 1].start));
  assert.equal(formatTimestamp(272.4), '4:32');
  assert.equal(formatTimestamp(3812), '1:03:32');
});

test('windows overlap and cover every line', () => {
  const lines = Array.from({ length: 205 }, (_, i) => ({ id: `L${i}`, text: 'x', start: i, end: i + 1 }));
  const windows = windowLines(lines);
  assert.ok(windows.length > 1);
  assert.ok(windows.every((w) => w.length <= WINDOW_LINES));
  const seen = new Set(windows.flat().map((l) => l.id));
  assert.equal(seen.size, lines.length);
  const firstEnd = windows[0][windows[0].length - 1].id;
  assert.ok(windows[1].some((l) => l.id === firstEnd), 'consecutive windows share lines');
});

test('questions are well formed and always offer a no-match answer', () => {
  const lines = buildLines(fixture.cues).slice(0, 20);
  for (const questions of [scanQuestions(lines), refineQuestions(lines)]) {
    for (const [name, q] of Object.entries(questions)) {
      assert.ok(typeof q.instructions === 'string' && q.instructions.length > 20, `${name} has instructions`);
      if (q.type === 'choice') {
        const labels = Object.keys(q.criteria);
        assert.ok(labels.length >= lines.length + 1, `${name} offers every line plus an escape hatch`);
        assert.ok(labels.includes('none'), `${name} has a no-match option`);
        for (const line of lines) assert.ok(labels.includes(line.id), `${name} offers ${line.id}`);
      } else {
        assert.ok(q.criteria.true && q.criteria.false, `${name} describes both outcomes`);
      }
    }
  }
});

test('finds the sponsor read in the demo transcript', async () => {
  const lines = buildLines(fixture.cues);
  const client = createStubClient();
  const result = await findSponsorSegment(lines, { client });

  assert.equal(result.status, 'found');
  assert.ok(Math.abs(result.start.seconds - SPONSOR_STARTS_NEAR) < 20, `start ${result.start.seconds}s near ${SPONSOR_STARTS_NEAR}s`);
  assert.ok(result.end && result.end.seconds > result.start.seconds, 'the end comes after the start');
  assert.ok(result.confidence > 0.7);
  assert.equal(client.requests.length, 2, 'one scan request plus one refine request');
});

test('a long video is scanned window by window, then refined once', async () => {
  const filler = [];
  for (let i = 0; i < 700; i++) {
    filler.push({ text: `and then we tried yet another configuration number ${i} to see what happened`, startMs: i * 5000, endMs: (i + 1) * 5000 });
  }
  const offset = filler.length * 5000;
  const tail = fixture.cues.map((c) => ({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset }));
  const lines = buildLines([...filler, ...tail]);

  const client = createStubClient();
  const result = await findSponsorSegment(lines, { client });

  const scans = windowLines(lines).length;
  assert.ok(scans > 1, 'this transcript really is multi-window');
  assert.equal(client.requests.length, scans + 1);
  assert.equal(result.status, 'found');
  assert.ok(result.start.seconds > offset / 1000, 'the sponsor read is found in the tail, not the filler');
  assert.ok(result.windows.every((w) => w.estimatedStateTokens < 25_000), 'each excerpt stays well inside the 32k state limit');
});

test('no sponsor read means no timestamp', async () => {
  const cues = Array.from({ length: 60 }, (_, i) => ({
    text: 'today we are looking at the history of the paperclip and how it was designed',
    startMs: i * 6000,
    endMs: (i + 1) * 6000
  }));
  const client = createStubClient();
  const result = await findSponsorSegment(buildLines(cues), { client });

  assert.equal(result.status, 'not-found');
  assert.equal(client.requests.length, 1, 'a clean scan does not pay for a refine pass');
});

test('token estimate tracks length', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});
