# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

First packaged release, extracted from a single-file `scanner-clock.js`.

### Added
- ESM, CommonJS and UMD builds generated from one source file; TypeScript declarations.
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
