/**
 * A ~60-line stand-in for the two DOM objects scanner-clock touches, so the
 * test suite stays dependency-free (no jsdom). It models the parts that matter:
 * capture-phase listeners, event.target, and isTrusted — which is false for
 * anything dispatched from script, exactly as in a browser.
 */

export class FakeEventTarget {
  constructor() { this._listeners = new Map(); }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }

  dispatchEvent(event) {
    const set = this._listeners.get(event.type);
    if (set) for (const fn of [...set]) fn(event);
    return true;
  }

  listenerCount(type) {
    const set = this._listeners.get(type);
    return set ? set.size : 0;
  }
}

export class FakeDocument extends FakeEventTarget {
  constructor() { super(); this.visibilityState = 'visible'; }

  setVisibility(state) {
    this.visibilityState = state;
    this.dispatchEvent({ type: 'visibilitychange' });
  }
}

/** A keydown as the hardware would produce it. */
export function realKey(key, target = null) {
  return { type: 'keydown', key, isTrusted: true, target };
}

/** A keydown as script would produce it. */
export function fauxKey(key, target = null) {
  return { type: 'keydown', key, isTrusted: false, target };
}

export function textField(tag = 'INPUT') {
  return { tagName: tag, isContentEditable: false };
}

/** A fresh window+document pair plus a helper that feeds pulses in. */
export function makeEnv() {
  const win = new FakeEventTarget();
  const doc = new FakeDocument();
  return {
    win,
    doc,
    /** Send n trusted pulses of `key`. */
    pulses(n = 1, key = '5') {
      for (let i = 0; i < n; i++) win.dispatchEvent(realKey(key));
    },
  };
}

export const tick = ms => new Promise(r => setTimeout(r, ms));
