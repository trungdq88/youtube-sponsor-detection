// Score the pipeline against SponsorBlock's community labels.
//
//   npm run eval                      # eval/videos.json (+ eval/videos.seed.json)
//   npm run eval -- --limit 5 --fresh # first five videos, ignore cached Jev results
//   npm run eval -- --lines           # score the same runs at line boundaries, without the cut pass
//
// For each video: fetch the transcript, run the pipeline, and compare the
// segments Jev found with SponsorBlock's. Results are cached per video in
// eval/cache/ so re-scoring after a question change only re-runs with --fresh.
//
// The transcript comes from eval/transcripts/ when `npm run transcripts` has
// saved it there, so the eval itself only needs to reach Jev.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { TypeSafeClient } from '@typesafe-ai/sdk';

import { fetchTranscript } from '../src/youtube.js';
import { buildLines, formatTimestamp } from '../src/transcript.js';
import { findSponsorSegment } from '../src/jev.js';
import { evalVideos, savedTranscript } from '../src/eval-videos.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const limit = Number(opt('--limit', Infinity));
/** A prediction counts as a hit when it overlaps the label this much, or starts this close. */
const IOU_HIT = 0.5;
const START_TOLERANCE = Number(opt('--tolerance', 15));
/** Labels are placed by hand, so a boundary this close to one is not counted as cutting content. */
const CONTENT_SLACK = 1;

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY first (or put it in .env).');
  process.exit(1);
}

const videos = await evalVideos();
if (!videos.length) {
  console.error('No videos. Run: node scripts/sponsorblock-sample.js');
  process.exit(1);
}

await mkdir('eval/cache', { recursive: true });
const client = new TypeSafeClient({ timeout: 30_000 });
const rows = [];

for (const video of videos.slice(0, limit)) {
  const cacheFile = `eval/cache/${video.videoID}.json`;
  let run;
  if (!flag('--fresh') && existsSync(cacheFile)) {
    run = JSON.parse(await readFile(cacheFile, 'utf8'));
  } else {
    process.stdout.write(`${video.videoID} … `);
    try {
      // Transcripts saved by `npm run transcripts` first; YouTube only for the rest.
      const { title, cues, route } = (await savedTranscript(video.videoID)) ?? (await fetchTranscript(video.videoID));
      const lines = buildLines(cues);
      // A label past the end of the transcript means the video was re-cut since
      // it was labelled (or the captions stop early); its labels cannot be trusted.
      const transcriptEnd = lines.at(-1)?.end ?? 0;
      if (video.segments.some((seg) => seg.start > transcriptEnd + 5)) {
        throw new Error(`labels run past the end of the transcript (${formatTimestamp(transcriptEnd)})`);
      }
      const started = Date.now();
      const result = await findSponsorSegment(lines, { client, title });
      run = {
        title,
        route,
        lines: lines.length,
        elapsedMs: Date.now() - started,
        usage: result.usage,
        predicted: result.segments.map((s) => ({
          start: s.start.seconds,
          end: s.end?.seconds ?? null,
          // The line-level boundaries too, so --lines scores the pipeline without the cut pass.
          lineStart: s.start.lineSeconds ?? s.start.seconds,
          lineEnd: s.end ? (s.end.lineSeconds ?? s.end.seconds) : null,
          confidence: s.confidence,
          anchor: s.anchor.seconds
        }))
      };
      console.log(`${result.segments.length} segment(s), ${result.usage.input_tokens.toLocaleString()} tokens`);
    } catch (error) {
      run = { error: error.message, cause: error.cause ? String(error.cause) : undefined };
      console.log(`skipped: ${error.message}${error.cause ? ` (${error.cause})` : ''}`);
    }
    await writeFile(cacheFile, JSON.stringify(run, null, 2));
  }
  rows.push(score(video, run));
}

report(rows);
await writeFile('eval/results.json', JSON.stringify({ at: new Date().toISOString(), tolerance: START_TOLERANCE, rows }, null, 2));
console.log('\nwrote eval/results.json');

// ---------------------------------------------------------------------------

function score(video, run) {
  if (run.error) return { videoID: video.videoID, error: run.error, truth: video.segments };
  const truth = video.segments;
  const predicted = flag('--lines')
    ? run.predicted.map((p) => ({ ...p, start: p.lineStart ?? p.start, end: p.lineEnd ?? p.end }))
    : run.predicted;
  const matches = [];
  const usedPred = new Set();

  for (const t of truth) {
    let best = null;
    predicted.forEach((p, i) => {
      if (usedPred.has(i)) return;
      const iou = overlap(t, p);
      const startErr = p.start - t.start;
      const hit = iou >= IOU_HIT || Math.abs(startErr) <= START_TOLERANCE;
      if (hit && (!best || iou > best.iou)) best = { i, iou, startErr, endErr: p.end === null ? null : p.end - t.end };
    });
    if (best) usedPred.add(best.i);
    matches.push({ truth: t, pred: best ? predicted[best.i] : null, ...(best ?? {}) });
  }

  return {
    videoID: video.videoID,
    title: run.title,
    truth,
    predicted,
    matches,
    hits: matches.filter((m) => m.pred).length,
    falsePositives: predicted.length - usedPred.size,
    tokens: run.usage?.input_tokens ?? 0,
    elapsedMs: run.elapsedMs
  };
}

function overlap(a, b) {
  const bEnd = b.end ?? b.start + 60;
  const inter = Math.max(0, Math.min(a.end, bEnd) - Math.max(a.start, b.start));
  const union = Math.max(a.end, bEnd) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

function report(rows) {
  const scored = rows.filter((r) => !r.error);
  const skipped = rows.filter((r) => r.error);
  const truthCount = scored.reduce((s, r) => s + r.truth.length, 0);
  const hits = scored.reduce((s, r) => s + r.hits, 0);
  const predCount = scored.reduce((s, r) => s + r.predicted.length, 0);
  const startErrs = scored.flatMap((r) => r.matches.filter((m) => m.pred).map((m) => m.startErr));
  const endErrs = scored.flatMap((r) => r.matches.filter((m) => m.pred && m.endErr !== null).map((m) => m.endErr));
  const tokens = scored.reduce((s, r) => s + r.tokens, 0);

  console.log('\nvideo         labelled  found  hits  FP   start error (s)        end error (s)');
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.videoID}   skipped: ${r.error.slice(0, 60)}`);
      continue;
    }
    const se = r.matches.filter((m) => m.pred).map((m) => signed(m.startErr)).join(' ') || '-';
    const ee = r.matches.filter((m) => m.pred && m.endErr !== null).map((m) => signed(m.endErr)).join(' ') || '-';
    console.log(`${r.videoID}   ${String(r.truth.length).padStart(5)}   ${String(r.predicted.length).padStart(4)}  ${String(r.hits).padStart(4)}  ${String(r.falsePositives).padStart(2)}   ${se.padEnd(22)} ${ee}`);
    for (const m of r.matches) {
      const t = `${formatTimestamp(m.truth.start)}–${formatTimestamp(m.truth.end)}`;
      const p = m.pred ? `${formatTimestamp(m.pred.start)}–${m.pred.end === null ? '?' : formatTimestamp(m.pred.end)} (${(m.pred.confidence * 100).toFixed(0)}%)` : 'missed';
      console.log(`               label ${t.padEnd(15)} → ${p}`);
    }
  }

  console.log(`\n${scored.length} videos scored, ${skipped.length} skipped`);
  console.log(`recall     ${hits}/${truthCount} labelled segments found (start within ${START_TOLERANCE}s or IoU ≥ ${IOU_HIT})`);
  console.log(`precision  ${hits}/${predCount} predicted segments matched a label`);
  if (startErrs.length) {
    console.log(`start error  median ${signed(median(startErrs.map(Math.abs)))}s abs, mean ${signed(mean(startErrs))}s signed (negative = too early)`);
  }
  if (endErrs.length) {
    console.log(`end error    median ${signed(median(endErrs.map(Math.abs)))}s abs, mean ${signed(mean(endErrs))}s signed`);
  }
  // Content lost: a start before the label's start, or an end after the label's end.
  const early = startErrs.filter((e) => e < -CONTENT_SLACK);
  const late = endErrs.filter((e) => e > CONTENT_SLACK);
  console.log(`content cut  ${early.length}/${startErrs.length} starts more than ${CONTENT_SLACK}s early` +
    `${early.length ? ` (worst ${signed(Math.min(...early))}s)` : ''}, ${late.length}/${endErrs.length} ends more than ${CONTENT_SLACK}s late` +
    `${late.length ? ` (worst ${signed(Math.max(...late))}s)` : ''}`);
  console.log(`tokens     ${tokens.toLocaleString()} input (≈ $${(tokens * 0.042 / 1e6).toFixed(4)} at $0.042/M)`);
}

// Function declarations, because report() runs above them at module top level.
function signed(n) {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
