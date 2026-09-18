// Finding the sponsor segment with Jev (TypeSafe System One).
//
// Shape of the work, following the docs' "select instead of generate" advice:
// code finds the candidates (labelled transcript lines) and Jev picks between
// them. Two stages, because stage two's state depends on stage one's answer:
//
//   Stage 1 (scan)   one request per transcript window, all in parallel. Each
//                    asks a noul (does a sponsor read begin in this excerpt?)
//                    and a choice (which line begins it?) over the same state.
//   Stage 2 (refine) one request over the lines around the winning line, to
//                    pin down the first line exactly and find the last one.
//
// Nothing here asks Jev for a number: it names a line ID and code reads the
// timestamp off that line.
//
// This file has no dependencies beyond ./transcript.js so the Chrome extension
// can run the same pipeline: pass any `client` with a `systemOne(request)`.

import { renderLines, windowLines, estimateTokens } from './transcript.js';

/** Confidence bands, following the cookbook's 0.7 / 0.35 split. Tune on real data. */
export const FOUND = 0.7;
export const MAYBE = 0.35;

/** Lines of context kept around the candidate in the refine pass. */
const REFINE_BEFORE = 6;
const REFINE_AFTER = 34;

const NO_START = 'none';
const RUNS_PAST_EXCERPT = 'continues_past_excerpt';

const SPONSOR = [
  'A paid sponsor read is a promotional message for a product or service that',
  'paid for placement in this video. It is usually read by the creator, sits',
  'apart from the video\'s own subject, and typically names the sponsor and',
  'points at a link, a discount code or a trial.',
  'A creator promoting their own merchandise, channel membership, newsletter or',
  'other videos is not a paid sponsor read.'
].join(' ');

/**
 * @typedef {import('./transcript.js').Line} Line
 * @typedef {{ line: Line|null, probability: number, presence: number,
 *             pNone: number, windowIndex: number }} Candidate
 */

/** One scan request: "does a sponsor read start here, and on which line?" */
export function scanQuestions(lines) {
  /** @type {Record<string, null|string>} */
  const options = {};
  for (const line of lines) options[line.id] = null;
  options[NO_START] = 'No line in this excerpt is the first line of a paid sponsor read.';

  return {
    sponsor_starts_here: {
      type: 'noul',
      instructions:
        `This is an excerpt of a YouTube video transcript. ${SPONSOR} ` +
        'Does a paid sponsor read begin somewhere in this excerpt?',
      criteria: {
        true: 'The excerpt contains the moment the creator turns from the video\'s own content into a paid sponsor read.',
        false:
          'The excerpt contains no such moment. Either it is all regular content, or a sponsor read that began before this excerpt is still running through it.'
      }
    },
    start_line: {
      type: 'choice',
      instructions:
        `${SPONSOR} Which labelled line is the FIRST line of the paid sponsor read? ` +
        'Choose the line where the turn towards the sponsor begins, including a lead-in such as ' +
        '"but first, a word from our sponsor" or "today\'s video is brought to you by", not the line ' +
        'where the product is first named if the turn happened earlier.',
      criteria: options
    }
  };
}

/** One refine request over the lines around the candidate: exact first and last line. */
export function refineQuestions(lines) {
  /** @type {Record<string, null|string>} */
  const startOptions = {};
  for (const line of lines) startOptions[line.id] = null;
  startOptions[NO_START] = 'No line in this excerpt is the first line of a paid sponsor read.';

  /** @type {Record<string, null|string>} */
  const endOptions = {};
  for (const line of lines) endOptions[line.id] = null;
  endOptions[RUNS_PAST_EXCERPT] = 'The sponsor read is still running at the end of this excerpt.';
  endOptions[NO_START] = 'This excerpt contains no paid sponsor read.';

  return {
    has_sponsor: {
      type: 'noul',
      instructions:
        `This is an excerpt of a YouTube video transcript. ${SPONSOR} ` +
        'Does this excerpt contain a paid sponsor read?',
      criteria: {
        true: 'A paid sponsor read is read out somewhere in this excerpt.',
        false: 'This excerpt is regular video content with no paid sponsor read in it.'
      }
    },
    start_line: {
      type: 'choice',
      instructions:
        `${SPONSOR} Which labelled line is the FIRST line of the paid sponsor read — ` +
        'the line where the turn towards the sponsor begins, lead-in included?',
      criteria: startOptions
    },
    end_line: {
      type: 'choice',
      instructions:
        `${SPONSOR} Which labelled line is the LAST line of the paid sponsor read? ` +
        'Choose the final line of the promotion, the one after which the video returns to its own content.',
      criteria: endOptions
    }
  };
}

function bestLabel(probabilities, allowed) {
  let bestId = null;
  let best = -1;
  for (const [label, p] of Object.entries(probabilities)) {
    if (!allowed.has(label)) continue;
    if (p > best) {
      best = p;
      bestId = label;
    }
  }
  return { id: bestId, probability: best < 0 ? 0 : best };
}

/** Most sponsor reads a single video is allowed to have; a loop guard as much as a limit. */
const MAX_SEGMENTS = 6;
/** Lines masked after a start when the refine pass could not find the end. */
const BLIND_MASK_LINES = 12;

/**
 * Locate every sponsor segment in an already-built line index.
 *
 * Videos often carry more than one read, and two can sit in the same scan
 * window. So after each segment is confirmed, its lines are removed from the
 * window it came from and that window is scanned again; the loop ends when no
 * window still looks like it has a sponsor read starting in it.
 *
 * @param {Line[]} lines
 * @param {{ client: { systemOne: (request: any) => Promise<any> }, model?: string,
 *           onProgress?: (e: any) => void }} opts
 */
export async function findSponsorSegment(lines, opts) {
  const client = opts?.client;
  if (!client) throw new Error('findSponsorSegment needs a client with systemOne()');
  const model = opts.model;
  const report = opts.onProgress ?? (() => {});

  if (!lines.length) {
    return { status: 'no-transcript', segments: [], windows: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const usage = { input_tokens: 0, output_tokens: 0 };
  const track = (result) => {
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    usage.output_tokens += result.usage?.output_tokens ?? 0;
    return result;
  };

  const ask = async (state, questions) => {
    const request = { state, questions };
    if (model) request.model = model;
    return track(await client.systemOne(request));
  };

  const scan = async (windowLines_, index, total) => {
    const state = {
      video_transcript_excerpt: renderLines(windowLines_),
      excerpt_position: `part ${index + 1} of ${total} of the video`
    };
    const result = await ask(state, scanQuestions(windowLines_));
    const presence = result.answers.sponsor_starts_here.noul;
    const pick = bestLabel(result.answers.start_line.probabilities, new Set(windowLines_.map((l) => l.id)));
    report({ stage: 'scan', window: index, presence });
    return {
      index,
      lines: windowLines_,
      from: windowLines_[0].start,
      to: windowLines_[windowLines_.length - 1].end,
      presence,
      pNone: result.answers.start_line.probabilities[NO_START] ?? 0,
      startLineId: pick.id,
      startLineProbability: pick.probability,
      estimatedStateTokens: estimateTokens(state.video_transcript_excerpt)
    };
  };

  // Stage 1: every window scanned in parallel.
  const windows = windowLines(lines);
  report({ stage: 'scan', windows: windows.length });
  const scans = await Promise.all(windows.map((w, i) => scan(w, i, windows.length)));
  const scanLog = scans.map(summarise);

  // Stage 2: confirm the strongest candidate, mask it out, rescan its window,
  // repeat until nothing is left that looks like a sponsor read.
  const segments = [];
  const taken = new Set(); // line ids already inside a confirmed segment

  while (segments.length < MAX_SEGMENTS) {
    const candidates = scans.filter((s) => s.presence >= MAYBE && s.startLineId && !taken.has(s.startLineId));
    if (!candidates.length) break;
    const winner = candidates.reduce((a, b) => (b.presence > a.presence ? b : a));

    const segment = await refine(winner, lines, taken, ask, report);
    if (segment) {
      segments.push(segment);
      for (const id of segment.lineIds) taken.add(id);
    }

    // Rescan this window without the lines just claimed. A rescan also happens
    // when the refine pass rejected the candidate, so the loop cannot spin.
    const remaining = winner.lines.filter((l) => !taken.has(l.id));
    if (!segment || remaining.length < 3) {
      winner.presence = 0;
      continue;
    }
    const rescan = await scan(remaining, winner.index, windows.length);
    scanLog.push(summarise(rescan));
    Object.assign(winner, rescan);
  }

  segments.sort((a, b) => a.start.seconds - b.start.seconds);
  const best = segments.reduce((a, b) => (!a || b.confidence > a.confidence ? b : a), null);
  const status = !segments.length
    ? 'not-found'
    : segments.some((s) => s.confidence >= FOUND)
      ? 'found'
      : 'uncertain';

  return {
    status,
    // The strongest segment, kept at the top level for callers that want one answer.
    confidence: best?.confidence ?? Math.max(0, ...scans.map((s) => s.presence)),
    start: segments[0]?.start ?? null,
    end: segments[0]?.end ?? null,
    context: segments[0]?.context ?? [],
    segments,
    windows: scanLog,
    usage
  };
}

/** Pin down one candidate's first and last line. Returns null when the refine pass rejects it. */
async function refine(winner, lines, taken, ask, report) {
  const centre = lines.findIndex((l) => l.id === winner.startLineId);
  const from = Math.max(0, centre - REFINE_BEFORE);
  const slice = lines.slice(from, Math.min(lines.length, centre + REFINE_AFTER)).filter((l) => !taken.has(l.id));
  if (slice.length < 2) return null;
  report({ stage: 'refine', lines: slice.length });

  const allowed = new Set(slice.map((l) => l.id));
  const refined = await ask(
    {
      video_transcript_excerpt: renderLines(slice),
      excerpt_position: `an excerpt from the middle of the video, around ${Math.round(slice[0].start)} seconds in`
    },
    refineQuestions(slice)
  );

  const presence = refined.answers.has_sponsor.noul;
  if (presence < MAYBE) return null;

  const startPick = bestLabel(refined.answers.start_line.probabilities, allowed);
  const endPick = bestLabel(refined.answers.end_line.probabilities, allowed);
  const endRunsOn = refined.answers.end_line.probabilities[RUNS_PAST_EXCERPT] ?? 0;

  const byId = new Map(slice.map((l) => [l.id, l]));
  const startLine = byId.get(startPick.id) ?? byId.get(winner.startLineId) ?? slice[0];
  const endLine = byId.get(endPick.id);
  const endOk = endLine && endRunsOn < endPick.probability && endLine.end > startLine.start;

  const startIndex = slice.indexOf(startLine);
  const endIndex = endOk ? slice.indexOf(endLine) : Math.min(slice.length - 1, startIndex + BLIND_MASK_LINES);
  const lineIds = slice.slice(startIndex, endIndex + 1).map((l) => l.id);

  return {
    confidence: Math.min(winner.presence, presence),
    scanPresence: winner.presence,
    refinePresence: presence,
    start: { lineId: startLine.id, seconds: startLine.start, text: startLine.text, probability: startPick.probability },
    end: endOk
      ? { lineId: endLine.id, seconds: endLine.end, text: endLine.text, probability: endPick.probability, runsPastExcerpt: endRunsOn }
      : null,
    lineIds,
    context: slice
  };
}

function summarise(scan) {
  const { lines: _lines, ...rest } = scan;
  return rest;
}
