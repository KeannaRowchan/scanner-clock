/* ============================================================================
 * scanner-clock — fMRI trigger clock for browser-based tasks
 * ----------------------------------------------------------------------------
 * Dependency-free. Works in any JS task (jsPsych, PsychoJS, plain JS).
 *
 * WHAT IT SOLVES
 *   The scanner sends a keypress at the start of every volume (commonly "5",
 *   TR = 1s). A task that advances on setTimeout alone accumulates browser drift
 *   over a long session. This module advances the task on those pulses instead,
 *   so timing is re-anchored to the scanner on every screen and error cannot
 *   accumulate.
 *
 * THE CORE PATTERN — hold()
 *   To hold a screen for N ms and end it on a pulse, hold() sleeps to
 *   N - guardMs and then waits for the volume count to reach its target. The
 *   sleep is only an optimisation; the pulse count is the authority. Starting
 *   from a pulse (which every screen does, because the previous one ended on
 *   one) it lands exactly on N — and if the sleep overshoots, it resolves
 *   immediately instead of costing an extra volume. See hold()'s own comment.
 *
 * FAUX FIVES
 *   fauxFives:true runs a local generator that dispatches a real KeyboardEvent
 *   on the same interval, for behavioural piloting. It deliberately does NOT
 *   call the handler directly, so faux and real drive the IDENTICAL code path —
 *   a behavioural pilot therefore tests the timing logic the scanner will run.
 *
 *   fauxFives:false (the default) runs the clock off real presses only: the
 *   scanner's pulses, or a human pressing "5" to step through by hand.
 *
 * TWO CAVEATS WORTH KNOWING
 *   1. Hidden tabs. Browsers clamp setTimeout to ~1s granularity while a tab is
 *      hidden, so a sub-second sleep overshoots. hold() is built to absorb this
 *      (see its comment) rather than adding a volume per screen, but a hidden
 *      tab can still stretch screens and it fails SILENTLY. This module logs
 *      every visibility change and totals the hidden time in snapshot(): check
 *      hiddenMs before trusting a run's timing. Fullscreen makes it unlikely.
 *   2. Blocking work. A long synchronous task (e.g. building a trial plan)
 *      blocks the thread. Missed setInterval callbacks are COALESCED, so the
 *      FAUX generator loses pulses across a block; a real scanner's keydown
 *      events are QUEUED and delivered afterwards, so it does not. Do blocking
 *      setup before the first run, and measure drift within runs, not across
 *      the whole session.
 * ========================================================================== */

const VERSION = '0.1.0';

const DEFAULTS = {
  trMs: 1000,           // scanner TR, in ms
  key: '5',             // key (or array of keys) the scanner sends
  guardMs: 500,         // sleep stops this early, then syncs to the pulse
  fauxFives: false,     // true = generate pulses locally; false = real only
  onLog: null,          // (event, data) => void
  ignoreTextEntry: true,// a "5" typed into a field is an answer, not a volume
  logPulses: false,     // emit a 'pulse' event for every volume (verbose)
  autoStart: false,     // call start() during create()
  target: null,         // EventTarget to listen on (default: window)
  doc: null,            // Document for visibility logging (default: document)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function abortError() {
  const err = new Error('scanner-clock: wait aborted');
  err.name = 'AbortError';
  return err;
}

function destroyedError() {
  const err = new Error('scanner-clock: clock destroyed while waiting');
  err.name = 'ScannerClockDestroyedError';
  return err;
}

/**
 * Create a scanner clock. See README for the full option list.
 * @param {object} [opts]
 * @returns {object} clock
 */
function create(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});

  // Accept snake_case and the older mode:'faux'|'real' spelling.
  if (opts && opts.faux_fives !== undefined) cfg.fauxFives = !!opts.faux_fives;
  if (opts && opts.mode !== undefined) cfg.fauxFives = (opts.mode === 'faux');

  if (!(cfg.trMs > 0)) {
    throw new Error('scanner-clock: trMs must be a positive number');
  }
  if (!(cfg.guardMs >= 0)) {
    throw new Error('scanner-clock: guardMs must be zero or positive');
  }
  if (cfg.guardMs >= cfg.trMs) {
    throw new Error('scanner-clock: guardMs must be smaller than trMs');
  }

  // fauxFives defaults to FALSE deliberately. The two ways to get it wrong are
  // not symmetric:
  //   forgot to turn it OFF in the scanner -> the local generator and the real
  //     scanner BOTH increment the counter, the task runs at ~2x speed, and
  //     nothing looks broken. Silent data loss.
  //   forgot to turn it ON for behavioural testing -> the task simply waits at
  //     the first hold. Immediately obvious, nothing corrupted.
  // So the safe default is the one that fails loudly.

  const keys = Array.isArray(cfg.key) ? cfg.key.slice() : [cfg.key];
  const keySet = new Set(keys.map(String));
  const primaryKey = String(keys[0]);

  const target = cfg.target || (typeof globalThis !== 'undefined' ? globalThis.window : null);
  const doc = cfg.doc || (typeof globalThis !== 'undefined' ? globalThis.document : null);

  let count = 0;
  let waiters = [];
  let timer = null;
  let destroyed = false;

  let realPulses = 0;
  let fauxPulses = 0;
  let manualPulses = 0;
  let warnedDoubleClock = false;

  let hiddenMs = 0;
  let hiddenSince = null;
  let visibilityChanges = 0;

  const listeners = new Map();   // event -> Set<fn>

  function emit(event, data) {
    const payload = data || {};
    if (typeof cfg.onLog === 'function') {
      try { cfg.onLog(event, payload); } catch (e) { console.warn(e); }
    }
    const set = listeners.get(event);
    if (set) for (const fn of set) {
      try { fn(payload, event); } catch (e) { console.warn(e); }
    }
    const any = listeners.get('*');
    if (any) for (const fn of any) {
      try { fn(payload, event); } catch (e) { console.warn(e); }
    }
  }

  /** Subscribe to a log event ('*' for all). Returns an unsubscribe function. */
  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('scanner-clock: on(event, fn) needs a function');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => { const s = listeners.get(event); if (s) s.delete(fn); };
  }

  // ---- pulse intake -------------------------------------------------------
  function settle(w) {
    if (w.signal && w.onAbort) {
      try { w.signal.removeEventListener('abort', w.onAbort); } catch (e) { /* shim */ }
    }
  }

  function onPulse(source) {
    count++;
    if (cfg.logPulses) emit('pulse', { volume: count, source: source || 'unknown' });
    if (!waiters.length) return count;
    const due = waiters.filter(w => count >= w.target);
    if (due.length) {
      waiters = waiters.filter(w => count < w.target);
      for (const w of due) { settle(w); w.resolve(count); }
    }
    return count;
  }

  /**
   * Inject a pulse by hand. For tests, for replaying a log, or for driving the
   * clock from a non-keyboard trigger source (serial port, TTL box, websocket).
   */
  function pulse() {
    if (destroyed) return count;
    manualPulses++;
    return onPulse('manual');
  }

  // A "5" typed into a text field is an answer, not a volume.
  function isTextEntry(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function onKeyDown(e) {
    if (!keySet.has(e.key)) return;
    if (cfg.ignoreTextEntry && isTextEntry(e.target)) return;

    // Synthetic events we dispatch have isTrusted === false; anything the
    // hardware (scanner or keyboard) produces has isTrusted === true. That
    // gives us a reliable way to notice the dangerous configuration: the faux
    // generator running WHILE real pulses are also arriving, which would
    // double-count and run the task at ~2x speed with nothing looking wrong.
    const trusted = e.isTrusted === true;
    if (trusted) realPulses++; else fauxPulses++;

    if (cfg.fauxFives && trusted && !warnedDoubleClock) {
      warnedDoubleClock = true;
      const msg = 'scanner-clock: real "' + e.key + '" pulses detected while ' +
                  'fauxFives is ON — the clock is counting both and timing will ' +
                  'be roughly twice as fast. Set fauxFives:false in the scanner.';
      console.error(msg);
      emit('double_clock_warning', { realPulses, fauxPulses, key: e.key });
    }

    onPulse(trusted ? 'real' : 'faux');
  }

  function onVisibilityChange() {
    const state = doc && doc.visibilityState;
    visibilityChanges++;
    if (state === 'hidden') {
      hiddenSince = Date.now();
    } else if (hiddenSince != null) {
      hiddenMs += Date.now() - hiddenSince;
      hiddenSince = null;
    }
    emit('visibility_change', { state, hiddenMs, volume: count });
  }

  // capture:true so the task sees pulses even if something stops propagation
  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('keydown', onKeyDown, { capture: true });
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }

  // ---- waiting ------------------------------------------------------------
  /** Resolve once the running count reaches `target` (already there -> now). */
  function awaitCount(targetCount, signal) {
    if (destroyed) return Promise.reject(destroyedError());
    if (count >= targetCount) return Promise.resolve(count);
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const w = { target: targetCount, resolve, reject, signal: null, onAbort: null };
      if (signal && typeof signal.addEventListener === 'function') {
        w.signal = signal;
        w.onAbort = () => {
          waiters = waiters.filter(x => x !== w);
          settle(w);
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      waiters.push(w);
    });
  }

  /**
   * Resolve after `n` further pulses. Pure counting — immune to setTimeout
   * throttling, unlike hold(). Use it if you expect the tab to be backgrounded.
   */
  function awaitTriggers(n, signal) {
    if (!(n > 0)) return Promise.resolve(count);
    return awaitCount(count + n, signal);
  }

  // Hold for targetMs, ending on a pulse.
  //
  // The sleep is only an OPTIMISATION; the volume count is the authority. We
  // wait until the count reaches (start + targetMs/TR), so:
  //   - if the sleep was accurate, the remaining ~guardMs is spent waiting for
  //     that pulse, and the screen ends exactly on it;
  //   - if the sleep OVERSHOT the pulse, the count target is already met and
  //     this resolves immediately.
  //
  // That second case matters. A hidden tab clamps setTimeout to ~1s, so a
  // 500ms lead fires at 1000ms — just past the pulse. Naively taking "the next
  // pulse" would then add a WHOLE TR to every screen. Anchoring to an absolute
  // volume target removes that penalty: throttling can still stretch a screen,
  // but it can no longer compound into an extra volume per screen.
  //
  // `onWaitStart` (optional) fires just before the trailing wait — use it to
  // log the wait as its own row, whose duration reads out the phase offset
  // between your schedule and the scanner (expect ~guardMs).
  async function hold(targetMs, optsOrFn) {
    const o = typeof optsOrFn === 'function' ? { onWaitStart: optsOrFn } : (optsOrFn || {});
    const t0 = Date.now();
    const startCount = count;
    const ms = targetMs || 0;
    const volumes = Math.round(ms / cfg.trMs);
    const lead = Math.max(0, ms - cfg.guardMs);
    if (lead > 0) await sleep(lead);
    if (typeof o.onWaitStart === 'function') o.onWaitStart(count);
    await awaitCount(startCount + volumes, o.signal);
    emit('hold_end', {
      targetMs: ms,
      volumes,
      startVolume: startCount,
      endVolume: count,
      elapsedMs: Date.now() - t0,
      label: o.label,
    });
    return count;
  }

  /**
   * Same, but against an absolute wall-clock deadline rather than a duration.
   * For windows whose start is fixed while their contents are self-paced.
   */
  async function holdUntil(deadlineMs, optsOrFn) {
    const o = typeof optsOrFn === 'function' ? { onWaitStart: optsOrFn } : (optsOrFn || {});
    const t0 = Date.now();
    const startCount = count;
    const remaining = Math.max(0, deadlineMs - Date.now());
    const volumes = Math.round(remaining / cfg.trMs);
    const lead = Math.max(0, deadlineMs - cfg.guardMs - Date.now());
    if (lead > 0) await sleep(lead);
    if (typeof o.onWaitStart === 'function') o.onWaitStart(count);
    await awaitCount(startCount + volumes, o.signal);
    emit('hold_end', {
      targetMs: remaining,
      volumes,
      startVolume: startCount,
      endVolume: count,
      elapsedMs: Date.now() - t0,
      label: o.label,
    });
    return count;
  }

  /**
   * Hold until the next pulse, so a run begins on a known volume. In the
   * scanner this also means the task simply waits if the scan has not begun.
   */
  async function awaitRunStart(meta) {
    await awaitTriggers(1);
    emit('run_start', Object.assign({ volume: count }, meta || {}));
    return count;
  }

  // ---- faux generator -----------------------------------------------------
  function makeKeyEvent() {
    const init = {
      key: primaryKey,
      code: primaryKey.length === 1 && primaryKey >= '0' && primaryKey <= '9'
        ? 'Digit' + primaryKey
        : 'Key' + primaryKey.toUpperCase(),
      bubbles: true,
    };
    if (typeof globalThis !== 'undefined' && typeof globalThis.KeyboardEvent === 'function') {
      return new globalThis.KeyboardEvent('keydown', init);
    }
    // Non-DOM host (tests, Node): a plain object carries everything we read.
    return Object.assign({ type: 'keydown', isTrusted: false, target: null }, init);
  }

  /** Start the faux generator. No-op unless fauxFives is on. Returns started. */
  function start() {
    if (destroyed) return false;
    if (!cfg.fauxFives) {
      emit('faux_disabled', { reason: 'fauxFives is false; waiting for real pulses' });
      return false;
    }
    if (timer != null) return true;
    timer = setInterval(() => {
      if (target && typeof target.dispatchEvent === 'function') {
        target.dispatchEvent(makeKeyEvent());
      } else {
        // No event target at all: drive the handler's tail directly.
        fauxPulses++;
        onPulse('faux');
      }
    }, cfg.trMs);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    emit('faux_scanner_started', { trMs: cfg.trMs, key: primaryKey });
    return true;
  }

  /** Stop the faux generator. Real pulses are still counted. */
  function stop() {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
      emit('faux_scanner_stopped', { volume: count });
    }
  }

  /**
   * Tear the clock down: stop the generator, remove listeners, and settle any
   * pending waits. Pending waits REJECT by default — silently resolving them
   * would advance the task past a screen that never actually ended.
   */
  function destroy(destroyOpts) {
    if (destroyed) return;
    destroyed = true;
    stop();
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener('keydown', onKeyDown, { capture: true });
    }
    if (doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
    const pending = waiters;
    waiters = [];
    const mode = (destroyOpts && destroyOpts.settle) || 'reject';
    for (const w of pending) {
      settle(w);
      if (mode === 'resolve') w.resolve(count); else w.reject(destroyedError());
    }
    emit('destroyed', { volume: count, pendingWaits: pending.length });
    listeners.clear();
  }

  /** One object with everything QC needs. Log it at the end of every run. */
  function snapshot() {
    return {
      version: VERSION,
      volume: count,
      trMs: cfg.trMs,
      guardMs: cfg.guardMs,
      key: keys.slice(),
      fauxFives: cfg.fauxFives,
      realPulses,
      fauxPulses,
      manualPulses,
      doubleClockDetected: warnedDoubleClock,
      visibilityChanges,
      hiddenMs: hiddenMs + (hiddenSince != null ? Date.now() - hiddenSince : 0),
      pendingWaits: waiters.length,
      running: timer != null,
      destroyed,
    };
  }

  const clock = {
    get count() { return count; },
    get volume() { return count; },
    get fauxFives() { return cfg.fauxFives; },
    // Pulse provenance, for QC: in the scanner realPulses should equal count
    // and fauxPulses should be 0.
    get realPulses() { return realPulses; },
    get fauxPulses() { return fauxPulses; },
    get manualPulses() { return manualPulses; },
    get hiddenMs() { return hiddenMs + (hiddenSince != null ? Date.now() - hiddenSince : 0); },
    get trMs() { return cfg.trMs; },
    get guardMs() { return cfg.guardMs; },
    get key() { return keys.slice(); },
    get running() { return timer != null; },
    get destroyed() { return destroyed; },
    msToVolumes: ms => Math.round((ms || 0) / cfg.trMs),
    volumesToMs: n => (n || 0) * cfg.trMs,
    start, stop, destroy, pulse, on, snapshot,
    hold, holdUntil,
    awaitTriggers, awaitCount, awaitRunStart,
  };

  if (cfg.autoStart) start();
  return clock;
}

export { create, create as createScannerClock, VERSION, DEFAULTS };
export default { create, createScannerClock: create, VERSION, DEFAULTS };
