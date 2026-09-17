// Turning raw caption cues into the labelled lines Jev selects between.
//
// Jev picks a *line ID*, never a timestamp: jev-1.13 reads times as text rather
// than as ordered quantities, so the ID -> seconds mapping stays in code here.

/** Caption cues are a few words each; merge them into readable lines. */
const LINE_MIN_CHARS = 70;
const LINE_MAX_SECONDS = 8;

/** Lines per scan window. Keeps state small and the choice list answerable. */
export const WINDOW_LINES = 80;
/** Lines shared between neighbouring windows, so a sponsor read that straddles
 *  a boundary is still fully visible inside one of them. */
export const WINDOW_OVERLAP = 6;

/**
 * @typedef {{ text: string, startMs: number, endMs: number }} Cue
 * @typedef {{ id: string, text: string, start: number, end: number }} Line
 */

/**
 * Merge cues into lines of roughly a sentence each, labelled L001, L002, ...
 * @param {Cue[]} cues
 * @returns {Line[]}
 */
export function buildLines(cues) {
  /** @type {Line[]} */
  const lines = [];
  let buf = null;

  const full = () =>
    buf && (buf.parts.join(' ').length >= LINE_MIN_CHARS || buf.end - buf.start >= LINE_MAX_SECONDS);

  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // A cue that is already long enough stands on its own, rather than being
    // glued to the next one and blurring the boundary we are looking for.
    if (full()) {
      lines.push(finish(buf, lines.length));
      buf = null;
    }

    buf ??= { start: cue.startMs / 1000, end: cue.endMs / 1000, parts: [] };
    buf.parts.push(text);
    buf.end = cue.endMs / 1000;
  }
  if (buf) lines.push(finish(buf, lines.length));
  return lines;
}

function finish(buf, index) {
  return {
    id: `L${String(index + 1).padStart(3, '0')}`,
    text: buf.parts.join(' ').replace(/\s+/g, ' ').trim(),
    start: Number(buf.start.toFixed(2)),
    end: Number(buf.end.toFixed(2))
  };
}

/**
 * Render lines the way the semantic-find pattern does: one per row, ID first,
 * so an answer that names an ID can be mapped straight back to a line.
 * @param {Line[]} lines
 */
export function renderLines(lines) {
  return lines.map((l) => `${l.id}| ${l.text}`).join('\n');
}

/**
 * Split the transcript into overlapping windows of lines.
 * @param {Line[]} lines
 * @param {{ size?: number, overlap?: number }} [opts]
 * @returns {Line[][]}
 */
export function windowLines(lines, opts = {}) {
  const size = opts.size ?? WINDOW_LINES;
  const overlap = opts.overlap ?? WINDOW_OVERLAP;
  if (lines.length <= size) return [lines];

  const step = size - overlap;
  const windows = [];
  for (let start = 0; start < lines.length; start += step) {
    windows.push(lines.slice(start, start + size));
    if (start + size >= lines.length) break;
  }
  return windows;
}

/** Rough token estimate, only used to keep state clear of Jev's 32k state limit. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/** 272.5 -> "4:32", 3812 -> "1:03:32" */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
