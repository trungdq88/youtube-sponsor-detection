import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildLines, windowLines, estimateTokens, formatTimestamp, WINDOW_LINES } from '../src/transcript.js';
import { findSponsorSegment, scanQuestions, anchorQuestions, startQuestions } from '../src/jev.js';
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
  for (const questions of [scanQuestions(lines), anchorQuestions(lines), startQuestions(lines)]) {
    for (const [name, q] of Object.entries(questions)) {
      assert.ok(typeof q.instructions?.question === 'string' && q.instructions.question.length > 20, `${name} asks a question`);
      assert.ok(q.instructions.definition && q.instructions.shape, `${name} carries the sponsor definition`);
      if (q.type === 'choice') {
        const labels = Object.keys(q.criteria);
        for (const line of lines) assert.ok(labels.includes(line.id), `${name} offers ${line.id}`);
        // start_line reads back from a known naming line, so every option is a real line.
        if (name !== 'start_line') assert.ok(labels.includes('none'), `${name} has a no-match option`);
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
  assert.equal(result.segments.length, 1);
  assert.equal(client.requests.length, 4, 'scan, anchor, trace back, then a clean rescan of the window');
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
  assert.equal(client.requests.length, scans + 3, 'scans, anchor, trace back, one clean rescan');
  assert.equal(result.status, 'found');
  assert.ok(result.start.seconds > offset / 1000, 'the sponsor read is found in the tail, not the filler');
  assert.ok(result.windows.every((w) => w.estimatedStateTokens < 25_000), 'each excerpt stays well inside the 32k state limit');
});

const SECOND_READ = [
  'okay quick pause because this part of the video is brought to you by Nimbus',
  'Nimbus is a cloud notebook that syncs your notes across every device you own',
  'I have been using it to keep all the test notes for this series in one place',
  'go to nimbus dot app slash laptops for twenty percent off your first year',
  'alright now back to the video and the fourth laptop'
];

function withSecondRead(cues, afterSeconds) {
  const out = [];
  let inserted = false;
  for (const cue of cues) {
    if (!inserted && cue.startMs / 1000 >= afterSeconds) {
      let t = cue.startMs;
      for (const text of SECOND_READ) {
        out.push({ text, startMs: t, endMs: t + 6000 });
        t += 6000;
      }
      inserted = true;
    }
    out.push(inserted ? { ...cue, startMs: cue.startMs + SECOND_READ.length * 6000, endMs: cue.endMs + SECOND_READ.length * 6000 } : cue);
  }
  return out;
}

test('two sponsor reads in one window are both found, in order', async () => {
  const cues = withSecondRead(fixture.cues, 260);
  const client = createStubClient();
  const result = await findSponsorSegment(buildLines(cues), { client });

  assert.equal(result.status, 'found');
  assert.equal(result.segments.length, 2);
  const [first, second] = result.segments;
  assert.ok(Math.abs(first.start.seconds - SPONSOR_STARTS_NEAR) < 20, `first at ${first.start.seconds}s`);
  assert.ok(second.start.seconds > 250 && second.start.seconds < 300, `second at ${second.start.seconds}s`);
  assert.ok(first.end.seconds < second.start.seconds, 'segments do not overlap');
  assert.ok(second.end, 'the second read has an end too');
  // scan, (anchor, trace, rescan) x2, the last rescan clean
  assert.equal(client.requests.length, 7);
  assert.equal(result.start.seconds, first.start.seconds, 'top-level start is the earliest segment');
});

test('two sponsor reads in different windows are both found', async () => {
  const filler = [];
  for (let i = 0; i < 400; i++) {
    filler.push({ text: `and then we tried yet another configuration number ${i} to see what happened`, startMs: i * 5000, endMs: (i + 1) * 5000 });
  }
  const offset = filler.length * 5000;
  const tail = withSecondRead(fixture.cues, 260).map((c) => ({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset }));
  const early = fixture.cues.slice(12, 28).map((c) => ({ ...c, startMs: c.startMs - 60_000, endMs: c.endMs - 60_000 }));
  const lines = buildLines([...early, ...filler, ...tail]);

  const client = createStubClient();
  const result = await findSponsorSegment(lines, { client });
  assert.equal(result.segments.length, 3, `found ${result.segments.map((s) => s.start.seconds).join(', ')}`);
  for (let i = 1; i < result.segments.length; i++) {
    assert.ok(result.segments[i].start.seconds > result.segments[i - 1].end.seconds, 'sorted and disjoint');
  }
});

test('a lead-in anecdote is part of the segment, from its first line', async () => {
  const leadIn = JSON.parse(await readFile(new URL('../fixtures/lead-in-transcript.json', import.meta.url), 'utf8'));
  const client = createStubClient();
  const result = await findSponsorSegment(buildLines(leadIn.cues), { client, title: leadIn.title });

  assert.equal(result.segments.length, 1);
  const [seg] = result.segments;
  assert.ok(Math.abs(seg.start.seconds - leadIn.leadInStartsAtSeconds) < 8, `starts at ${seg.start.seconds}, lead-in at ${leadIn.leadInStartsAtSeconds}`);
  assert.ok(Math.abs(seg.anchor.seconds - leadIn.sponsorNamedAtSeconds) < 8, `named at ${seg.anchor.seconds}`);
  assert.ok(seg.anchor.seconds - seg.start.seconds > 30, 'the lead-in runs well before the sponsor is named');
  assert.ok(seg.end && seg.end.seconds > seg.anchor.seconds, 'ends after the offer');
  assert.ok(seg.end.seconds < buildLines(leadIn.cues).at(-1).start, 'the sign-off is not part of the segment');

  // The trace-back request carries the naming line in its state and offers only lines up to it.
  const trace = client.requests.find((r) => r.questions.start_line);
  assert.equal(trace.state.sponsor_named_at, seg.anchor.lineId);
  assert.equal(trace.state.video_title, leadIn.title);
  const offered = Object.keys(trace.questions.start_line.criteria);
  assert.equal(offered.at(-1), seg.anchor.lineId, 'options end at the naming line');
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

test('json3 caption events become cues and English human tracks win', async () => {
  const { parseJson3, pickCaptionTrack } = await import('../src/youtube.js');
  const cues = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hey ' }, { utf8: 'there' }] },
      { tStartMs: 2000, dDurationMs: 1000 },
      { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: '\n' }] },
      { tStartMs: 4500, dDurationMs: 1500, segs: [{ utf8: 'welcome back' }] }
    ]
  });
  assert.deepEqual(cues, [
    { text: 'hey there', startMs: 0, endMs: 2000 },
    { text: 'welcome back', startMs: 4500, endMs: 6000 }
  ]);

  const tracks = [
    { language_code: 'de', kind: undefined, base_url: 'de' },
    { language_code: 'en', kind: 'asr', base_url: 'en-auto' },
    { language_code: 'en-GB', kind: undefined, base_url: 'en-gb' }
  ];
  assert.equal(pickCaptionTrack(tracks).base_url, 'en-gb');
  assert.equal(pickCaptionTrack(tracks.slice(0, 2)).base_url, 'en-auto');
  assert.equal(pickCaptionTrack(tracks.slice(0, 1)).base_url, 'de');
  assert.equal(pickCaptionTrack([]), null);
});
