/** scanner-clock — fMRI trigger clock for browser-based tasks. */

export type Rounding = 'round' | 'floor' | 'ceil';

export interface ScannerClockOptions {
  /** Milliseconds per volume. The only place the TR lives. Default 1000. */
  trMs?: number;
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

export declare function create(opts?: ScannerClockOptions): ScannerClock;
export declare const createScannerClock: typeof create;
export declare const VERSION: string;
export declare const DEFAULTS: ScannerClockOptions;

declare const _default: {
  create: typeof create;
  createScannerClock: typeof create;
  VERSION: string;
  DEFAULTS: typeof DEFAULTS;
};
export default _default;

declare global {
  interface Window { ScannerClock?: typeof _default; }
}
