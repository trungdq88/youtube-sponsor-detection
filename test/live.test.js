import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveController, listenQuestions, verifyQuestions, renderHeard } from '../src/live.js';

const S = 1000;

/** Answers "sponsor" when the most recent line mentions a sponsor marker. */
function keywordAnswer(request) {
  const text = Object.values(request.state).join('\n').toLowerCase();
  const last = text.split('\n').pop();
  const sponsor = /nordvpn|promo code|sponsor/.test(last);
  const name = Object.keys(request.questions)[0];
  return { answers: { [name]: { type: 'noul', noul: sponsor ? 0.92 : 0.06 } }, usage: { input_tokens: 100, output_tokens: 1 } };
}

function feed(ctl, t0, lines, each = 3) {
  let t = t0;
  for (const text of lines) {
    ctl.hear({ text, heardAt: t, heardUntil: t + each * S });
    t += each * S;
  }
  return t;
}

test('questions carry the shared sponsor definition and one noul each', () => {
  const listen = listenQuestions();
  assert.equal(listen.sponsor_now.type, 'noul');
  assert.match(listen.sponsor_now.instructions.definition, /paid for placement/);
  assert.equal(verifyQuestions().sponsor_continues.type, 'noul');
  assert.equal(renderHeard([{ text: 'a' }, { text: 'b' }], 'B'), 'B001| a\nB002| b');
});

test('stays quiet until enough words are heard, then asks at most every few seconds', () => {
  const ctl = createLiveController({ minWordsBeforeCheck: 6, checkEverySeconds: 4 });
  let now = 100 * S;
  assert.equal(ctl.next(now), null);
  now = feed(ctl, now, ['one two three']);
  assert.equal(ctl.next(now), null, 'three words is not enough');
  now = feed(ctl, now, ['four five six seven']);
  const request = ctl.next(now);
  assert.ok(request, 'asks once enough was heard');
  assert.match(request.state.recent_lines_heard_from_the_video, /^L001\| one two three\nL002\| four five six seven$/);
  assert.equal(ctl.next(now), null, 'one question in flight at a time');
  assert.equal(ctl.answer(keywordAnswer(request), now), null);
  now = feed(ctl, now, ['eight nine']);
  assert.equal(ctl.next(now), null, 'too soon after the last question');
  assert.ok(ctl.next(now + 2 * S));
});

test('skips when Jev hears a sponsor, verifies after the jump, and stops when content is back', () => {
  const ctl = createLiveController({ minWordsBeforeCheck: 4, checkEverySeconds: 0, minHeardAfterSkipSeconds: 6, contextLinesBeforeSkip: 2 });
  let now = 0;
  now = feed(ctl, now, ['today we look at the new engine', 'but first this video is sponsored by nordvpn']);
  let request = ctl.next(now);
  const action = ctl.answer(keywordAnswer(request), now);
  assert.deepEqual(action, { skipSeconds: 10 });

  // The seek happens; audio from just before it still trickles in and is ignored.
  ctl.skipped(now);
  assert.equal(ctl.phase, 'verifying');
  ctl.hear({ text: 'nordvpn keeps you safe', heardAt: now - 2 * S, heardUntil: now - 0.5 * S });
  assert.equal(ctl.next(now + 1 * S), null, 'nothing heard after the jump yet');

  // Six seconds after the jump the pitch is still running.
  now = feed(ctl, now + 1 * S, ['use promo code engine for a discount', 'that is thirty days risk free promo code']);
  request = ctl.next(now);
  assert.ok(request, 'asks once six seconds were heard after the jump');
  assert.match(request.state.before_the_jump, /^B001\| today we look/);
  assert.match(request.state.after_the_jump, /^A001\| use promo code/);
  assert.ok(request.questions.sponsor_continues);
  assert.deepEqual(ctl.answer(keywordAnswer(request), now), { skipSeconds: 10 });
  ctl.skipped(now);
  assert.equal(ctl.consecutiveSkips, 2);

  // After the second jump the creator is back on the subject: no more skipping.
  now = feed(ctl, now, ['so the new engine has twelve cylinders', 'and the torque curve is flat']);
  request = ctl.next(now);
  assert.match(request.state.before_the_jump, /promo code/);
  assert.equal(ctl.answer(keywordAnswer(request), now), null);
  assert.equal(ctl.phase, 'listening');
  assert.equal(ctl.consecutiveSkips, 0);
  assert.ok(ctl.log.some((e) => e.kind === 'verify' && e.sponsor === false));
});

test('a paused video after a jump does not hang the controller', () => {
  const ctl = createLiveController({ minWordsBeforeCheck: 2, checkEverySeconds: 0, maxWaitAfterSkipSeconds: 20 });
  let now = 0;
  now = feed(ctl, now, ['sponsor time promo code']);
  ctl.answer(keywordAnswer(ctl.next(now)), now);
  ctl.skipped(now);
  assert.equal(ctl.next(now + 10 * S), null);
  assert.equal(ctl.next(now + 45 * S), null, 'gives up waiting');
  assert.equal(ctl.phase, 'listening');

  // With a little audio after a long wait it asks anyway rather than waiting forever.
  const ctl2 = createLiveController({ minWordsBeforeCheck: 2, checkEverySeconds: 0, maxWaitAfterSkipSeconds: 20 });
  now = 0;
  now = feed(ctl2, now, ['sponsor time promo code']);
  ctl2.answer(keywordAnswer(ctl2.next(now)), now);
  ctl2.skipped(now);
  ctl2.hear({ text: 'okay', heardAt: now + 1 * S, heardUntil: now + 2 * S });
  assert.equal(ctl2.next(now + 5 * S), null);
  assert.ok(ctl2.next(now + 25 * S));
});

test('a runaway read stops at the jump limit', () => {
  const ctl = createLiveController({ minWordsBeforeCheck: 2, checkEverySeconds: 0, minHeardAfterSkipSeconds: 1, maxConsecutiveSkips: 2 });
  let now = 0;
  now = feed(ctl, now, ['promo code sponsor']);
  assert.ok(ctl.answer(keywordAnswer(ctl.next(now)), now));
  ctl.skipped(now);
  now = feed(ctl, now, ['still promo code']);
  assert.ok(ctl.answer(keywordAnswer(ctl.next(now)), now));
  ctl.skipped(now);
  now = feed(ctl, now, ['still promo code']);
  assert.equal(ctl.answer(keywordAnswer(ctl.next(now)), now), null, 'limit reached');
  assert.equal(ctl.phase, 'listening');
});
