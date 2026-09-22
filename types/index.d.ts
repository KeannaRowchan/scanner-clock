/** scanner-clock — fMRI trigger clock for browser-based tasks. */

export type Rounding = 'round' | 'floor' | 'ceil';

export interface ScannerClockOptions {
  /** Milliseconds per volume. The only place the TR lives. Default 1000. */
  trMs?: number;
  /** The TR in seconds instead — give this or `trMs`, not both. */
  trSec?: number;
  /** TR granularity. Default 100: tenths of a second. 0 allows any TR. */
  trStepMs?: number;
  /** Key, or keys, the scanner sends. Default '5'. */
  key?: string | string[];
  /** Pulses the sequence sends per volume — raise it for per-slice or per-echo triggers. Default 1. */
  pulsesPerVolume?: number;
  /** Dummy (steady-state) volumes awaitRunStart() waits out. Default 0. */
  dummyVolumes?: number;
  /** Sleep stops this many ms early, then syncs to the pulse. Must be < trMs. Default: min(500, trMs / 2). */
  guardMs?: number | null;
  /** How milliseconds convert to whole volumes. Default 'round'. */
  rounding?: Rounding;
  /** Throw instead of rounding when a duration is not a whole number of volumes. Default false. */
  strictDurations?: boolean;
  /** Warn when a wait sees no pulse for this long. 0 (default) disables it. */
  pulseTimeoutMs?: number;
  /** Generate pulses locally for behavioural piloting. Default false (real pulses only). */
  fauxFives?: boolean;
  /** Log sink: called as (event, data) for every clock event. */
  onLog?: ((event: ScannerClockEvent, data: Record<string, unknown>) => void) | null;
  /** Operator-facing warnings. Default: console.error. */
  onWarn?: ((message: string, event: ScannerClockEvent, data: Record<string, unknown>) => void) | null;
  /** Ignore the key when it is typed into an input/textarea/contenteditable. Default true. */
  ignoreTextEntry?: boolean;
  /** Emit a 'pulse' event for every volume. Verbose. Default false. */
  logPulses?: boolean;
  /** Call start() during create(). Default false. */
  autoStart?: boolean;
  /** Busy-wait the last N ms of each TR so pulses land within ~0.001ms. Default 0. */
  spinMs?: number;
  /** EventTarget to listen on. Default globalThis.window. */
  target?: EventTarget | null;
  /** Document used for visibility logging. Default globalThis.document. */
  doc?: Document | null;
  /** @deprecated use fauxFives */
  faux_fives?: boolean;
  /** @deprecated use fauxFives */
  mode?: 'faux' | 'real';
}

export type ScannerClockEvent =
  | 'pulse'
  | 'run_start'
  | 'hold_end'
  | 'duration_rounded'
  | 'pulse_timeout'
  | 'visibility_change'
  | 'double_clock_warning'
  | 'faux_catch_up'
  | 'faux_scanner_started'
  | 'faux_scanner_stopped'
  | 'faux_disabled'
  | 'destroyed';

export interface HoldOptions {
  /** Fires just before the trailing pulse-wait, with the current volume. */
  onWaitStart?: (volume: number) => void;
  /** Abort the wait early; the returned promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Free-form label attached to the emitted 'hold_end' event. */
  label?: string;
}

export interface ScannerClockSnapshot {
  version: string;
  /** Volumes counted. */
  volume: number;
  /** Raw pulses counted. Differs from `volume` only when pulsesPerVolume > 1. */
  pulses: number;
  trMs: number;
  guardMs: number;
  pulsesPerVolume: number;
  dummyVolumes: number;
  /** Worst deviation of the faux pulse train from the ideal schedule, in ms. */
  fauxDriftMs: number;
  rounding: Rounding;
  key: string[];
  fauxFives: boolean;
  realPulses: number;
  fauxPulses: number;
  manualPulses: number;
  doubleClockDetected: boolean;
  visibilityChanges: number;
  hiddenMs: number;
  pendingWaits: number;
  running: boolean;
  destroyed: boolean;
}

export interface ScannerClock {
  /** Volumes counted since create(). */
  readonly count: number;
  /** Alias of count. */
  readonly volume: number;
  readonly fauxFives: boolean;
  /** Pulses from trusted (hardware) events. Should equal count in the scanner. */
  readonly realPulses: number;
  /** Pulses from synthetic events. Should be 0 in the scanner. */
  readonly fauxPulses: number;
  readonly manualPulses: number;
  /** Raw pulses, before the pulsesPerVolume divisor. */
  readonly rawPulses: number;
  /** Total ms the document has spent hidden. Nonzero means suspect timing. */
  readonly hiddenMs: number;
  readonly trMs: number;
  readonly guardMs: number;
  readonly pulsesPerVolume: number;
  readonly dummyVolumes: number;
  readonly key: string[];
  readonly running: boolean;
  readonly destroyed: boolean;

  msToVolumes(ms: number): number;
  volumesToMs(volumes: number): number;

  /** Start the faux generator. No-op (returns false) unless fauxFives is on. */
  start(): boolean;
  /** Stop the faux generator. Real pulses are still counted. */
  stop(): void;
  /** Remove listeners and settle pending waits (reject by default). */
  destroy(opts?: { settle?: 'reject' | 'resolve' }): void;
  /** Inject a pulse by hand (tests, replay, or a non-keyboard trigger source). */
  pulse(): number;
  /** Subscribe to an event ('*' for all). Returns an unsubscribe function. */
  on(event: ScannerClockEvent | '*', fn: (data: Record<string, unknown>, event: ScannerClockEvent) => void): () => void;
  /** Everything QC needs, in one object. */
  snapshot(): ScannerClockSnapshot;

  /** Hold for targetMs, rounded to whole volumes, ending on a pulse. */
  hold(targetMs: number, opts?: HoldOptions | ((volume: number) => void)): Promise<number>;
  /** Hold for an exact number of volumes — never rounded. */
  holdVolumes(volumes: number, opts?: HoldOptions | ((volume: number) => void)): Promise<number>;
  /** Hold until an absolute wall-clock deadline, ending on a pulse. */
  holdUntil(deadlineMs: number, opts?: HoldOptions | ((volume: number) => void)): Promise<number>;
  /** Resolve after n further pulses. Pure counting; immune to timer throttling. */
  awaitTriggers(n: number, signal?: AbortSignal): Promise<number>;
  /** Resolve once the volume count reaches an absolute target. */
  awaitCount(target: number, signal?: AbortSignal): Promise<number>;
  /** Wait out one pulse plus any dummy volumes, then log 'run_start'. */
  awaitRunStart(meta?: { dummyVolumes?: number } & Record<string, unknown>): Promise<number>;
}

/** A running stand-in for the scanner: presses the trigger key at exactly the TR. */
export interface ScannerSimulator {
  /** Start pulsing (already started unless you passed `autoStart: false`). */
  start(): ScannerSimulator;
  stop(): ScannerSimulator;
  readonly running: boolean;
  /** Pulses emitted so far. */
  readonly count: number;
  readonly elapsedMs: number;
  /** How late the last pulse was against the ideal schedule, in ms. */
  readonly driftMs: number;
  /** Worst deviation seen — the number behind "exactly the TR". */
  readonly maxAbsDriftMs: number;
  readonly trMs: number;
  readonly trSec: number;
  readonly key: string;
  /** Busy-wait window in ms. Defaults to 2 for simulate(). */
  readonly spinMs: number;
}

export interface SimulateOptions {
  /** TR in seconds. Must be a multiple of 0.1s unless `trStepMs` says otherwise. */
  trSec?: number;
  /** TR in milliseconds instead. */
  trMs?: number;
  /** TR granularity. Default 100. */
  trStepMs?: number;
  /** Busy-wait the last N ms of each TR. Default 2 — pass 0 to opt out. */
  spinMs?: number;
  /** Key to press. Default '5'. */
  key?: string | string[];
  /** EventTarget to dispatch on. Default globalThis.window. */
  target?: EventTarget | null;
  /** Called on every pulse. */
  onPulse?: (info: { pulse: number; burst: number; trMs: number; driftMs: number }) => void;
  /** Pass false to create it stopped. Default true. */
  autoStart?: boolean;
}

export declare function create(opts?: ScannerClockOptions): ScannerClock;

/**
 * Press the trigger key at exactly the TR, and nothing else — a stand-in for
 * the scanner in front of any task, including one that does not use this module.
 *
 *   const scanner = simulate(2);   // a "5" keydown every 2s
 *   scanner.stop();
 */
export declare function simulate(trSec: number, opts?: SimulateOptions): ScannerSimulator;
export declare function simulate(opts: SimulateOptions): ScannerSimulator;
export declare const createScannerClock: typeof create;
export declare const VERSION: string;
export declare const DEFAULTS: ScannerClockOptions;

declare const _default: {
  create: typeof create;
  createScannerClock: typeof create;
  simulate: typeof simulate;
  VERSION: string;
  DEFAULTS: typeof DEFAULTS;
};
export default _default;

declare global {
  interface Window { ScannerClock?: typeof _default; }
}
