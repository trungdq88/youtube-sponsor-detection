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
//   Stage 3 (cut)    the first and last lines split into phrases of a few
//                    words, and Jev picks the phrase where the segment begins
//                    and the one where it ends, so the skip lands on a word
//                    rather than on a line that started seconds earlier.
//
// Nothing here asks Jev for a number: it names a line or phrase ID and code
// reads the timestamp off it.
//
// This file has no dependencies beyond ./transcript.js so the Chrome extension
// can run the same pipeline: pass any `client` with a `systemOne(request)`.

import { renderLines, windowLines, estimateTokens, buildPhrases } from './transcript.js';

/** Confidence bands, following the cookbook's 0.7 / 0.35 split. Tune on real data. */
export const FOUND = 0.7;
export const MAYBE = 0.35;

/** Lines of context kept around the anchor in the refine pass. A lead-in
 *  story can run three or four minutes before the sponsor is even named, so
 *  the reach backwards is generous. */
const REFINE_BEFORE = 45;
const REFINE_AFTER = 40;

const NO_START = 'none';
const RUNS_PAST_EXCERPT = 'continues_past_excerpt';

/** Lines of context on each side of a boundary line in the cut pass. */
const CUT_CONTEXT_LINES = 3;

/**
 * How sure the pipeline wants to be that a skip never eats content: a phrase
 * is only skipped when it is sponsor with at least this probability. Sitting
 * through a second of a sponsor read is the price of never cutting a second
 * of the video.
 */
export const KEEP_CONTENT = 0.8;

/**
 * What counts as a sponsor segment. Written for a model that reads literally:
 * the lead-in is spelled out because the naive reading ("the line that names
 * the sponsor") misses everything the creator says to set the pitch up.
 */
export const SPONSOR = {
  definition:
    'A sponsor segment is the part of a video that exists to promote a third party that paid ' +
    'for placement: a product, service, app or company. It is usually read by the creator.',
  shape: [
    'A sponsor segment normally has three parts, and it begins with the first one:',
    '1. a lead-in, where the creator leaves the subject of the video and starts a story, an anecdote, ' +
      'a problem, a question, a joke or a "quick break" whose only purpose is to arrive at the sponsor;',
    '2. the pitch, where the sponsor or its product is named and described;',
    '3. the offer, with a link, discount code, free trial, QR code or "link in the description".',
    'The lead-in can last several minutes and can sound like normal content until the sponsor is named. ' +
      'It still belongs to the sponsor segment from its first line.'
  ].join(' '),
  not_a_sponsor_segment: [
    'The creator promoting their own merchandise, membership, Patreon, newsletter, courses or other videos.',
    'Asking viewers to like, comment, subscribe or share.',
    'Thanking viewers, patrons or the crew.',
    'Content that stays on the subject of the video.'
  ]
};

/**
 * @typedef {import('./transcript.js').Line} Line
 * @typedef {{ line: Line|null, probability: number, presence: number,
 *             pNone: number, windowIndex: number }} Candidate
 */

/** One scan request: "is a sponsor segment in here, and where is the sponsor named?" */
export function scanQuestions(lines) {
  /** @type {Record<string, null|string>} */
  const options = {};
  for (const line of lines) options[line.id] = null;
  options[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  return {
    sponsor_starts_here: {
      type: 'noul',
      instructions: {
        question: 'Does a sponsor segment begin somewhere in this excerpt of the video transcript?',
        ...SPONSOR
      },
      criteria: {
        true: 'Somewhere in this excerpt the creator leaves the subject of the video and starts a sponsor segment: a lead-in, a pitch or an offer for a paying third party.',
        false: 'No sponsor segment begins in this excerpt. Either it is all regular content, or a sponsor segment that started before this excerpt is still running through it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'For example "thanks to X for sponsoring", "X is an app that", "today\'s video is brought to you by X", ' +
          'or a discount code or link for X. Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Refine, request one: confirm the segment, pin the line that names the
 * sponsor, and find the last line.
 */
export function anchorQuestions(lines) {
  /** @type {Record<string, null|string>} */
  const anchorOptions = {};
  for (const line of lines) anchorOptions[line.id] = null;
  anchorOptions[NO_START] = 'No line in this excerpt names a sponsor, its product or its offer.';

  /** @type {Record<string, null|string>} */
  const endOptions = {};
  for (const line of lines) endOptions[line.id] = null;
  endOptions[RUNS_PAST_EXCERPT] = 'The sponsor segment is still running at the end of this excerpt.';
  endOptions[NO_START] = 'This excerpt contains no sponsor segment.';

  return {
    has_sponsor: {
      type: 'noul',
      instructions: { question: 'Does this excerpt of the video transcript contain a sponsor segment?', ...SPONSOR },
      criteria: {
        true: 'A sponsor segment for a paying third party is in this excerpt: its lead-in, its pitch, its offer, or all three.',
        false: 'This excerpt is the video\'s own content with no sponsor segment in it.'
      }
    },
    anchor_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the first line that names the sponsor, its product, or its offer? ' +
          'Choose the first such line, not the lead-in before it.',
        ...SPONSOR
      },
      criteria: anchorOptions
    },
    end_line: {
      type: 'choice',
      instructions: {
        question:
          'Which labelled line is the LAST line of the sponsor segment: the final line of the pitch or the offer, ' +
          'after which the creator returns to the video\'s own content, signs off, or the video ends?',
        ...SPONSOR
      },
      criteria: endOptions
    }
  };
}

/**
 * Refine, request two: with the naming line known and in the state, read
 * backwards for the first line of the lead-in.
 */
export function startQuestions(lines) {
  /** @type {Record<string, null|string>} */
  const options = {};
  for (const line of lines) options[line.id] = null;

  return {
    start_line: {
      type: 'choice',
      instructions: {
        question:
          'The sponsor is named on the line given in `sponsor_named_at`. Reading backwards from that line, ' +
          'which labelled line is the FIRST line of the sponsor segment: the moment the creator leaves the ' +
          'subject of the video (`video_title`) and begins the lead-in that ends at the sponsor?',
        rules: [
          'The lead-in belongs to the sponsor segment from its first line, even when it sounds like a personal story, an anecdote, a problem or a question and the sponsor is only named minutes later.',
          'Lines that are still about the subject of the video are not part of the sponsor segment, even the ones immediately before it.',
          'A closing call for comments, likes or subscriptions belongs to the video, not to the sponsor segment.',
          'If there is no lead-in and the segment opens by naming the sponsor, choose the line given in `sponsor_named_at`.'
        ],
        ...SPONSOR
      },
      criteria: options
    }
  };
}

/**
 * Cut pass: the lines at a boundary split into phrases of a few words, and
 * one noul per phrase: is this phrase part of the sponsor segment? Asking per
 * phrase rather than "which phrase is first" keeps each judgment narrow, and
 * the answers read as a profile that code cuts at (see cutPoint).
 * @param {import('./transcript.js').Phrase[]} phrases
 */
export function cutQuestions(phrases) {
  const questions = {};
  for (const phrase of phrases) {
    questions[phrase.id] = {
      type: 'noul',
      instructions: {
        question:
          `Does phrase ${phrase.id} in \`phrases\` belong to the sponsor segment rather than to the video's own content? ` +
          'The phrases are consecutive pieces of the transcript, a few words each; `before` and `after` are the ' +
          'surrounding transcript, and the sponsor is named at `sponsor_named_at_text`.',
        ...SPONSOR
      },
      criteria: {
        true: `Phrase ${phrase.id} is part of the sponsor segment: its lead-in, its pitch or its offer.`,
        false: `Phrase ${phrase.id} is the video's own content: on the subject of the video (\`video_title\`), a hand-back like "now back to the video", a sign-off, or a call to like, comment or subscribe.`
      }
    };
  }
  return questions;
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
 *           title?: string, onProgress?: (e: any) => void }} opts
 */
export async function findSponsorSegment(lines, opts) {
  const client = opts?.client;
  if (!client) throw new Error('findSponsorSegment needs a client with systemOne()');
  const model = opts.model;
  const title = opts.title ?? 'unknown';
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
      video_title: title,
      video_transcript_excerpt: renderLines(windowLines_),
      excerpt_position: `part ${index + 1} of ${total} of the video`
    };
    const result = await ask(state, scanQuestions(windowLines_));
    const presence = result.answers.sponsor_starts_here.noul;
    const pick = bestLabel(result.answers.anchor_line.probabilities, new Set(windowLines_.map((l) => l.id)));
    report({ stage: 'scan', window: index, presence });
    return {
      index,
      lines: windowLines_,
      from: windowLines_[0].start,
      to: windowLines_[windowLines_.length - 1].end,
      presence,
      pNone: result.answers.anchor_line.probabilities[NO_START] ?? 0,
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

    const segment = await refine(winner, lines, taken, ask, report, title);
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

/**
 * Pin down one candidate. Two requests: the first confirms the segment and
 * finds the line naming the sponsor and the last line; the second, with that
 * naming line written into the state, reads backwards for the first line of
 * the lead-in. Returns null when the refine pass rejects the candidate.
 */
async function refine(winner, lines, taken, ask, report, title) {
  const centre = lines.findIndex((l) => l.id === winner.startLineId);
  const from = Math.max(0, centre - REFINE_BEFORE);
  const slice = lines.slice(from, Math.min(lines.length, centre + REFINE_AFTER)).filter((l) => !taken.has(l.id));
  if (slice.length < 2) return null;
  report({ stage: 'refine', lines: slice.length });

  const allowed = new Set(slice.map((l) => l.id));
  const byId = new Map(slice.map((l) => [l.id, l]));
  const position = `an excerpt from the video, starting around ${Math.round(slice[0].start)} seconds in`;

  const anchored = await ask(
    { video_title: title, video_transcript_excerpt: renderLines(slice), excerpt_position: position },
    anchorQuestions(slice)
  );

  const presence = anchored.answers.has_sponsor.noul;
  if (presence < MAYBE) return null;

  const anchorPick = bestLabel(anchored.answers.anchor_line.probabilities, allowed);
  const endPick = bestLabel(anchored.answers.end_line.probabilities, allowed);
  const endRunsOn = anchored.answers.end_line.probabilities[RUNS_PAST_EXCERPT] ?? 0;
  const anchorLine = byId.get(anchorPick.id) ?? byId.get(winner.startLineId) ?? slice[0];
  const anchorIndex = slice.indexOf(anchorLine);

  // Second request: the lines up to and including the naming line, with the
  // naming line spelled out in the state so the model reads backwards from it.
  const before = slice.slice(0, anchorIndex + 1);
  let startLine = anchorLine;
  let startProbability = anchorPick.probability;
  if (before.length > 1) {
    const traced = await ask(
      {
        video_title: title,
        video_transcript_excerpt: renderLines(before),
        sponsor_named_at: anchorLine.id,
        sponsor_named_at_text: anchorLine.text,
        excerpt_position: position
      },
      startQuestions(before)
    );
    const startPick = bestLabel(traced.answers.start_line.probabilities, new Set(before.map((l) => l.id)));
    if (startPick.id) {
      startLine = byId.get(startPick.id);
      startProbability = startPick.probability;
    }
  }

  const endLine = byId.get(endPick.id);
  const endOk = endLine && endRunsOn < endPick.probability && endLine.end > startLine.start;

  const startIndex = slice.indexOf(startLine);
  const endIndex = endOk ? slice.indexOf(endLine) : Math.min(slice.length - 1, anchorIndex + BLIND_MASK_LINES);
  const lineIds = slice.slice(startIndex, endIndex + 1).map((l) => l.id);

  // Third request(s): where inside the first and last lines the segment
  // really begins and ends. Both edges are independent, so they run together.
  report({ stage: 'cut' });
  const [startCut, endCut] = await Promise.all([
    cut(lines, startLine, 'start', ask, title, anchorLine),
    endOk ? cut(lines, endLine, 'end', ask, title, anchorLine) : null
  ]);

  return {
    confidence: Math.min(winner.presence, presence),
    scanPresence: winner.presence,
    refinePresence: presence,
    start: {
      lineId: startLine.id,
      seconds: startCut?.seconds ?? startLine.start,
      lineSeconds: startLine.start,
      text: startLine.text,
      probability: startProbability,
      phrase: startCut?.phrase ?? null
    },
    anchor: { lineId: anchorLine.id, seconds: anchorLine.start, text: anchorLine.text, probability: anchorPick.probability },
    end: endOk
      ? {
          lineId: endLine.id,
          seconds: endCut?.seconds ?? endLine.end,
          lineSeconds: endLine.end,
          text: endLine.text,
          probability: endPick.probability,
          runsPastExcerpt: endRunsOn,
          phrase: endCut?.phrase ?? null
        }
      : null,
    lineIds,
    context: slice
  };
}

/**
 * The cut pass for one edge: split the boundary line and its neighbours into
 * phrases, ask which phrases are sponsor, and cut where the answers say the
 * segment begins or ends. Returns null when the answers give no cut, in which
 * case the line-level boundary stands.
 */
async function cut(lines, line, edge, ask, title, anchorLine) {
  const at = lines.indexOf(line);
  if (at < 0) return null;
  const phrases = buildPhrases(lines.slice(Math.max(0, at - 1), at + 2));
  if (phrases.length < 2) return null;
  const before = lines.slice(Math.max(0, at - 1 - CUT_CONTEXT_LINES), Math.max(0, at - 1));
  const after = lines.slice(at + 2, at + 2 + CUT_CONTEXT_LINES);

  const result = await ask(
    {
      video_title: title,
      before: before.map((l) => l.text).join(' ') || '(start of the video)',
      phrases: phrases.map((p) => `${p.id}| ${p.text}`).join('\n'),
      after: after.map((l) => l.text).join(' ') || '(end of the video)',
      sponsor_named_at_text: anchorLine.text
    },
    cutQuestions(phrases)
  );
  const inSponsor = phrases.map((p) => result.answers[p.id]?.noul ?? 0);
  const index = cutPoint(inSponsor, edge);
  if (index < 0) return null;
  const phrase = phrases[index];
  return {
    seconds: edge === 'start' ? phrase.start : phrase.end,
    phrase: { id: phrase.id, text: phrase.text, start: phrase.start, end: phrase.end, probability: inSponsor[index] }
  };
}

/** A phrase this likely to be sponsor still counts as part of a run that a surer phrase started. */
const IN_RUN = 0.5;

/**
 * Where to cut, given how likely each consecutive phrase is to be sponsor.
 *
 * Only a phrase that is sponsor with at least KEEP_CONTENT probability gets
 * skipped, so doubt always falls on the side of watching a little of the read
 * rather than losing content. The start is the first such phrase whose
 * neighbour after it is at least plausibly sponsor too (one phrase alone does
 * not start a segment); the end is the last such phrase whose neighbour before
 * it is. Returns the phrase index, or -1 when no phrase qualifies.
 * @param {number[]} inSponsor  one probability per phrase, in transcript order
 * @param {'start'|'end'} edge
 */
export function cutPoint(inSponsor, edge) {
  const n = inSponsor.length;
  if (edge === 'start') {
    for (let i = 0; i < n; i++) {
      if (inSponsor[i] >= KEEP_CONTENT && (i === n - 1 || inSponsor[i + 1] >= IN_RUN)) return i;
    }
    return -1;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (inSponsor[i] >= KEEP_CONTENT && (i === 0 || inSponsor[i - 1] >= IN_RUN)) return i;
  }
  return -1;
}

function summarise(scan) {
  const { lines: _lines, ...rest } = scan;
  return rest;
}
