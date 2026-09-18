// Live mode: the sponsor read is found by listening, not by reading ahead.
//
// A speech API turns the tab's audio into short final utterances a second or
// two behind the video. Jev is asked, over the last minute or so of what was
// heard, whether the speaker is inside a sponsor segment *right now*. When it
// says yes the video jumps forward a fixed step, the controller waits until
// it has heard a few seconds after the jump, and asks again with the lines
// from before and after the jump side by side. Still a sponsor: jump again.
// Back on the subject: stop and go back to listening.
//
// There is no timestamp arithmetic to get wrong here, and no way to skip
// early: everything Jev sees has already been played. The price is that the
// first ten or so seconds of every read are heard, and the last jump can
// overshoot into content by up to one step.
//
// This file is pure: no DOM, no chrome.*, no clock of its own. The caller
// feeds it utterances and the time, and it hands back what to do next.

import { SPONSOR } from './jev.js';

export const DEFAULT_LIVE = {
  /** Seconds to jump each time the speaker is judged to be in a sponsor read. */
  skipSeconds: 10,
  /** Jev's confidence needed before jumping. */
  threshold: 0.7,
  /** Do not ask Jev more often than this while listening. */
  checkEverySeconds: 4,
  /** Words that need to be in the buffer before the first question. */
  minWordsBeforeCheck: 12,
  /** How much of the past is shown to Jev while listening. */
  windowSeconds: 75,
  /** Seconds of audio heard after a jump before asking whether it is still the sponsor. */
  minHeardAfterSkipSeconds: 6,
  /** Give up waiting for that much audio after this long (a paused video, silence). */
  maxWaitAfterSkipSeconds: 20,
  /** Consecutive jumps before the controller stops and goes back to listening. */
  maxConsecutiveSkips: 30,
  /** Lines from before the jump kept as context when verifying. */
  contextLinesBeforeSkip: 8
};

/**
 * @typedef {{ text: string, heardAt: number, heardUntil: number }} Utterance
 *   `heardAt`/`heardUntil` are epoch milliseconds of when that audio played.
 */

/** Listening: "is the speaker in a sponsor read at this very moment?" */
export function listenQuestions() {
  return {
    sponsor_now: {
      type: 'noul',
      instructions: {
        question:
          'These are the most recent lines heard from the video, in order, ending with the words being ' +
          'spoken right now. At the END of this excerpt, is the speaker inside a sponsor segment?',
        ...SPONSOR
      },
      criteria: {
        true:
          'The last lines of the excerpt belong to a sponsor segment: a lead-in that leaves the subject of the ' +
          'video to set up a sponsor, the pitch that names a paying third party or its product, or the offer ' +
          'with a code, link, trial or discount.',
        false:
          'The last lines are regular content of the video, or a sponsor segment has already ended and the ' +
          'creator is back on the subject.'
      }
    }
  };
}

/** Verifying: "we jumped ahead; is it still the sponsor read on the other side?" */
export function verifyQuestions() {
  return {
    sponsor_continues: {
      type: 'noul',
      instructions: {
        question:
          'The video was skipped forward because a sponsor segment was playing. `before_the_jump` holds the ' +
          'last lines heard before the skip and `after_the_jump` the lines heard since. After the jump, is the ' +
          'speaker still inside the sponsor segment?',
        ...SPONSOR
      },
      criteria: {
        true:
          'The lines after the jump still serve the sponsor: naming it, describing the product, giving the ' +
          'offer, code or link, or wrapping the read up.',
        false:
          'The lines after the jump have returned to the subject of the video, or moved on to something that ' +
          'is not a sponsor segment.'
      }
    }
  };
}

/** Render utterances as the labelled lines Jev reads everywhere else in this project. */
export function renderHeard(utterances, prefix = 'L') {
  return utterances.map((u, i) => `${prefix}${String(i + 1).padStart(3, '0')}| ${u.text}`).join('\n');
}

function words(utterances) {
  return utterances.reduce((n, u) => n + u.text.split(/\s+/).filter(Boolean).length, 0);
}

/**
 * The state machine. Drive it with `hear()` for every final utterance and
 * `next(now)` whenever something changed (a new utterance, a timer). `next`
 * returns either nothing or a request `{ state, questions }` for Jev; hand
 * Jev's answer to `answer()`, which returns either nothing or
 * `{ skipSeconds }`. Call `skipped(now)` after the seek actually happened.
 *
 * @param {Partial<typeof DEFAULT_LIVE>} [options]
 */
export function createLiveController(options = {}) {
  const opts = { ...DEFAULT_LIVE, ...options };

  /** @type {Utterance[]} */
  let heard = [];
  /** @type {Utterance[]} */
  let beforeSkip = [];
  let phase = 'listening'; // listening | verifying
  let pending = null; // the request out to Jev right now, if any
  let lastCheckAt = -Infinity;
  let heardSinceCheck = false;
  let skipWall = 0; // epoch ms of the last seek
  let consecutiveSkips = 0;
  const log = []; // last few decisions, for the panel

  function remember(entry) {
    log.push(entry);
    if (log.length > 20) log.shift();
  }

  return {
    get phase() {
      return phase;
    },
    get consecutiveSkips() {
      return consecutiveSkips;
    },
    get log() {
      return log.slice();
    },
    get heard() {
      return heard.slice();
    },

    /** @param {Utterance} u */
    hear(u) {
      const text = String(u.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      // Audio from before a seek keeps arriving for a second or two after it;
      // it is about the place we left, so it must not count as "after the jump".
      if (phase === 'verifying' && u.heardAt < skipWall) return;
      heard.push({ text, heardAt: u.heardAt, heardUntil: u.heardUntil });
      heardSinceCheck = true;
      const cutoff = u.heardUntil - opts.windowSeconds * 1000;
      if (phase === 'listening') heard = heard.filter((h) => h.heardUntil >= cutoff);
    },

    /** @param {number} now epoch ms */
    next(now) {
      if (pending) return null;
      if (phase === 'listening') {
        if (!heardSinceCheck || now - lastCheckAt < opts.checkEverySeconds * 1000) return null;
        if (words(heard) < opts.minWordsBeforeCheck) return null;
        pending = {
          kind: 'listen',
          request: {
            state: { recent_lines_heard_from_the_video: renderHeard(heard) },
            questions: listenQuestions()
          }
        };
      } else {
        const heardAfter = heard.length ? (heard[heard.length - 1].heardUntil - skipWall) / 1000 : 0;
        const waited = (now - skipWall) / 1000;
        if (heardAfter < opts.minHeardAfterSkipSeconds && waited < opts.maxWaitAfterSkipSeconds) return null;
        if (!heard.length) {
          // Nothing heard at all since the jump: silence or a pause. Keep waiting
          // a bit longer, then give up and listen normally again.
          if (waited < opts.maxWaitAfterSkipSeconds * 2) return null;
          remember({ at: now, kind: 'timeout' });
          this.reset();
          return null;
        }
        pending = {
          kind: 'verify',
          request: {
            state: {
              before_the_jump: renderHeard(beforeSkip, 'B'),
              after_the_jump: renderHeard(heard, 'A')
            },
            questions: verifyQuestions()
          }
        };
      }
      lastCheckAt = now;
      heardSinceCheck = false;
      return pending.request;
    },

    /**
     * Jev's answer to the last request.
     * @returns {null | { skipSeconds: number }}
     */
    answer(result, now = Date.now()) {
      if (!pending) return null;
      const kind = pending.kind;
      pending = null;
      const answers = result?.answers ?? {};
      const p = kind === 'listen' ? answers.sponsor_now?.noul : answers.sponsor_continues?.noul;
      const confidence = Number(p) || 0;
      const sponsor = confidence >= opts.threshold;
      remember({ at: now, kind, confidence, sponsor, heard: heard.map((h) => h.text).join(' ').slice(-160) });

      if (!sponsor) {
        if (kind === 'verify') this.reset();
        return null;
      }
      if (kind === 'verify' && consecutiveSkips >= opts.maxConsecutiveSkips) {
        remember({ at: now, kind: 'limit' });
        this.reset();
        return null;
      }
      return { skipSeconds: opts.skipSeconds };
    },

    /** The seek happened. From here on only audio heard after `now` counts. */
    skipped(now) {
      if (phase === 'listening') beforeSkip = heard.slice(-opts.contextLinesBeforeSkip);
      else beforeSkip = [...beforeSkip, ...heard].slice(-opts.contextLinesBeforeSkip);
      heard = [];
      heardSinceCheck = false;
      phase = 'verifying';
      skipWall = now;
      consecutiveSkips += 1;
    },

    /** Back to plain listening; what was heard after the last jump stays as context. */
    reset() {
      phase = 'listening';
      beforeSkip = [];
      consecutiveSkips = 0;
      pending = null;
    }
  };
}
