// Pull a small sample of sponsor-labelled videos out of a SponsorBlock
// database mirror without downloading the export (sponsorTimes.csv is ~7 GB).
//
//   node scripts/sponsorblock-sample.js            # 20 videos -> eval/videos.json
//   node scripts/sponsorblock-sample.js --count 15 --slices 6 --mirror https://sb.ltn.fi/database/
//
// It reads a few random byte ranges of the CSV, keeps sponsor segments that are
// locked or have at least 2 votes, merges overlapping submissions per video,
// and picks videos of 4–45 minutes, best-agreed segments first.

import { writeFile, mkdir } from 'node:fs/promises';
import { parseCsv, usableSegments, groupByVideo, wholeRows, hasNeededColumns } from '../src/sponsorblock.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const count = Number(opt('--count', 20));
const slices = Number(opt('--slices', 5));
const sliceBytes = Number(opt('--slice-mb', 8)) * 1024 * 1024;
const mirror = opt('--mirror', 'https://sb.ltn.fi/database/').replace(/\/?$/, '/');
const out = opt('--out', 'eval/videos.json');
const url = `${mirror}sponsorTimes.csv`;

// Probe with a one-byte range rather than HEAD: with gzip negotiated the mirror
// answers HEAD chunked, without content-length or accept-ranges, but a range
// request still comes back 206 with the full size in content-range.
const probe = await fetch(url, { headers: { range: 'bytes=0-0', 'accept-encoding': 'identity' } });
await probe.arrayBuffer();
const total = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1]);
if (probe.status !== 206 || !total) {
  throw new Error(`${url} does not serve byte ranges (status ${probe.status}, content-range=${probe.headers.get('content-range')})`);
}
console.log(`${url}: ${(total / 1e9).toFixed(2)} GB`);

async function range(from, to) {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}`, 'accept-encoding': 'identity' } });
  if (res.status !== 206) throw new Error(`range request responded ${res.status}`);
  return res.text();
}

// The header row, then a handful of slices spread over the file.
const headerText = (await range(0, 8191)).split('\n')[0];
const header = parseCsvHeader(headerText);
if (!hasNeededColumns(header)) throw new Error(`unexpected columns: ${header.join(',')}`);

const videos = new Map();
for (let i = 0; i < slices; i++) {
  const from = Math.floor(Math.random() * (total - sliceBytes));
  process.stdout.write(`slice ${i + 1}/${slices} at ${(from / 1e9).toFixed(2)} GB … `);
  const chunk = await range(from, from + sliceBytes - 1);
  const rows = parseCsv(`${headerText}\n${wholeRows(chunk, false)}`);
  const found = groupByVideo(usableSegments(rows));
  for (const v of found) if (!videos.has(v.videoID)) videos.set(v.videoID, v);
  console.log(`${rows.length} rows, ${found.length} usable videos (total ${videos.size})`);
}

// Best-agreed first: locked segments, then votes; a little shuffle so reruns differ.
const picked = [...videos.values()]
  .map((v) => ({ ...v, score: v.segments.reduce((s, x) => s + (x.locked ? 100 : 0) + x.votes, 0) + Math.random() * 3 }))
  .sort((a, b) => b.score - a.score)
  .slice(0, count)
  .map(({ score: _s, ...v }) => v);

await mkdir(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
await writeFile(out, JSON.stringify({ source: url, sampledAt: new Date().toISOString(), videos: picked }, null, 2));
console.log(`\nwrote ${picked.length} videos to ${out}`);
for (const v of picked) {
  const segs = v.segments.map((s) => `${fmt(s.start)}–${fmt(s.end)}${s.locked ? ' 🔒' : ` (${s.votes} votes)`}`).join(', ');
  console.log(`  ${v.videoID}  ${v.duration ? fmt(v.duration) : '?'}  ${segs}`);
}

function parseCsvHeader(line) {
  return parseCsv(`${line}\n${line}`).length ? Object.keys(parseCsv(`${line}\n${line}`)[0]) : line.split(',');
}
function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
