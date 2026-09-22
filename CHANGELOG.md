# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

First packaged release, extracted from a single-file `scanner-clock.js`.

### Added
- ESM, CommonJS and UMD builds generated from one source file; TypeScript declarations.
- `simulate(trSec)` — a one-line stand-in for the scanner that presses the
  trigger key at exactly the TR, usable in front of any task, including tasks
  that do not use this module.
- `trSec` as an alternative to `trMs`, and `trStepMs` (default 100) constraining
  the TR to tenths of a second — fine enough for multiband TRs like 2.4s or
  0.8s, coarse enough to catch a fat-fingered 2.45. Each unit is guarded against
  the other's magnitude: `trMs: 2` and `trSec: 2000` are both rejected with the
  fix named. The stored TR is snapped to the granularity, so float error in
  `trSec * 1000` never reaches the scheduler or the log.
- `spinMs`, which busy-waits the last few ms of each TR instead of handing them
  to a timer that returns them late. `simulate()` defaults it to 2ms, taking its
  worst-case landing error from ~1.15ms to ~0.002ms; `create()`'s faux generator
  leaves it off, since there the pulse count is the authority.
- `pulsesPerVolume` for sequences that trigger per slice or per echo, with
  `rawPulses` alongside the volume count.
- `dummyVolumes`, waited out by `awaitRunStart()` (overridable per run).
- `rounding` (`round`/`floor`/`ceil`) and `strictDurations`; a `duration_rounded`
  event whenever a requested duration was not a whole number of volumes.
- `holdVolumes(n)` for designs written in volumes rather than seconds.
- `pulseTimeoutMs` watchdog and `pulse_timeout` event — the only way to tell a
  run correctly waiting for the scanner from one stalled with no trigger.
- `onWarn` sink for operator-facing warnings (default `console.error`).
- `pulse()` for driving the clock from a non-keyboard trigger source, log replay, or tests.
- `on(event, fn)` listener API alongside `onLog`.
- `snapshot()` — one object with everything QC needs, including `hiddenMs` and `doubleClockDetected`.
- `hold()` / `holdUntil()` accept `{ onWaitStart, signal, label }`; `AbortSignal` support on all waits.
- `key` accepts an array, for scanners that send more than one character.
- `target` / `doc` options, so the clock can run against an iframe window or headless.
- `hold_end` event reporting how many volumes each screen actually cost.
- 57-test suite with a dependency-free DOM stand-in.

### Changed
- The faux generator keeps an **absolute** schedule instead of `setInterval`, so
  its error cannot accumulate, and it emits pulses a blocked thread made late
  rather than dropping them — matching what a real scanner does to a busy task.
  Measured over 4s at a 100ms interval with a 30ms render per pulse:
  `setInterval` delivered 39 of 40 pulses and ran 103ms late; the new ticker
  delivered all 40 with a 1.2ms worst-case deviation.

### Fixed
- `guardMs` now defaults to `min(500, trMs / 2)` instead of a flat `500`. The old
  default made `create()` throw for any TR at or below 500 ms, so a short-TR
  sequence could not be configured at all.
- Unknown options now throw instead of being ignored, with a "did you mean"
  hint. A typo in `trMs` previously left the task running at the 1000 ms default
  while the scanner ran at a different TR, and nothing looked wrong.
- `destroy()` now removes the `visibilitychange` listener (it previously leaked).
- `destroy()` settles pending waits instead of leaving them unresolved forever.
  They **reject** by default, because silently resolving would advance the task
  past a screen that never ended.
- Pulses arriving after `destroy()` are ignored.

### Unchanged
- The timing logic itself: `hold()`'s sleep-then-sync-to-count contract, the
  `fauxFives:false` default, and the `isTrusted` double-clock detection.
