import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, usableSegments, groupByVideo, wholeRows, hasNeededColumns } from '../src/sponsorblock.js';

const HEADER = 'videoID,startTime,endTime,votes,locked,incorrectVotes,UUID,userID,timeSubmitted,views,category,actionType,service,videoDuration,hidden,reputation,shadowHidden,hashedVideoID,userAgent,description';
const row = (o) =>
  [o.videoID, o.start, o.end, o.votes ?? 3, o.locked ?? 0, 0, 'u', 'user', 1, 10, o.category ?? 'sponsor', o.actionType ?? 'skip', o.service ?? 'YouTube', o.duration ?? 900, o.hidden ?? 0, 0, o.shadow ?? 0, 'h', '"ua, with comma"', o.desc ?? '""'].join(',');

test('csv rows parse, quotes and commas included', () => {
  const rows = parseCsv(`${HEADER}\n${row({ videoID: 'abcdefghijk', start: 10, end: 40, desc: '"say ""hi"", ok"' })}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].videoID, 'abcdefghijk');
  assert.equal(rows[0].userAgent, 'ua, with comma');
  assert.equal(rows[0].description, 'say "hi", ok');
  assert.ok(hasNeededColumns(Object.keys(rows[0])));
});

test('only agreed sponsor skips on YouTube survive the filter', () => {
  const rows = parseCsv([
    HEADER,
    row({ videoID: 'aaaaaaaaaaa', start: 10, end: 40 }),
    row({ videoID: 'bbbbbbbbbbb', start: 10, end: 40, votes: 0 }),
    row({ videoID: 'ccccccccccc', start: 10, end: 40, votes: -2, locked: 1 }),
    row({ videoID: 'ddddddddddd', start: 10, end: 40, category: 'selfpromo' }),
    row({ videoID: 'eeeeeeeeeee', start: 10, end: 40, hidden: 1 }),
    row({ videoID: 'fffffffffff', start: 10, end: 40, shadow: 1 }),
    row({ videoID: 'ggggggggggg', start: 10, end: 40, service: 'PeerTube' }),
    row({ videoID: 'hhhhhhhhhhh', start: 10, end: 40, actionType: 'full' })
  ].join('\n'));
  const ids = usableSegments(rows).map((s) => s.videoID);
  assert.deepEqual(ids, ['aaaaaaaaaaa', 'ccccccccccc']);
});

test('submissions are merged per video and odd lengths dropped', () => {
  const rows = parseCsv([
    HEADER,
    row({ videoID: 'aaaaaaaaaaa', start: 100, end: 160 }),
    row({ videoID: 'aaaaaaaaaaa', start: 98, end: 150, votes: 5 }),
    row({ videoID: 'aaaaaaaaaaa', start: 400, end: 460 }),
    row({ videoID: 'bbbbbbbbbbb', start: 5, end: 30, duration: 60 }),
    row({ videoID: 'ccccccccccc', start: 5, end: 30, duration: 5000 })
  ].join('\n'));
  const videos = groupByVideo(usableSegments(rows));
  assert.equal(videos.length, 1);
  assert.deepEqual(videos[0].segments.map((s) => [s.start, s.end, s.votes]), [[98, 160, 5], [400, 460, 3]]);
});

test('a byte-range slice is trimmed to whole rows', () => {
  assert.equal(wholeRows('tail of row\nfull row 1\nfull row 2\npartial', false), 'full row 1\nfull row 2');
  assert.equal(wholeRows('header\nfull row\npartial', true), 'header\nfull row');
  assert.equal(wholeRows('no newline at all', false), '');
});
