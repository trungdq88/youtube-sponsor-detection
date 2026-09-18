// Reading SponsorBlock's sponsorTimes.csv export, a slice at a time.
//
// The export is tens of gigabytes, so this never downloads it whole: it asks a
// mirror for byte ranges, drops the partial rows at each end, and keeps the
// sponsor segments the community has agreed on.

/** Columns are taken from the header row; these are the ones used here. */
const NEEDED = ['videoID', 'startTime', 'endTime', 'votes', 'locked', 'category', 'actionType', 'service', 'videoDuration', 'hidden', 'shadowHidden'];

/**
 * Parse CSV rows (RFC-4180-ish: quoted fields, doubled quotes) into objects.
 * @param {string} text  complete rows, header included
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/**
 * Keep the segments worth treating as ground truth.
 * @param {Record<string, string>[]} rows
 * @param {{ minVotes?: number }} [opts]
 */
export function usableSegments(rows, opts = {}) {
  const minVotes = opts.minVotes ?? 2;
  return rows
    .filter(
      (r) =>
        r.category === 'sponsor' &&
        r.actionType === 'skip' &&
        r.service === 'YouTube' &&
        r.hidden === '0' &&
        r.shadowHidden === '0' &&
        (r.locked === '1' || Number(r.votes) >= minVotes)
    )
    .map((r) => ({
      videoID: r.videoID,
      start: Number(r.startTime),
      end: Number(r.endTime),
      votes: Number(r.votes),
      locked: r.locked === '1',
      videoDuration: Number(r.videoDuration) || null
    }))
    .filter((s) => s.end > s.start && s.videoID?.length === 11);
}

/**
 * Group segments by video, merging overlapping submissions, and keep videos
 * of a sensible length with a full transcript's worth of speech.
 * @param {ReturnType<typeof usableSegments>} segments
 * @param {{ minDuration?: number, maxDuration?: number }} [opts]
 */
export function groupByVideo(segments, opts = {}) {
  const minDuration = opts.minDuration ?? 4 * 60;
  const maxDuration = opts.maxDuration ?? 45 * 60;
  const byVideo = new Map();
  for (const s of segments) {
    if (!byVideo.has(s.videoID)) byVideo.set(s.videoID, []);
    byVideo.get(s.videoID).push(s);
  }

  const videos = [];
  for (const [videoID, segs] of byVideo) {
    const duration = segs.find((s) => s.videoDuration)?.videoDuration ?? null;
    if (duration !== null && (duration < minDuration || duration > maxDuration)) continue;
    videos.push({ videoID, duration, segments: mergeOverlaps(segs) });
  }
  return videos;
}

function mergeOverlaps(segs) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 1) {
      last.end = Math.max(last.end, s.end);
      last.votes = Math.max(last.votes, s.votes);
      last.locked = last.locked || s.locked;
    } else out.push({ start: s.start, end: s.end, votes: s.votes, locked: s.locked });
  }
  return out;
}

/** Cut a byte-range slice down to whole rows: drop the partial first and last row. */
export function wholeRows(chunk, isFileStart) {
  let start = 0;
  if (!isFileStart) {
    start = chunk.indexOf('\n');
    if (start < 0) return '';
    start += 1;
  }
  const end = chunk.lastIndexOf('\n');
  return end > start ? chunk.slice(start, end) : '';
}

const NEEDED_SET = new Set(NEEDED);
export function hasNeededColumns(header) {
  return NEEDED.every((c) => header.includes(c)) && NEEDED_SET.size === NEEDED.length;
}
