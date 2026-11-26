# scanner-clock

**Advance your fMRI task on the scanner's volume pulses, not on `setTimeout`.**

Dependency-free, ~10 kB, works in any JS task — jsPsych, PsychoJS, or plain JavaScript.

```js
import { create } from 'scanner-clock';

const clock = create({ trMs: 1000, key: '5' });

await clock.awaitRunStart();       // wait for the scan to start
await clock.hold(5000);            // burn-in: 5 volumes
for (const trial of trials) {
  showImage(trial);
  await clock.hold(1000);          // 1 volume
  showBlank();
  await clock.hold(trial.jitterMs); // 2 / 4 / 6 volumes
}
```

## The problem

The scanner sends a keypress at the start of every volume (commonly `5`, TR = 1 s).
A task that advances on `setTimeout` alone accumulates browser drift over a long
session — a few milliseconds per screen, hundreds of screens, and your design
matrix no longer describes what the participant saw.

`scanner-clock` advances the task on those pulses instead. Timing is re-anchored
to the scanner on **every screen**, so error cannot accumulate.

## Just want the 5s?

`simulate()` is the whole scanner in one line. Give it the TR in seconds and it
presses `5` at exactly that rate, for as long as you leave it running:

```js
import { simulate } from 'scanner-clock';

const scanner = simulate(2);     // a "5" keydown every 2s
const fast    = simulate(0.8);   // or 0.8s, or any tenth of a second
scanner.stop();
```

It dispatches real `KeyboardEvent`s at the window, so it drives **any** task
that listens for the trigger — including tasks that have never heard of this
module. Put it in the console of a task you are piloting and watch it advance.

### How exactly is "exactly"?

`scanner.maxAbsDriftMs` is the number behind the claim: the worst gap between a
pulse and where the schedule said it should be. Don't take it on trust — read it
off a run.

Two things get it there. Each pulse is timed against the run's **start**, not
against the previous pulse, so error cannot accumulate the way `setInterval`'s
does. And the last 2 ms of each TR are spent in a busy loop rather than handed
back to a timer that would return them late, because `setTimeout` fires at its
delay *or later*. Measured at a 100 ms TR:

| | pulses in 3 s | mean drift | worst |
| --- | --- | --- | --- |
| `setInterval` | 29 | — | — |
| absolute schedule, `spinMs: 0` | 29 | 0.632 ms | 1.152 ms |
| **default (`spinMs: 2`)** | **30** | **0.001 ms** | **0.002 ms** |

In Chrome the same test reports `0.000 ms` with the spin on. That is not
literally zero — it means the error is below what `performance.now()` will
resolve there, which browsers deliberately coarsen to 100 µs. Measured at a
0.4 s TR in Chrome: 7 pulses, 7 keydowns actually delivered, drift below the
clock's own resolution; with `spinMs: 0`, 0.74 ms mean and 1.2 ms worst.

Pass `spinMs: 0` to skip the busy-wait if you would rather not spend the CPU.
`create()`'s own faux generator does *not* spin by default: it runs inside a
task that is trying to render, and there the pulse **count** is the authority
anyway, so a more precise faux train buys nothing.

## The TR goes to a tenth of a second

The TR is the one number that makes every other number in the task wrong if it
is entered wrong, so it is checked rather than taken on faith:

```js
create({ trSec: 2 });      // fine
create({ trSec: 2.4 });    // fine — multiband TRs work
create({ trSec: 0.8 });    // fine
create({ trMs: 2500 });    // fine — same thing in ms
create({ trSec: 2.45 });   // throws: not a multiple of 0.1s.
                           //         Nearest allowed: 2.4s or 2.5s
create({ trMs: 2 });       // throws: trMs is in MILLISECONDS.
                           //         Did you mean trSec: 2?
create({ trSec: 2000 });   // throws: trSec is in SECONDS.
                           //         Did you mean trMs: 2000?
```

Each unit is guarded against the other's magnitude, because a TR entered in the
wrong unit still produces a perfectly functional clock running at a wildly wrong
rate. For anything finer than a tenth, set the granularity yourself:

```js
create({ trSec: 2.45, trStepMs: 10 });   // or trStepMs: 0 for anything
```

## Not a 1 s TR?

`trMs` is the only place the TR lives, and everything else is derived from it or
configurable alongside it:

```js
create({
  trSec: 2.5,             // whatever your sequence runs at
  pulsesPerVolume: 1,     // raise it if the scanner pulses per slice, not per volume
  dummyVolumes: 4,        // steady-state volumes to wait out before the run
  key: ['5', 't'],        // some consoles send something other than "5"
  strictDurations: true,  // refuse durations that aren't whole volumes
});
```

- **`guardMs` scales with the TR** unless you set it (`min(500, trMs / 2)`). A
  fixed 500 ms default would make the constructor throw for any TR at or below
  500 ms — a short-TR multiband sequence could not even be configured.
- **`hold(ms)` converts through one rounding policy**, and tells you when the
  conversion wasn't exact. At TR = 1 s, `hold(1500)` logs a `duration_rounded`
  event saying it ran 2 volumes, 500 ms longer than you asked. With
  `strictDurations: true` it throws instead. Use **`holdVolumes(n)`** when your
  design is written in volumes and you want no rounding at all.
- **Unknown options are rejected.** `create({ trMS: 2400 })` throws
  `unknown option "trMS" (did you mean "trMs"?)` rather than silently leaving
  the task at the 1000 ms default while the scanner runs at 2.4 s. Same
  reasoning as the `fauxFives` default below: the loud failure is the safe one.

New to it, or pointing a labmate at it? **[HOWTOUSE.md](HOWTOUSE.md)** covers
getting it into a task from another project, with no copying and no relative
paths.

## Install

```bash
npm install scanner-clock
```

Or drop it in a page with no build step at all:

```html
<script src="https://cdn.jsdelivr.net/npm/scanner-clock/dist/scanner-clock.umd.js"></script>
<script>
  const clock = ScannerClock.create({ trMs: 1000 });
</script>
```

ESM, CommonJS and UMD builds are all included and all come from the same source file.

## The core pattern — `hold()`

To hold a screen for N ms and end it on a pulse, `hold()` sleeps to `N - guardMs`
and then waits for the volume count to reach its target.

**The sleep is only an optimisation; the pulse count is the authority.** Starting
from a pulse — which every screen does, because the previous one ended on one —
it lands exactly on N. And if the sleep overshoots, it resolves immediately
instead of costing an extra volume.

That second case is the one that matters. A hidden tab clamps `setTimeout` to
~1 s, so a 500 ms lead fires at 1000 ms, just past the pulse. Naively taking
"the next pulse" would add a **whole TR to every screen**. Anchoring to an
absolute volume target removes that penalty: throttling can still stretch a
screen, but it can no longer compound.

## Faux fives

`fauxFives: true` runs a local generator that dispatches a real `KeyboardEvent`
on the same interval, for behavioural piloting. It deliberately does **not** call
the handler directly, so faux and real pulses drive the *identical* code path —
a behavioural pilot therefore tests the timing logic the scanner will run.

`fauxFives: false` (the default) runs the clock off real presses only: the
scanner's pulses, or a human pressing `5` to step through by hand.

**The default is false on purpose.** The two ways to get this wrong are not
symmetric:

| Mistake | What happens |
| --- | --- |
| Forgot to turn faux **off** in the scanner | The generator and the scanner both increment the counter. The task runs at ~2× speed and nothing looks broken. **Silent data loss.** |
| Forgot to turn faux **on** for behavioural testing | The task waits at the first `hold()`. Immediately obvious, nothing corrupted. |

So the safe default is the one that fails loudly. As a backstop, the clock also
watches `event.isTrusted`: if real pulses arrive while `fauxFives` is on, it
logs a `double_clock_warning` and prints a console error once.

## Two caveats worth knowing

1. **Hidden tabs.** Browsers clamp `setTimeout` to ~1 s granularity while a tab
   is hidden. `hold()` absorbs this rather than adding a volume per screen (see
   above), but a hidden tab can still stretch screens, and it fails *silently*.
   Every visibility change is logged and the total is in `snapshot().hiddenMs` —
   check it before trusting a run's timing. Running fullscreen makes it unlikely.

2. **Blocking work.** A long synchronous task (e.g. building a trial plan)
   blocks the thread, and no timer fires while it does. The generator keeps an
   **absolute** schedule and emits every pulse the wall clock says is due once
   the thread frees up — which is what a real scanner does to a busy task: it
   keeps pulsing, and the queued keydowns arrive late and in a burst (logged as
   `faux_catch_up`). So a block stretches a screen in the pilot exactly as it
   would in the scanner, rather than quietly costing a pulse. Still do blocking
   setup before the first run.

## API

### `create(options)`

Anything not listed here is an error, not an ignored key.

**The scanner**

| Option | Default | Meaning |
| --- | --- | --- |
| `trMs` | `1000` | Milliseconds per volume. |
| `trSec` | — | The TR in seconds instead. Give this or `trMs`, not both. |
| `trStepMs` | `100` | TR granularity: tenths of a second. `0` allows any TR. |
| `key` | `'5'` | Key, or array of keys, the scanner sends. |
| `pulsesPerVolume` | `1` | Raise it when the sequence pulses per slice or per echo. |
| `dummyVolumes` | `0` | Steady-state volumes `awaitRunStart()` waits out. |

**Timing policy**

| Option | Default | Meaning |
| --- | --- | --- |
| `guardMs` | `min(500, trMs/2)` | Sleep stops this early, then syncs to the pulse. Must be `< trMs`. |
| `rounding` | `'round'` | How ms convert to whole volumes: `'round'`, `'floor'`, `'ceil'`. |
| `strictDurations` | `false` | Throw instead of rounding a non-multiple of `trMs`. |
| `pulseTimeoutMs` | `0` | Warn when a wait sees no pulse for this long. `0` disables it. |

**Piloting and plumbing**

| Option | Default | Meaning |
| --- | --- | --- |
| `fauxFives` | `false` | Generate pulses locally. See above. |
| `autoStart` | `false` | Call `start()` during `create()`. |
| `spinMs` | `0` | Busy-wait the last N ms of each TR for a sub-ms landing. `simulate()` defaults this to `2`. |
| `onLog` | `null` | `(event, data) => void` sink for every clock event. |
| `onWarn` | `console.error` | `(message, event, data) => void` for operator-facing warnings. |
| `ignoreTextEntry` | `true` | A `5` typed into an input/textarea is an answer, not a volume. |
| `logPulses` | `false` | Also emit a `pulse` event per pulse (verbose). |
| `target` | `window` | `EventTarget` to listen on. Pass an iframe's window, or `null` for headless. |
| `doc` | `document` | Document used for visibility logging. |

### Waiting

| Method | Returns |
| --- | --- |
| `hold(ms, opts?)` | Hold for `ms`, rounded to whole volumes, ending on a pulse. Resolves with the volume. |
| `holdVolumes(n, opts?)` | Hold for exactly `n` volumes — never rounded, and the natural call when your design is written in volumes. |
| `holdUntil(deadlineMs, opts?)` | Same, against an absolute wall-clock deadline — for windows whose start is fixed while their contents are self-paced. |
| `awaitTriggers(n, signal?)` | Resolve after `n` further pulses. **Pure counting** — immune to timer throttling, unlike `hold()`. |
| `awaitCount(target, signal?)` | Resolve once the running count reaches an absolute target. |
| `awaitRunStart(meta?)` | Wait out one pulse plus `dummyVolumes`, then log `run_start`, so a run begins on a known volume. In the scanner this also means the task simply waits if the scan has not begun. Pass `{ dummyVolumes: n }` to override per run. |

`opts` is `{ onWaitStart, signal, label }` (a bare function is still accepted as
`onWaitStart`). `onWaitStart` fires just before the trailing pulse-wait — use it
to log the wait as its own row, whose duration reads out the phase offset
between your schedule and the scanner (expect ~`guardMs`).

`signal` takes an `AbortSignal`; the promise then rejects with an `AbortError`
instead of hanging, which is what you want on an escape-key abort.

### Control and inspection

| Member | Meaning |
| --- | --- |
| `count` / `volume` | Volumes counted so far. **Log this at every screen onset.** |
| `realPulses` / `fauxPulses` / `manualPulses` | Pulse provenance. In the scanner, `realPulses` should equal `rawPulses` and `fauxPulses` should be `0`. |
| `rawPulses` | Pulses before the `pulsesPerVolume` divisor. Equals `count` when it is `1`. |
| `hiddenMs` | Total time the document has spent hidden. Nonzero means suspect timing. |
| `msToVolumes(ms)` / `volumesToMs(n)` | Rounding helpers. |
| `start()` / `stop()` | Start/stop the faux generator. No-op unless `fauxFives`. |
| `pulse()` | Inject a pulse by hand — tests, log replay, or a non-keyboard trigger source (serial port, TTL box, websocket). |
| `on(event, fn)` | Subscribe to one event, or `'*'` for all. Returns an unsubscribe function. |
| `snapshot()` | One object with everything QC needs. |
| `destroy(opts?)` | Remove listeners and settle pending waits. **They reject by default** — silently resolving would advance the task past a screen that never ended. Pass `{ settle: 'resolve' }` to opt out. |

### Events

`pulse`, `run_start`, `hold_end`, `duration_rounded`, `pulse_timeout`,
`visibility_change`, `double_clock_warning`, `faux_catch_up`,
`faux_scanner_started`, `faux_scanner_stopped`, `faux_disabled`, `destroyed`.

Two of them are warnings you want to see in the scanner room rather than in a
log file afterwards, so they also go to `onWarn` (`console.error` by default):
`double_clock_warning` and `pulse_timeout`. The latter is the only way to tell a
run that is correctly waiting for the scanner from one that is stalled because
no trigger is arriving:

```js
create({ trMs: 2400, pulseTimeoutMs: 10000 });
// -> 'no "5" pulse for 10000ms while the task is waiting at volume 0.
//     Is the trigger connected, and has the scan started?'
```

## Logging for QC

Record `clock.count` at each screen onset, and let `hold_end` record how many
volumes each screen actually lasted:

```js
const clock = create({
  trMs: 1000,
  onLog: (event, data) => jsPsych.data.write({ clock_event: event, ...data }),
});
```

Images should read `1`, a 2 s jitter should read `2`, and anything else in a
locked phase is a timing problem you can spot without any extra tooling. At the
end of a run, write `clock.snapshot()` into the data file:

```js
jsPsych.data.addProperties({ scanner_clock: clock.snapshot() });
```

Four fields are worth checking on every dataset:

- `fauxPulses` — must be `0` for scanner runs.
- `doubleClockDetected` — must be `false`.
- `hiddenMs` — must be `0`, or the run left the foreground.
- `trMs` / `pulsesPerVolume` — must match the sequence that was actually run.

## jsPsych

```js
import { create } from 'scanner-clock';

const clock = create({ trMs: 1000, fauxFives: false });

const stimulus = {
  type: jsPsychHtmlKeyboardResponse,
  stimulus: () => `<img src="${jsPsych.timelineVariable('src')}">`,
  choices: ['1', '2'],
  trial_duration: null,               // the clock ends the trial, not jsPsych
  on_load: function () {
    clock.hold(1000, { label: 'stimulus' })
      .then(() => jsPsych.finishTrial());
  },
  on_start: () => ({ onset_volume: clock.count }),
};
```

The same pattern works in PsychoJS: keep your builder-generated components, and
replace the frame-count end condition with an `await clock.hold(...)`.

## Development

```bash
npm test          # 101 tests, no dependencies, ~6 s
npm run build     # regenerate dist/ from src/scanner-clock.js
npm run check     # build + test, as CI runs it
```

There is one source file, `src/scanner-clock.js`. `scripts/build.mjs` generates
the CJS and UMD builds from it with no bundler, and refuses to run if the source
grows a module statement outside the trailing export block. `dist/` is committed
so the CDN URL works, and a test fails if it is stale.

The test suite ships its own ~60-line DOM stand-in (`test/helpers/dom.js`)
rather than pulling in jsdom, modelling the three things that matter:
capture-phase listeners, `event.target`, and `isTrusted`.

## License

MIT
