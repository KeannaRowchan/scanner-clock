import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as esm from '../src/scanner-clock.js';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cjs = require('../dist/scanner-clock.cjs');
const umd = require('../dist/scanner-clock.umd.js');

// The three builds come from one source file, so the only way they can diverge
// is a stale dist. These tests are what catches that before a publish.
test('dist builds', async t => {
  await t.test('expose the same API as the ESM source', () => {
    for (const build of [cjs, umd]) {
      assert.equal(typeof build.create, 'function');
      assert.equal(typeof build.createScannerClock, 'function');
      assert.equal(build.VERSION, esm.VERSION);
      assert.deepEqual(Object.keys(build.DEFAULTS).sort(), Object.keys(esm.DEFAULTS).sort());
    }
  });

  await t.test('behave identically', async () => {
    for (const build of [esm, cjs, umd]) {
      const clock = build.create({ trMs: 20, guardMs: 8, target: null, doc: null });
      const p = clock.awaitTriggers(2);
      clock.pulse();
      clock.pulse();
      await p;
      assert.equal(clock.count, 2);
      assert.equal(clock.snapshot().version, esm.VERSION);
      clock.destroy();
    }
  });

  await t.test('are up to date with the source', () => {
    const before = [
      readFileSync(join(root, 'dist/scanner-clock.cjs'), 'utf8'),
      readFileSync(join(root, 'dist/scanner-clock.umd.js'), 'utf8'),
    ];
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'pipe' });
    const after = [
      readFileSync(join(root, 'dist/scanner-clock.cjs'), 'utf8'),
      readFileSync(join(root, 'dist/scanner-clock.umd.js'), 'utf8'),
    ];
    assert.deepEqual(after, before, 'dist/ is stale — run `npm run build` and commit the result');
  });

  await t.test('version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(esm.VERSION, pkg.version);
  });
});
