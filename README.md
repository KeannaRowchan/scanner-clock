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
   blocks the thread. Missed `setInterval` callbacks are **coalesced**, so the
   faux generator loses pulses across a block; a real scanner's keydown events
   are **queued** and delivered afterwards, so it does not. Do blocking setup
   before the first run, and measure drift *within* runs, not across the session.

## API

### `create(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `trMs` | `1000` | Scanner TR in ms. |
| `key` | `'5'` | Key, or array of keys, the scanner sends. |
| `guardMs` | `500` | Sleep stops this early, then syncs to the pulse. Must be `< trMs`. |
| `fauxFives` | `false` | Generate pulses locally. See above. |
| `onLog` | `null` | `(event, data) => void` sink for every clock event. |
| `ignoreTextEntry` | `true` | A `5` typed into an input/textarea is an answer, not a volume. |
| `logPulses` | `false` | Also emit a `pulse` event per volume (verbose). |
| `autoStart` | `false` | Call `start()` during `create()`. |
| `target` | `window` | `EventTarget` to listen on. Pass an iframe's window, or `null` for headless. |
| `doc` | `document` | Document used for visibility logging. |

### Waiting

| Method | Returns |
| --- | --- |
| `hold(ms, opts?)` | Hold for `ms`, ending on a pulse. Resolves with the volume. |
| `holdUntil(deadlineMs, opts?)` | Same, against an absolute wall-clock deadline — for windows whose start is fixed while their contents are self-paced. |
| `awaitTriggers(n, signal?)` | Resolve after `n` further pulses. **Pure counting** — immune to timer throttling, unlike `hold()`. |
| `awaitCount(target, signal?)` | Resolve once the running count reaches an absolute target. |
| `awaitRunStart(meta?)` | Wait for the next pulse and log `run_start`, so a run begins on a known volume. In the scanner this also means the task simply waits if the scan has not begun. |

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
| `realPulses` / `fauxPulses` / `manualPulses` | Pulse provenance. In the scanner, `realPulses` should equal `count` and `fauxPulses` should be `0`. |
| `hiddenMs` | Total time the document has spent hidden. Nonzero means suspect timing. |
| `msToVolumes(ms)` / `volumesToMs(n)` | Rounding helpers. |
| `start()` / `stop()` | Start/stop the faux generator. No-op unless `fauxFives`. |
| `pulse()` | Inject a pulse by hand — tests, log replay, or a non-keyboard trigger source (serial port, TTL box, websocket). |
| `on(event, fn)` | Subscribe to one event, or `'*'` for all. Returns an unsubscribe function. |
| `snapshot()` | One object with everything QC needs. |
| `destroy(opts?)` | Remove listeners and settle pending waits. **They reject by default** — silently resolving would advance the task past a screen that never ended. Pass `{ settle: 'resolve' }` to opt out. |

### Events

`pulse`, `run_start`, `hold_end`, `visibility_change`, `double_clock_warning`,
`faux_scanner_started`, `faux_scanner_stopped`, `faux_disabled`, `destroyed`.

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

Three fields are worth checking on every dataset:

- `fauxPulses` — must be `0` for scanner runs.
- `doubleClockDetected` — must be `false`.
- `hiddenMs` — must be `0`, or the run left the foreground.

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
npm test          # 57 tests, no dependencies, ~1 s
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
