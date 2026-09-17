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

import { TypeSafeClient } from '@typesafe-ai/sdk';
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

function bestLabel(probabilities, lineById) {
  let bestId = null;
  let best = -1;
  for (const [label, p] of Object.entries(probabilities)) {
    if (!lineById.has(label)) continue;
    if (p > best) {
      best = p;
      bestId = label;
    }
  }
  return { id: bestId, probability: best < 0 ? 0 : best };
}

/**
 * Locate the sponsor segment in an already-built line index.
 *
 * @param {Line[]} lines
 * @param {{ client?: any, model?: string, onProgress?: (e: any) => void }} [opts]
 */
export async function findSponsorSegment(lines, opts = {}) {
  const client = opts.client ?? new TypeSafeClient();
  const model = opts.model;
  const report = opts.onProgress ?? (() => {});

  if (!lines.length) {
    return { status: 'no-transcript', windows: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const windows = windowLines(lines);
  report({ stage: 'scan', windows: windows.length });

  const usage = { input_tokens: 0, output_tokens: 0 };
  const track = (result) => {
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    usage.output_tokens += result.usage?.output_tokens ?? 0;
    return result;
  };

  // Stage 1: every window scanned in parallel — the questions inside a window
  // are independent, and so are the windows.
  const scans = await Promise.all(
    windows.map(async (windowLines_, index) => {
      const state = {
        video_transcript_excerpt: renderLines(windowLines_),
        excerpt_position: `part ${index + 1} of ${windows.length} of the video`
      };
      const request = { state, questions: scanQuestions(windowLines_) };
      if (model) request.model = model;

      const result = track(await client.systemOne(request));
      const presence = result.answers.sponsor_starts_here.noul;
      const pick = bestLabel(result.answers.start_line.probabilities, lineById);
      const pNone = result.answers.start_line.probabilities[NO_START] ?? 0;

      report({ stage: 'scan', window: index, presence });
      return {
        index,
        from: windowLines_[0].start,
        to: windowLines_[windowLines_.length - 1].end,
        presence,
        pNone,
        startLineId: pick.id,
        startLineProbability: pick.probability,
        estimatedStateTokens: estimateTokens(state.video_transcript_excerpt)
      };
    })
  );

  const winner = scans.reduce((a, b) => (b.presence > a.presence ? b : a));

  if (winner.presence < MAYBE || !winner.startLineId) {
    return { status: 'not-found', presence: winner.presence, windows: scans, usage };
  }

  // Stage 2: re-ask over a tight neighbourhood, where the boundary lines are
  // the only plausible answers and the excerpt is short enough to read closely.
  const centre = lines.findIndex((l) => l.id === winner.startLineId);
  const from = Math.max(0, centre - REFINE_BEFORE);
  const slice = lines.slice(from, Math.min(lines.length, centre + REFINE_AFTER));
  report({ stage: 'refine', lines: slice.length });

  const refineState = {
    video_transcript_excerpt: renderLines(slice),
    excerpt_position: `an excerpt from the middle of the video, around ${Math.round(slice[0].start)} seconds in`
  };
  const refineRequest = { state: refineState, questions: refineQuestions(slice) };
  if (model) refineRequest.model = model;

  const refined = track(await client.systemOne(refineRequest));
  const presence = refined.answers.has_sponsor.noul;
  const startPick = bestLabel(refined.answers.start_line.probabilities, lineById);
  const endPick = bestLabel(refined.answers.end_line.probabilities, lineById);
  const endRunsOn = refined.answers.end_line.probabilities[RUNS_PAST_EXCERPT] ?? 0;

  const startLine = startPick.id ? lineById.get(startPick.id) : lineById.get(winner.startLineId);
  const endLine = endPick.id ? lineById.get(endPick.id) : null;

  // The refine pass owns presence: it saw the whole segment, not just its start.
  const confidence = Math.min(winner.presence, presence);

  return {
    status: confidence >= FOUND ? 'found' : 'uncertain',
    confidence,
    scanPresence: winner.presence,
    refinePresence: presence,
    start: {
      lineId: startLine.id,
      seconds: startLine.start,
      text: startLine.text,
      probability: startPick.probability
    },
    end:
      endLine && endRunsOn < endPick.probability && endLine.end > startLine.start
        ? {
            lineId: endLine.id,
            seconds: endLine.end,
            text: endLine.text,
            probability: endPick.probability,
            runsPastExcerpt: endRunsOn
          }
        : null,
    context: slice,
    windows: scans,
    usage
  };
}
