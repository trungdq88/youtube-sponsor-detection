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

/** Words per phrase when a line is split for the boundary pass: about a second of speech. */
export const PHRASE_WORDS = 3;

/**
 * @typedef {{ text: string, offsetMs: number }} CueWord  offset from the cue's start
 * @typedef {{ text: string, startMs: number, endMs: number, words?: CueWord[] }} Cue
 * @typedef {{ text: string, start: number, end: number }} Word
 * @typedef {{ id: string, text: string, start: number, end: number, words: Word[] }} Line
 * @typedef {{ id: string, lineId: string, text: string, start: number, end: number }} Phrase
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

    buf ??= { start: cue.startMs / 1000, end: cue.endMs / 1000, parts: [], words: [] };
    buf.parts.push(text);
    buf.words.push(...cueWords(cue, text));
    buf.end = cue.endMs / 1000;
  }
  if (buf) lines.push(finish(buf, lines.length));
  return lines;
}

/**
 * The words of a cue with a time each. Auto-generated tracks say when every
 * word is spoken; for the rest the cue's span is shared out by character
 * count, which is within a second on cues of normal length.
 * @returns {Word[]}
 */
function cueWords(cue, text) {
  const start = cue.startMs / 1000;
  const end = Math.max(start, cue.endMs / 1000);
  if (cue.words?.length > 1) {
    const words = cue.words.map((w) => ({ text: w.text, start: start + w.offsetMs / 1000 }));
    return words.map((w, i) => ({ ...w, start: round(w.start), end: round(words[i + 1]?.start ?? Math.max(end, w.start)) }));
  }
  const tokens = text.split(' ');
  const chars = text.length + 1;
  let at = 0;
  return tokens.map((t) => {
    const from = start + ((end - start) * at) / chars;
    at += t.length + 1;
    const to = start + ((end - start) * at) / chars;
    return { text: t, start: round(from), end: round(Math.min(end, to)) };
  });
}

const round = (n) => Number(n.toFixed(2));

function finish(buf, index) {
  return {
    id: `L${String(index + 1).padStart(3, '0')}`,
    text: buf.parts.join(' ').replace(/\s+/g, ' ').trim(),
    start: round(buf.start),
    end: round(buf.end),
    words: buf.words
  };
}

/**
 * Split lines into short labelled phrases, P01, P02, ..., for choosing a
 * boundary inside a line. Phrases never cross a line, so each one keeps the
 * line it came from.
 * @param {Line[]} lines
 * @returns {Phrase[]}
 */
export function buildPhrases(lines) {
  /** @type {Phrase[]} */
  const phrases = [];
  for (const line of lines) {
    const words = line.words?.length ? line.words : [{ text: line.text, start: line.start, end: line.end }];
    for (let i = 0; i < words.length; i += PHRASE_WORDS) {
      // A leftover word or two joins the previous phrase rather than standing alone.
      const last = i + PHRASE_WORDS >= words.length - 1;
      const chunk = last ? words.slice(i) : words.slice(i, i + PHRASE_WORDS);
      phrases.push({
        id: `P${String(phrases.length + 1).padStart(2, '0')}`,
        lineId: line.id,
        text: chunk.map((w) => w.text).join(' '),
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end
      });
      if (last) break;
    }
  }
  return phrases;
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
