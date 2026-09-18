import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The extension ships its own copy of the pipeline (Chrome cannot load files
// outside the extension folder). `npm run build:ext` refreshes it.
for (const name of ['transcript.js', 'jev.js', 'live.js']) {
  test(`extension/lib/${name} matches src/${name}`, async () => {
    const a = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    const b = await readFile(new URL(`../extension/lib/${name}`, import.meta.url), 'utf8');
    assert.equal(b, a, `run: npm run build:ext`);
  });
}
