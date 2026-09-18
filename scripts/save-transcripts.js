// Save the transcript of every eval video into eval/transcripts/, so the eval
// can run from anywhere Jev is reachable, YouTube or not.
//
//   npm run transcripts              # fetch the ones not saved yet
//   npm run transcripts -- --force   # fetch them all again
//
// YouTube refuses caption requests from cloud and datacenter addresses, so
// this runs on a normal home connection once, and the files are committed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fetchTranscript } from '../src/youtube.js';
import { evalVideos, transcriptFile } from '../src/eval-videos.js';

const force = process.argv.includes('--force');
const videos = await evalVideos();
await mkdir('eval/transcripts', { recursive: true });

let saved = 0;
const failed = [];
for (const video of videos) {
  const file = transcriptFile(video.videoID);
  if (!force && existsSync(file)) {
    const { cues, route } = JSON.parse(await readFile(file, 'utf8'));
    console.log(`${video.videoID}  already saved (${cues.length} cues via ${route})`);
    continue;
  }
  process.stdout.write(`${video.videoID}  fetching … `);
  try {
    const { title, cues, route } = await fetchTranscript(video.videoID);
    const timed = cues.filter((c) => c.words?.length).length;
    await writeFile(file, JSON.stringify({ videoID: video.videoID, title, route, savedAt: new Date().toISOString(), cues }, null, 1));
    console.log(`${cues.length} cues via ${route}${timed ? ` (${timed} with word timing)` : ''}: ${title}`);
    saved++;
  } catch (error) {
    console.log(`failed: ${error.message}${error.cause ? ` (${error.cause})` : ''}`);
    failed.push(video.videoID);
  }
}

console.log(`\n${saved} saved, ${failed.length} failed, ${videos.length} videos in total.`);
if (failed.length) console.log(`failed: ${failed.join(' ')}`);
if (saved) {
  console.log('\nNow commit them so the eval can run elsewhere:');
  console.log('  git add eval/transcripts && git commit -m "Save eval transcripts" && git push');
}
