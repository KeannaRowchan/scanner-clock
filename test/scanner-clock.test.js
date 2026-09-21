import test from 'node:test';
import assert from 'node:assert/strict';
import { create, simulate, VERSION } from '../src/scanner-clock.js';
import { makeEnv, realKey, fauxKey, textField, tick } from './helpers/dom.js';

// Tests use a short TR so the suite runs in well under a second. The logic
// under test is scale-free: nothing in the module depends on TR being 1s.
const TR = 20;
const GUARD = 8;

// trStepMs: 1 relaxes the whole/half-second TR rule so the suite can use a
// 20ms TR and stay fast. The rule itself is tested in 'TR granularity'.
const mk = (opts = {}) => {
  const env = makeEnv();
  const clock = create({
    trMs: TR, guardMs: GUARD, trStepMs: 1, target: env.win, doc: env.doc, ...opts,
  });
  return { ...env, clock };
};

test('config validation', async t => {
  await t.test('an explicit guardMs must be smaller than trMs', () => {
    assert.throws(() => create({ trMs: 1000, guardMs: 1000, target: null, doc: null }),
      /guardMs \(1000\) must be smaller than trMs \(1000\)/);
  });

  await t.test('the default guardMs scales with the TR', () => {
    // A fixed 500ms default would make every TR at or below 500ms unusable.
    const cases = [[3000, 500], [1000, 500], [800, 400], [400, 200], [100, 50]];
    for (const [trMs, expected] of cases) {
      const c = create({ trMs, trStepMs: 1, target: null, doc: null });
      assert.equal(c.guardMs, expected, `TR ${trMs}`);
      assert.ok(c.guardMs < c.trMs);
      c.destroy();
    }
  });

  await t.test('an explicit guardMs still wins', () => {
    const c = create({ trMs: 2000, guardMs: 100, target: null, doc: null });
    assert.equal(c.guardMs, 100);
    c.destroy();
  });

  await t.test('unknown options are rejected, not ignored', () => {
    // A typo here would otherwise leave the task on the 1000ms default while
    // the scanner ran at a different TR, with nothing looking wrong.
    assert.throws(() => create({ trMS: 2000, target: null, doc: null }),
      /unknown option "trMS" \(did you mean "trMs"\?\)/);
    assert.throws(() => create({ tr: 2, target: null, doc: null }),
      /did you mean "trSec"/);
    assert.throws(() => create({ triggerKey: '5', target: null, doc: null }),
      /did you mean "key"/);
    assert.throws(() => create({ nonsense: 1, target: null, doc: null }),
      /unknown option "nonsense"\. Known options:/);
  });

  await t.test('pulsesPerVolume and dummyVolumes must be sane integers', () => {
    assert.throws(() => create({ pulsesPerVolume: 0, target: null, doc: null }),
      /pulsesPerVolume must be an integer >= 1/);
    assert.throws(() => create({ pulsesPerVolume: 1.5, target: null, doc: null }),
      /pulsesPerVolume must be an integer >= 1/);
    assert.throws(() => create({ dummyVolumes: -1, target: null, doc: null }),
      /dummyVolumes must be an integer >= 0/);
    assert.throws(() => create({ rounding: 'nearest', target: null, doc: null }),
      /rounding must be/);
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
    const a = create({ trMs: TR, guardMs: GUARD, trStepMs: 1, faux_fives: true, target: null, doc: null });
    const b = create({ trMs: TR, guardMs: GUARD, trStepMs: 1, mode: 'faux', target: null, doc: null });
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
      trMs: TR, guardMs: GUARD, trStepMs: 1, fauxFives: true, autoStart: true,
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

test('non-1s TRs', async t => {
  // These use short, deliberately un-round TRs: the point is that no code path
  // is special-cased to 1000ms, and a short TR keeps the suite fast.
  await t.test('holds scale with whatever TR was given', async () => {
    for (const trMs of [17, 43, 130]) {
      const env = makeEnv();
      const clock = create({ trMs, trStepMs: 1, target: env.win, doc: env.doc });
      const p = clock.hold(trMs * 3);
      env.pulses(3);
      await p;
      assert.equal(clock.count, 3, `TR ${trMs}`);
      clock.destroy();
    }
  });

  await t.test('holdVolumes says it in volumes and cannot be rounded', async () => {
    const { pulses, clock } = mk({ trMs: 43, guardMs: 10 });
    const p = clock.holdVolumes(2);
    pulses(2);
    await p;
    assert.equal(clock.count, 2);
    clock.destroy();
  });

  await t.test('msToVolumes follows the TR and the rounding policy', () => {
    const round = create({ trMs: 1300, trStepMs: 1, target: null, doc: null });
    const floor = create({ trMs: 1300, trStepMs: 1, rounding: 'floor', target: null, doc: null });
    const ceil = create({ trMs: 1300, trStepMs: 1, rounding: 'ceil', target: null, doc: null });
    assert.equal(round.msToVolumes(2000), 2);   // 1.54 -> 2
    assert.equal(floor.msToVolumes(2000), 1);
    assert.equal(ceil.msToVolumes(2000), 2);
    assert.equal(round.volumesToMs(3), 3900);
    for (const c of [round, floor, ceil]) c.destroy();
  });
});

test('duration rounding', async t => {
  await t.test('a non-multiple duration is reported, not silently rounded', async () => {
    const events = [];
    const { pulses, clock } = mk({ trMs: 100, guardMs: 10, onLog: (e, d) => events.push([e, d]) });
    const p = clock.hold(150, { label: 'iti' });
    pulses(2);
    await p;
    const hit = events.find(([e]) => e === 'duration_rounded');
    assert.ok(hit, 'emitted duration_rounded');
    assert.equal(hit[1].volumes, 2);
    assert.equal(hit[1].deltaMs, 50, 'actual is 50ms longer than requested');
    assert.equal(hit[1].label, 'iti');
    clock.destroy();
  });

  await t.test('an exact multiple says nothing', async () => {
    const events = [];
    const { pulses, clock } = mk({ trMs: 100, guardMs: 10, onLog: (e, d) => events.push([e, d]) });
    const p = clock.hold(200);
    pulses(2);
    await p;
    assert.equal(events.filter(([e]) => e === 'duration_rounded').length, 0);
    clock.destroy();
  });

  await t.test('strictDurations turns it into a rejection', async () => {
    const { clock } = mk({ trMs: 100, guardMs: 10, strictDurations: true });
    await assert.rejects(clock.hold(150), /not a whole number of 100ms volumes/);
    clock.destroy();
  });

  await t.test('holdVolumes is exempt — it is already in volumes', async () => {
    const events = [];
    const { pulses, clock } = mk({ trMs: 43, guardMs: 10, strictDurations: true, onLog: (e, d) => events.push([e, d]) });
    const p = clock.holdVolumes(1);
    pulses(1);
    await p;
    assert.equal(events.filter(([e]) => e === 'duration_rounded').length, 0);
    clock.destroy();
  });
});

test('pulsesPerVolume (slice or echo triggers)', async t => {
  await t.test('only every Nth pulse closes a volume', () => {
    const { pulses, clock } = mk({ pulsesPerVolume: 4 });
    pulses(3);
    assert.equal(clock.count, 0, 'mid-volume');
    assert.equal(clock.rawPulses, 3);
    pulses(1);
    assert.equal(clock.count, 1);
    pulses(8);
    assert.equal(clock.count, 3);
    assert.equal(clock.rawPulses, 12);
    clock.destroy();
  });

  await t.test('holds still count volumes, not pulses', async () => {
    const { pulses, clock } = mk({ pulsesPerVolume: 3 });
    const p = clock.hold(TR * 2);
    pulses(5);
    await tick(TR);
    assert.equal(clock.count, 1, 'not there yet');
    pulses(1);
    await p;
    assert.equal(clock.count, 2);
    assert.equal(clock.rawPulses, 6);
    clock.destroy();
  });

  await t.test('snapshot reports both', () => {
    const { pulses, clock } = mk({ pulsesPerVolume: 2 });
    pulses(5);
    const s = clock.snapshot();
    assert.equal(s.volume, 2);
    assert.equal(s.pulses, 5);
    assert.equal(s.pulsesPerVolume, 2);
    clock.destroy();
  });
});

test('dummy volumes', async t => {
  await t.test('awaitRunStart waits them out', async () => {
    const events = [];
    const { pulses, clock } = mk({ dummyVolumes: 4, onLog: (e, d) => events.push([e, d]) });
    let started = false;
    const p = clock.awaitRunStart({ run: 'main' }).then(() => { started = true; });
    pulses(4);
    await tick(0);
    assert.equal(started, false, 'still discarding dummies');
    pulses(1);
    await p;
    assert.equal(clock.count, 5, '1 + 4 dummies');
    const [, data] = events.find(([e]) => e === 'run_start');
    assert.equal(data.dummyVolumes, 4);
    assert.equal(data.volume, 5);
    clock.destroy();
  });

  await t.test('a per-call override beats the default', async () => {
    const { pulses, clock } = mk({ dummyVolumes: 4 });
    const p = clock.awaitRunStart({ dummyVolumes: 0 });
    pulses(1);
    await p;
    assert.equal(clock.count, 1);
    clock.destroy();
  });

  await t.test('zero dummies is the default and costs one pulse', async () => {
    const { pulses, clock } = mk();
    const p = clock.awaitRunStart();
    pulses(1);
    await p;
    assert.equal(clock.count, 1);
    clock.destroy();
  });
});

test('pulse timeout watchdog', async t => {
  await t.test('warns while a wait sees no pulses', async () => {
    const warnings = [];
    const { pulses, clock } = mk({ pulseTimeoutMs: 30, onWarn: (m, e, d) => warnings.push([m, e, d]) });
    const p = clock.awaitTriggers(1);
    await tick(80);
    assert.ok(warnings.length >= 2, `re-warns until a pulse arrives (${warnings.length})`);
    assert.match(warnings[0][0], /no "5" pulse for 30ms/);
    assert.equal(warnings[0][1], 'pulse_timeout');
    pulses(1);
    await p;
    const after = warnings.length;
    await tick(80);
    assert.equal(warnings.length, after, 'silent once nothing is waiting');
    clock.destroy();
  });

  await t.test('stays silent when pulses keep arriving', async () => {
    const warnings = [];
    const { win, clock } = mk({ pulseTimeoutMs: 60, onWarn: (m) => warnings.push(m) });
    const iv = setInterval(() => win.dispatchEvent(realKey('5')), TR);
    try {
      await clock.awaitTriggers(5);
      assert.equal(warnings.length, 0);
    } finally {
      clearInterval(iv);
      clock.destroy();
    }
  });

  await t.test('is off by default', async () => {
    const warnings = [];
    const { clock } = mk({ onWarn: (m) => warnings.push(m) });
    clock.awaitTriggers(1).catch(() => {});
    await tick(60);
    assert.equal(warnings.length, 0);
    clock.destroy();
  });
});

test('onWarn sink', async t => {
  await t.test('redirects the double-clock warning away from console', () => {
    const warnings = [];
    const { win, clock } = mk({ fauxFives: true, onWarn: (m, e, d) => warnings.push([m, e, d]) });
    const errors = [];
    const realError = console.error;
    console.error = m => errors.push(m);
    try {
      win.dispatchEvent(realKey('5'));
    } finally {
      console.error = realError;
    }
    assert.equal(errors.length, 0, 'console left alone when onWarn is given');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], 'double_clock_warning');
    clock.destroy();
  });
});

test('TR granularity', async t => {
  await t.test('whole and half seconds are accepted', () => {
    for (const trSec of [0.5, 1, 1.5, 2, 2.5, 3]) {
      const c = create({ trSec, target: null, doc: null });
      assert.equal(c.trMs, trSec * 1000);
      c.destroy();
    }
  });

  await t.test('anything between them is rejected, with the nearest alternatives', () => {
    assert.throws(() => create({ trSec: 2.4, target: null, doc: null }),
      /a TR of 2\.4s is not a multiple of 0\.5s\. Nearest allowed: 2s or 2\.5s/);
    assert.throws(() => create({ trMs: 1300, target: null, doc: null }),
      /not a multiple of 0\.5s\. Nearest allowed: 1s or 1\.5s/);
    assert.throws(() => create({ trMs: 750, target: null, doc: null }),
      /Nearest allowed: 0\.5s or 1s/);
  });

  await t.test('trStepMs relaxes it for sequences that need it', () => {
    const c = create({ trSec: 2.4, trStepMs: 100, target: null, doc: null });
    assert.equal(c.trMs, 2400);
    c.destroy();
    const any = create({ trMs: 1234, trStepMs: 0, target: null, doc: null });
    assert.equal(any.trMs, 1234);
    any.destroy();
  });

  await t.test('trSec and trMs are interchangeable but not simultaneous', () => {
    const a = create({ trSec: 1.5, target: null, doc: null });
    const b = create({ trMs: 1500, target: null, doc: null });
    assert.equal(a.trMs, b.trMs);
    assert.equal(a.snapshot().trMs, 1500);
    a.destroy(); b.destroy();
    assert.throws(() => create({ trSec: 1.5, trMs: 1500, target: null, doc: null }),
      /give trMs or trSec, not both/);
  });

  await t.test('a TR typed in the wrong unit is caught', () => {
    // Someone thinking in seconds writes trMs: 2. Without this it would be a
    // 2ms clock, which fails in a way that looks like something else entirely.
    assert.throws(() => create({ trMs: 2, target: null, doc: null }),
      /trMs is in MILLISECONDS — 2ms is not a TR\. Did you mean trSec: 2\?/);
    assert.throws(() => create({ trSec: 0, target: null, doc: null }),
      /trSec must be a positive number/);
    // ...and the same mistake in the other direction.
    assert.throws(() => create({ trSec: 2000, target: null, doc: null }),
      /trSec is in SECONDS — 2000s is not a TR\. Did you mean trMs: 2000\?/);
  });
});

test('simulate(trSec)', async t => {
  await t.test('presses the key at the TR', async () => {
    const env = makeEnv();
    const seen = [];
    const clock = create({ trSec: 1, trStepMs: 1, target: env.win, doc: env.doc });
    const sim = simulate(0.02, { trStepMs: 1, target: env.win, onPulse: p => seen.push(p) });
    try {
      await clock.awaitTriggers(4);
      assert.ok(seen.length >= 4);
      assert.equal(clock.fauxPulses, clock.count, 'the clock saw them as synthetic');
      assert.equal(sim.trMs, 20);
      assert.equal(sim.trSec, 0.02);
    } finally {
      sim.stop();
      clock.destroy();
    }
  });

  await t.test('starts on its own and stops when told', async () => {
    const env = makeEnv();
    let n = 0;
    const sim = simulate({ trMs: 20, trStepMs: 1, target: env.win, onPulse: () => n++ });
    assert.equal(sim.running, true, 'running without an explicit start()');
    await tick(70);
    sim.stop();
    assert.equal(sim.running, false);
    const atStop = n;
    await tick(70);
    assert.equal(n, atStop, 'no pulses after stop');
  });

  await t.test('holds an absolute schedule rather than drifting', async () => {
    // setInterval measures each gap from the previous callback, so its error
    // accumulates. This measures every pulse against t0.
    const sim = simulate(0.02, { trStepMs: 1, target: null });
    await tick(600);
    sim.stop();
    assert.ok(sim.count >= 25, `roughly 30 pulses in 600ms (got ${sim.count})`);
    assert.ok(sim.maxAbsDriftMs < 25, `max drift ${sim.maxAbsDriftMs.toFixed(1)}ms`);
  });

  await t.test('emits the pulses a block made late, rather than losing them', async () => {
    // A real scanner keeps pulsing through a busy task and the keydowns arrive
    // late; a generator that skipped them would flatter a pilot run.
    const sim = simulate(0.01, { trStepMs: 1, target: null });
    const until = Date.now() + 120;
    while (Date.now() < until) { /* block the thread */ }
    await tick(40);
    sim.stop();
    assert.ok(sim.count >= 10, `caught up after the block (got ${sim.count})`);
  });

  await t.test('enforces the same TR granularity', () => {
    assert.throws(() => simulate(2.4), /not a multiple of 0\.5s/);
    assert.throws(() => simulate(2000), /trSec is in SECONDS — 2000s is not a TR\. Did you mean trMs: 2000\?/);
    const sim = simulate(0.5, { target: null });
    assert.equal(sim.trMs, 500);
    sim.stop();
  });

  await t.test('says what it needs when called wrong', () => {
    assert.throws(() => simulate(), /simulate\(trSec\) needs the TR, in seconds/);
    assert.throws(() => simulate(1, { fauxFives: true }), /simulate\(\) does not take "fauxFives"/);
  });
});

test('headless use (no DOM at all)', async t => {
  await t.test('creates and runs off manual pulses', async () => {
    const clock = create({ trMs: TR, guardMs: GUARD, trStepMs: 1, target: null, doc: null });
    const p = clock.awaitTriggers(2);
    clock.pulse();
    clock.pulse();
    await p;
    assert.equal(clock.count, 2);
    clock.destroy();
  });

  await t.test('the faux generator still ticks without an event target', async () => {
    const clock = create({ trMs: TR, guardMs: GUARD, trStepMs: 1, fauxFives: true, target: null, doc: null });
    clock.start();
    await clock.awaitTriggers(2);
    assert.equal(clock.fauxPulses, 2);
    clock.destroy();
  });
});
