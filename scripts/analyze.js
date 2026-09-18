// Run the pipeline on a real video from the command line, printing every
// segment with the lines around its boundaries, so the questions can be
// judged against real videos.
//
//   TYPESAFE_API_KEY=... node scripts/analyze.js https://www.youtube.com/watch?v=GIAQF2KtQJw
//   node scripts/analyze.js --transcript path/to/pasted-transcript.txt
//
// Add --json to dump the full result, --verbose to print every scan window.

import { readFile } from 'node:fs/promises';
import { TypeSafeClient } from '@typesafe-ai/sdk';

import { parseVideoId, fetchTranscript, parsePastedTranscript } from '../src/youtube.js';
import { buildLines, formatTimestamp } from '../src/transcript.js';
import { findSponsorSegment } from '../src/jev.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const target = args.find((a) => !a.startsWith('--') && a !== opt('--transcript') && a !== opt('--title'));

if (!process.env.TYPESAFE_API_KEY) {
  console.error('Set TYPESAFE_API_KEY first.');
  process.exit(1);
}

let cues;
let title = opt('--title') ?? 'unknown';
if (opt('--transcript')) {
  cues = parsePastedTranscript(await readFile(opt('--transcript'), 'utf8'));
} else {
  const videoId = parseVideoId(target ?? '');
  if (!videoId) {
    console.error('Give a YouTube link, or --transcript <file>.');
    process.exit(1);
  }
  ({ cues, title } = await fetchTranscript(videoId));
}

const lines = buildLines(cues);
console.log(`${title}\n${lines.length} lines, ${formatTimestamp(lines.at(-1).end)} long\n`);

const client = new TypeSafeClient({ timeout: 30_000 });
const started = Date.now();
const result = await findSponsorSegment(lines, {
  client,
  title,
  onProgress: (e) => flag('--verbose') && console.log('  ', JSON.stringify(e))
});

if (flag('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`status: ${result.status}   confidence: ${result.confidence.toFixed(2)}   ` +
  `${result.usage.input_tokens.toLocaleString()} input tokens   ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

if (flag('--verbose')) {
  for (const w of result.windows) {
    console.log(`window ${w.index}  ${formatTimestamp(w.from)}–${formatTimestamp(w.to)}  begins-here ${w.presence.toFixed(2)}  anchor ${w.startLineId ?? '-'} (${w.startLineProbability?.toFixed(2)})`);
  }
  console.log();
}

result.segments.forEach((seg, i) => {
  const end = seg.end ? formatTimestamp(seg.end.seconds) : '?';
  console.log(`segment ${i + 1}: ${formatTimestamp(seg.start.seconds)} – ${end}   confidence ${seg.confidence.toFixed(2)}`);
  console.log(`  start  ${seg.start.lineId} p=${seg.start.probability.toFixed(2)}`);
  console.log(`  named  ${seg.anchor.lineId} p=${seg.anchor.probability.toFixed(2)}  ${formatTimestamp(seg.anchor.seconds)}`);
  if (seg.end) console.log(`  end    ${seg.end.lineId} p=${seg.end.probability.toFixed(2)}`);

  const ids = new Set(seg.lineIds);
  const show = seg.context.filter((l) => {
    const i = seg.context.indexOf(l);
    const s = seg.context.findIndex((x) => x.id === seg.start.lineId);
    const e = seg.end ? seg.context.findIndex((x) => x.id === seg.end.lineId) : s + 3;
    return (i >= s - 4 && i <= s + 3) || (i >= e - 2 && i <= e + 3);
  });
  let last = null;
  for (const l of show) {
    if (last && seg.context.indexOf(l) - seg.context.indexOf(last) > 1) console.log('       …');
    const mark = l.id === seg.start.lineId ? '▶' : l.id === seg.anchor.lineId ? '★' : ids.has(l.id) ? '│' : ' ';
    console.log(`  ${mark} ${formatTimestamp(l.start).padStart(7)}  ${l.text.slice(0, 110)}`);
    last = l;
  }
  console.log();
});
if (!result.segments.length) console.log('No sponsor segment found.');
