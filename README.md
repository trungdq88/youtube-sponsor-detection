# Sponsor Skip

Paste a YouTube link, get the timestamps of the sponsor reads. Or install the
Chrome extension and have them skipped while you watch.

The transcript is fetched from YouTube, split into short labelled lines, and
**Jev** (TypeSafe's System One model) picks the line where the sponsor read
begins. Code owns the timestamps; Jev only ever names a line.

![screenshot](docs-screenshot.png)

## Run it

You need Node 20+ and a TypeSafe API key.

```sh
npm install
cp .env.example .env      # put your TYPESAFE_API_KEY in here
npm start                 # http://localhost:3000
```

Paste a link and press **Find the sponsor**. If YouTube has no transcript for
the video (captions off, or a fetch hiccup), use **Paste a transcript instead**:
open the video on YouTube, choose *Show transcript*, copy it in. Timestamps are
kept when they are included.

### Without a key

To look at the UI without a key, run a local stand-in for the TypeSafe API. It
answers with keyword spotting, so it only proves the plumbing, not the model.

```sh
node test/mock-typesafe-api.js &
TYPESAFE_API_KEY=local TYPESAFE_BASE_URL=http://127.0.0.1:4010 npm start
```

Then click **Try it on the demo transcript**.

## Chrome extension

The `extension/` folder is a Manifest V3 extension that runs on YouTube watch
pages, finds the sponsor reads with Jev, marks them on the progress bar and
skips them automatically.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and pick the `extension/` folder.
2. Click the extension's icon and paste your TypeSafe API key.
3. Open any YouTube video. A panel appears bottom-right with the segments,
   an auto-skip toggle, a skip button per read, and the stats.

The popup holds the settings (auto-skip on/off, the confidence a read needs
before it is skipped automatically, the model, and the price used for the cost
estimate) and the running totals: videos analysed, Jev requests, tokens, the
estimated cost, reads skipped and time saved. Results are cached per video, so
re-watching costs nothing; **Re-analyze** in the panel forces a fresh run.

![extension](docs-extension.png)

The extension talks to TypeSafe directly from its background worker; the key
lives in `chrome.storage.local` on your machine and never reaches the page.
Captions come from YouTube's player data for the current video (with a
fallback to the watch page HTML), fetched as `json3` from within the page, so
there is no server to run. The pipeline is the same code as the web app:
`extension/lib/` is a copy of `src/`, refreshed with `npm run build:ext`
(`npm test` fails if the copy drifts).

`npm run test:ext` runs the extension in headless Chromium against a stand-in
youtube.com page (Playwright routes the requests), covering injection, caption
extraction, the panel, markers, auto-skip and the popup. It needs
`npx playwright install chromium` once.

## How the Jev call works

Jev answers typed questions (yes/no probabilities, choices with a probability
distribution) over some *state*; it does not generate text. Two things from the
docs shaped the design:

- Jev reads times and numbers as text, not as ordered quantities. So it is never
  asked for a timestamp. The transcript is rendered as `L042| …` lines, Jev picks
  an ID, and code maps that back to seconds. This is the pattern from the
  [semantic find cookbook](https://docs.typesafe.ai/cookbooks/semantic_find).
- State and questions share a 32k / 64k token budget, and accuracy drops with
  irrelevant material in the state. So long transcripts are scanned in windows
  of 80 lines (roughly ten minutes each) rather than in one go.

The pipeline is in `src/jev.js`. Every question carries the same definition
of a sponsor segment, written for a model that reads literally: a **lead-in**
(a story, an anecdote, a problem, a "quick break" that exists only to arrive
at the sponsor, and can run for minutes before the sponsor is named), then the
**pitch**, then the **offer**. The segment starts at the lead-in. Merch,
memberships, "like and subscribe" and thanks are spelled out as not sponsor
segments. The video title goes into the state so "leaving the subject of the
video" means something.

1. **Scan.** One request per window, all in parallel: a *noul* ("does a
   sponsor segment begin in this excerpt?") and a *choice* over the window's
   line IDs plus `none` for the line that first **names** the sponsor. The
   naming line is the easy, reliable anchor; the start is found from it.
2. **Anchor.** One request over the ~85 lines around the winner (45 before,
   40 after): a confirming *noul*, the naming line again, and the last line
   of the segment (with a "continues past this excerpt" option).
3. **Trace back.** One request over the lines up to and including the naming
   line, with that line written into the state (`sponsor_named_at`), asking
   for the first line of the segment: the moment the creator leaves the video's
   subject to begin the lead-in. Jev does not do multi-hop reasoning well, so
   the anchor is given rather than left for it to find.
4. **Repeat.** The confirmed segment's lines are removed from its window, the
   window is scanned again, and the loop continues until no window looks like
   it still has a segment starting in it (capped at six).

To check the questions against a real video, run
`npm run analyze -- https://www.youtube.com/watch?v=…` with the key in `.env`.
It prints each segment with its start, naming and end lines and the transcript
around them (`--verbose` adds every scan window, `--json` dumps everything).

Confidence bands follow the cookbook (0.7 = found, 0.35 = maybe); tune them on
real videos. The UI shows every window's probability under *What Jev returned*.

## Measuring accuracy against SponsorBlock

[SponsorBlock](https://sponsor.ajay.app) has community-labelled sponsor
segments for millions of videos. Two scripts use them as ground truth:

```sh
npm run sample     # picks ~20 labelled videos from a database mirror -> eval/videos.json
npm run eval       # transcript + Jev for each, scored against the labels
```

`sample` never downloads the export (sponsorTimes.csv is about 7 GB): it
reads a few random 8 MB byte ranges from `https://sb.ltn.fi/database/`, keeps
sponsor segments that are locked or have at least two votes, merges overlapping
submissions, and prefers videos of 4–45 minutes with the best-agreed labels.
`--count`, `--slices`, `--slice-mb` and `--mirror` adjust it.

`eval` prints, per video, the labelled and predicted segments side by side,
then recall (labelled segments found, i.e. start within 15 s or IoU ≥ 0.5),
precision, median start and end error in seconds, and the token cost. Jev
results are cached in `eval/cache/`; pass `--fresh` after changing the
questions, `--limit N` to score a few, `--tolerance S` to change the window.
`eval/videos.seed.json` holds hand-picked videos and is always included.

## Layout

```
extension/           Chrome extension (MV3); lib/ is a copy of src/
server.js            Express server; keeps the API key server-side
src/youtube.js       link parsing, transcript fetch (youtubei.js), pasted-transcript parser
src/transcript.js    cues -> labelled lines, windowing, timestamp formatting
src/jev.js           the questions and the two-stage pipeline
public/              the page
fixtures/            synthetic transcripts: a plain read at 1:27, and an outro with a long lead-in
scripts/analyze.js   run the pipeline on a real video and print the boundaries
scripts/sponsorblock-sample.js   sample labelled videos from a SponsorBlock mirror
scripts/eval.js      score the pipeline against those labels
src/sponsorblock.js  CSV parsing and label filtering for the above
eval/                sampled videos, seed videos, cached runs and results
test/                node --test suite, a stub client, and the mock API server
```

`npm test` runs the suite against the stub client.

## Known limits

- Transcript fetching uses `youtubei.js`, which talks to YouTube's private
  InnerTube API. It works without any YouTube key but can break when YouTube
  changes things; the paste box is the fallback.
- Boundaries are line-granular (lines are about 7 seconds), so a skip lands
  within a few seconds of the real cut.
