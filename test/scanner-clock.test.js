import test from 'node:test';
import assert from 'node:assert/strict';
import { create, VERSION } from '../src/scanner-clock.js';
import { makeEnv, realKey, fauxKey, textField, tick } from './helpers/dom.js';

// Tests use a short TR so the suite runs in well under a second. The logic
// under test is scale-free: nothing in the module depends on TR being 1s.
const TR = 20;
const GUARD = 8;

const mk = (opts = {}) => {
  const env = makeEnv();
  const clock = create({ trMs: TR, guardMs: GUARD, target: env.win, doc: env.doc, ...opts });
  return { ...env, clock };
};

test('config validation', async t => {
  await t.test('guardMs must be smaller than trMs', () => {
    assert.throws(() => create({ trMs: 1000, guardMs: 1000, target: null, doc: null }),
      /guardMs must be smaller than trMs/);
  });

  await t.test('trMs must be positive', () => {
    assert.throws(() => create({ trMs: 0, target: null, doc: null }),
      /trMs must be a positive number/);
  });

  await t.test('fauxFives defaults to false — the option that fails loudly', () => {
    const { clock } = mk();
    assert.equal(clock.fauxFives, false);
    assert.equal(clock.start(), false, 'start() is a no-op when fauxFives is off');
    clock.destroy();
  });

  await t.test('legacy spellings still work', () => {
    const a = create({ trMs: TR, guardMs: GUARD, faux_fives: true, target: null, doc: null });
    const b = create({ trMs: TR, guardMs: GUARD, mode: 'faux', target: null, doc: null });
    assert.equal(a.fauxFives, true);
    assert.equal(b.fauxFives, true);
    a.destroy(); b.destroy();
  });
});

test('pulse counting', async t => {
  await t.test('counts the configured key and ignores others', () => {
    const { win, clock } = mk();
    win.dispatchEvent(realKey('5'));
    win.dispatchEvent(realKey('a'));
    win.dispatchEvent(realKey('6'));
    win.dispatchEvent(realKey('5'));
    assert.equal(clock.count, 2);
    clock.destroy();
  });

  await t.test('accepts an array of keys', () => {
    const { win, clock } = mk({ key: ['5', 't', '='] });
    win.dispatchEvent(realKey('t'));
    win.dispatchEvent(realKey('='));
    win.dispatchEvent(realKey('5'));
    win.dispatchEvent(realKey('x'));
    assert.equal(clock.count, 3);
    clock.destroy();
  });

  await t.test('a "5" typed into a text field is an answer, not a volume', () => {
    const { win, clock } = mk();
    win.dispatchEvent(realKey('5', textField('INPUT')));
    win.dispatchEvent(realKey('5', textField('TEXTAREA')));
    win.dispatchEvent(realKey('5', { tagName: 'DIV', isContentEditable: true }));
    assert.equal(clock.count, 0);
    win.dispatchEvent(realKey('5', { tagName: 'DIV', isContentEditable: false }));
    assert.equal(clock.count, 1, 'a plain div is not text entry');
    clock.destroy();
  });

  await t.test('ignoreTextEntry:false counts them anyway', () => {
    const { win, clock } = mk({ ignoreTextEntry: false });
    win.dispatchEvent(realKey('5', textField()));
    assert.equal(clock.count, 1);
    clock.destroy();
  });

  await t.test('provenance is tracked separately', () => {
    const { win, clock } = mk();
    win.dispatchEvent(realKey('5'));
    win.dispatchEvent(fauxKey('5'));
    clock.pulse();
    assert.equal(clock.count, 3);
    assert.equal(clock.realPulses, 1);
    assert.equal(clock.fauxPulses, 1);
    assert.equal(clock.manualPulses, 1);
    clock.destroy();
  });
});

test('awaitTriggers / awaitCount', async t => {
  await t.test('resolves after exactly n pulses', async () => {
    const { pulses, clock } = mk();
    let done = false;
    const p = clock.awaitTriggers(3).then(() => { done = true; });
    pulses(2);
    await tick(0);
    assert.equal(done, false, 'not yet at 3');
    pulses(1);
    await p;
    assert.equal(clock.count, 3);
    clock.destroy();
  });

  await t.test('awaitCount resolves immediately when already past the target', async () => {
    const { pulses, clock } = mk();
    pulses(5);
    assert.equal(await clock.awaitCount(3), 5);
    clock.destroy();
  });

  await t.test('a single pulse releases several waiters at once', async () => {
    const { pulses, clock } = mk();
    const order = [];
    const ps = [
      clock.awaitCount(1).then(() => order.push(1)),
      clock.awaitCount(1).then(() => order.push(2)),
      clock.awaitCount(2).then(() => order.push(3)),
    ];
    pulses(1);
    await tick(0);
    assert.deepEqual(order, [1, 2]);
    pulses(1);
    await Promise.all(ps);
    assert.deepEqual(order, [1, 2, 3]);
    clock.destroy();
  });

  await t.test('awaitTriggers(0) resolves now', async () => {
    const { clock } = mk();
    assert.equal(await clock.awaitTriggers(0), 0);
    clock.destroy();
  });

  await t.test('an AbortSignal rejects the wait', async () => {
    const { clock } = mk();
    const ac = new AbortController();
    const p = clock.awaitTriggers(5, ac.signal);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(clock.snapshot().pendingWaits, 0, 'aborted waiter is removed');
    clock.destroy();
  });
});

test('hold', async t => {
  await t.test('ends on the pulse that completes the requested volumes', async () => {
    const { win, clock } = mk();
    // Drive pulses on a real interval so the sleep and the pulses interleave
    // the way they do in the scanner.
    const iv = setInterval(() => win.dispatchEvent(realKey('5')), TR);
    try {
      await clock.awaitRunStart();
      const start = clock.count;
      await clock.hold(TR * 3);
      assert.equal(clock.count - start, 3, 'a 3-TR hold costs exactly 3 volumes');
    } finally {
      clearInterval(iv);
      clock.destroy();
    }
  });

  await t.test('resolves immediately when the sleep overshot the pulse', async () => {
    // The hidden-tab case: the target volume has already arrived by the time
    // the sleep returns, so the hold must NOT wait a further whole TR.
    const { pulses, clock } = mk();
    const t0 = Date.now();
    const p = clock.hold(TR * 2);
    pulses(2);              // both volumes land before the sleep finishes
    await p;
    const elapsed = Date.now() - t0;
    assert.equal(clock.count, 2);
    assert.ok(elapsed < TR * 3, `resolved in ${elapsed}ms, no extra TR paid`);
    clock.destroy();
  });

  await t.test('hold(0) is free', async () => {
    const { clock } = mk();
    await clock.hold(0);
    assert.equal(clock.count, 0);
    clock.destroy();
  });

  await t.test('onWaitStart fires before the trailing pulse-wait', async () => {
    const { pulses, clock } = mk();
    const seen = [];
    const p = clock.hold(TR, { onWaitStart: v => seen.push(v) });
    await tick(TR);
    pulses(1);
    await p;
    assert.deepEqual(seen, [0], 'fired once, before the pulse arrived');
    clock.destroy();
  });

  await t.test('onWaitStart may still be passed positionally', async () => {
    const { pulses, clock } = mk();
    let fired = 0;
    const p = clock.hold(TR, () => fired++);
    await tick(TR);
    pulses(1);
    await p;
    assert.equal(fired, 1);
    clock.destroy();
  });

  await t.test('sub-TR durations round to the nearest volume', () => {
    const { clock } = mk({ trMs: 1000, guardMs: 500 });
    assert.equal(clock.msToVolumes(1000), 1);
    assert.equal(clock.msToVolumes(1400), 1);
    assert.equal(clock.msToVolumes(1600), 2);
    assert.equal(clock.msToVolumes(6000), 6);
    assert.equal(clock.volumesToMs(4), 4000);
    clock.destroy();
  });

  await t.test('holdUntil targets a wall-clock deadline', async () => {
    const { win, clock } = mk();
    const iv = setInterval(() => win.dispatchEvent(realKey('5')), TR);
    try {
      await clock.awaitRunStart();
      const start = clock.count;
      await clock.holdUntil(Date.now() + TR * 2);
      assert.equal(clock.count - start, 2);
    } finally {
      clearInterval(iv);
      clock.destroy();
    }
  });

  await t.test('holds do not accumulate drift across a run', async () => {
    const { win, clock } = mk();
    const iv = setInterval(() => win.dispatchEvent(realKey('5')), TR);
    try {
      await clock.awaitRunStart();
      const start = clock.count;
      for (let i = 0; i < 10; i++) await clock.hold(TR);
      assert.equal(clock.count - start, 10, '10 one-TR holds cost exactly 10 volumes');
    } finally {
      clearInterval(iv);
      clock.destroy();
    }
  });
});

test('double-clock detection', async t => {
  await t.test('warns when real pulses arrive while fauxFives is on', () => {
    const { win, clock } = mk({ fauxFives: true, onLog: (e, d) => events.push([e, d]) });
    const events = [];
    const errors = [];
    const realError = console.error;
    console.error = m => errors.push(m);
    try {
      win.dispatchEvent(fauxKey('5'));
      win.dispatchEvent(realKey('5'));
      win.dispatchEvent(realKey('5'));
    } finally {
      console.error = realError;
    }
    assert.equal(errors.length, 1, 'warns once, not once per pulse');
    assert.match(errors[0], /twice as fast/);
    assert.equal(clock.snapshot().doubleClockDetected, true);
    clock.destroy();
  });

  await t.test('stays quiet when only real pulses arrive', () => {
    const { win, clock } = mk({ fauxFives: false });
    const errors = [];
    const realError = console.error;
    console.error = m => errors.push(m);
    try {
      win.dispatchEvent(realKey('5'));
    } finally {
      console.error = realError;
    }
    assert.equal(errors.length, 0);
    assert.equal(clock.snapshot().doubleClockDetected, false);
    clock.destroy();
  });
});

test('faux generator', async t => {
  await t.test('drives the same code path as real pulses', async () => {
    const { clock } = mk({ fauxFives: true });
    assert.equal(clock.start(), true);
    assert.equal(clock.running, true);
    await clock.awaitTriggers(3);
    clock.stop();
    assert.equal(clock.running, false);
    assert.equal(clock.fauxPulses, 3, 'counted as faux, not real');
    assert.equal(clock.realPulses, 0);
    clock.destroy();
  });

  await t.test('start() is idempotent', async () => {
    const { clock } = mk({ fauxFives: true });
    clock.start();
    clock.start();
    await tick(TR * 2.5);
    clock.stop();
    assert.ok(clock.count <= 3, `one generator only (count=${clock.count})`);
    clock.destroy();
  });

  await t.test('autoStart starts it during create()', async () => {
    const env = makeEnv();
    const clock = create({
      trMs: TR, guardMs: GUARD, fauxFives: true, autoStart: true,
      target: env.win, doc: env.doc,
    });
    assert.equal(clock.running, true);
    await clock.awaitTriggers(1);
    clock.destroy();
  });
});

test('logging and QC', async t => {
  await t.test('onLog receives run_start with the volume', async () => {
    const events = [];
    const { pulses, clock } = mk({ onLog: (e, d) => events.push([e, d]) });
    pulses(2);
    const p = clock.awaitRunStart({ run: 'localiser' });
    pulses(1);
    await p;
    const [event, data] = events.find(([e]) => e === 'run_start');
    assert.equal(event, 'run_start');
    assert.equal(data.volume, 3);
    assert.equal(data.run, 'localiser');
    clock.destroy();
  });

  await t.test('hold_end reports how many volumes the screen actually cost', async () => {
    const events = [];
    const { pulses, clock } = mk({ onLog: (e, d) => events.push([e, d]) });
    const p = clock.hold(TR * 2, { label: 'stimulus' });
    pulses(2);
    await p;
    const [, data] = events.find(([e]) => e === 'hold_end');
    assert.equal(data.label, 'stimulus');
    assert.equal(data.volumes, 2);
    assert.equal(data.endVolume - data.startVolume, 2);
    clock.destroy();
  });

  await t.test('on() subscribes and unsubscribes', () => {
    const { pulses, clock } = mk({ logPulses: true });
    const seen = [];
    const off = clock.on('pulse', d => seen.push(d.volume));
    pulses(2);
    off();
    pulses(2);
    assert.deepEqual(seen, [1, 2]);
    clock.destroy();
  });

  await t.test("on('*') sees every event", async () => {
    const { pulses, clock } = mk();
    const seen = [];
    clock.on('*', (_d, e) => seen.push(e));
    const p = clock.awaitRunStart();
    pulses(1);
    await p;
    assert.ok(seen.includes('run_start'));
    clock.destroy();
  });

  await t.test('a throwing log sink cannot break the clock', () => {
    const { pulses, clock } = mk({ logPulses: true, onLog: () => { throw new Error('boom'); } });
    const warns = [];
    const realWarn = console.warn;
    console.warn = m => warns.push(m);
    try {
      pulses(2);
      assert.equal(clock.count, 2, 'pulses still counted');
      assert.equal(warns.length, 2);
      clock.destroy();
    } finally {
      console.warn = realWarn;
    }
  });

  await t.test('hidden time is logged and totalled', async () => {
    const events = [];
    const { doc, clock } = mk({ onLog: (e, d) => events.push([e, d]) });
    doc.setVisibility('hidden');
    await tick(15);
    doc.setVisibility('visible');
    const changes = events.filter(([e]) => e === 'visibility_change');
    assert.equal(changes.length, 2);
    assert.ok(clock.hiddenMs >= 10, `hiddenMs=${clock.hiddenMs}`);
    assert.equal(clock.snapshot().visibilityChanges, 2);
    clock.destroy();
  });

  await t.test('snapshot carries everything QC needs', () => {
    const { pulses, clock } = mk();
    pulses(4);
    const s = clock.snapshot();
    assert.equal(s.version, VERSION);
    assert.equal(s.volume, 4);
    assert.equal(s.realPulses, 4);
    assert.equal(s.fauxPulses, 0);
    assert.deepEqual(s.key, ['5']);
    assert.equal(s.trMs, TR);
    assert.equal(s.destroyed, false);
    clock.destroy();
    assert.equal(clock.snapshot().destroyed, true);
  });
});

test('teardown', async t => {
  await t.test('destroy removes both listeners', () => {
    const { win, doc, clock } = mk();
    assert.equal(win.listenerCount('keydown'), 1);
    assert.equal(doc.listenerCount('visibilitychange'), 1);
    clock.destroy();
    assert.equal(win.listenerCount('keydown'), 0);
    assert.equal(doc.listenerCount('visibilitychange'), 0, 'visibility listener is removed too');
  });

  await t.test('pulses after destroy are ignored', () => {
    const { win, clock } = mk();
    clock.destroy();
    win.dispatchEvent(realKey('5'));
    clock.pulse();
    assert.equal(clock.count, 0);
  });

  await t.test('pending waits reject, so a task cannot silently advance', async () => {
    const { clock } = mk();
    const p = clock.awaitTriggers(5);
    clock.destroy();
    await assert.rejects(p, { name: 'ScannerClockDestroyedError' });
  });

  await t.test('destroy({settle:"resolve"}) releases them instead', async () => {
    const { clock } = mk();
    const p = clock.awaitTriggers(5);
    clock.destroy({ settle: 'resolve' });
    assert.equal(await p, 0);
  });

  await t.test('awaiting on a destroyed clock rejects rather than hanging', async () => {
    const { clock } = mk();
    clock.destroy();
    await assert.rejects(clock.awaitTriggers(1), { name: 'ScannerClockDestroyedError' });
  });

  await t.test('destroy is idempotent', () => {
    const { clock } = mk();
    clock.destroy();
    clock.destroy();
    assert.equal(clock.destroyed, true);
  });
});

test('headless use (no DOM at all)', async t => {
  await t.test('creates and runs off manual pulses', async () => {
    const clock = create({ trMs: TR, guardMs: GUARD, target: null, doc: null });
    const p = clock.awaitTriggers(2);
    clock.pulse();
    clock.pulse();
    await p;
    assert.equal(clock.count, 2);
    clock.destroy();
  });

  await t.test('the faux generator still ticks without an event target', async () => {
    const clock = create({ trMs: TR, guardMs: GUARD, fauxFives: true, target: null, doc: null });
    clock.start();
    await clock.awaitTriggers(2);
    assert.equal(clock.fauxPulses, 2);
    clock.destroy();
  });
});
