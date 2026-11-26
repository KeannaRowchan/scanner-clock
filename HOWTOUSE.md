# How to use scanner-clock in a task

You have a task that needs to advance on the scanner's trigger, or you just want
something pressing `5` while you pilot. This is the short version. The
[README](README.md) has the full API.

You do **not** need to copy this folder into your project, and you do not want
relative paths like `../../scanner-clock.js` — tasks move between a laptop, a
lab drive and the scanner PC, and those paths break the moment they do.

## Which route

| Your task is… | Use |
| --- | --- |
| a plain HTML/JS folder you open in a browser (most jsPsych tasks) | **A — one script tag**, nothing to install |
| a project with a `package.json` and a bundler | **B — install from GitHub** |
| being written at the same time as a change to the clock itself | **C — link the local folder** |
| going somewhere with no internet (a scanner PC behind a firewall) | **D — vendor one file** |

---

## A. One script tag (no install)

Add this to your task's HTML, before your own script:

```html
<script src="https://cdn.jsdelivr.net/gh/KeannaRowchan/scanner-clock@v0.1.0/dist/scanner-clock.umd.js"></script>
```

That gives you a global `ScannerClock`:

```html
<script>
  const clock = ScannerClock.create({ trSec: 2 });
</script>
```

**Pin the version.** `@v0.1.0` is a tag; `@main` would also work, but then a
change pushed to the repo mid-study silently changes your task's timing. Pin it,
and bump it deliberately between studies.

## B. Install from GitHub

No npm publish needed — npm installs straight from the repo:

```bash
npm install github:KeannaRowchan/scanner-clock#v0.1.0
```

```js
import { create, simulate } from 'scanner-clock';
```

Drop the `#v0.1.0` to track `main`, with the same caveat as above. This writes
the dependency into your `package.json`, so anyone who clones your task gets the
same clock.

## C. Link the local folder

For when you are editing the clock and a task together and want changes to show
up immediately. From your task's folder:

```bash
npm install ~/Projects/scanner-clock
```

npm symlinks it rather than copying, so edits to the clock's source appear in
your task with no reinstall. It records the dependency as
`"scanner-clock": "file:../scanner-clock"`.

**Don't ship a task in this state.** That path only exists on your machine, so
`npm install` will fail for anyone who clones it — switch the dependency back to
route B before you hand the task over.

(`npm link` does the same job via a global symlink. The path install is easier
to undo: it's just a dependency.)

## D. Vendor one file

For a machine with no internet. Copy the single built file into your task:

```bash
cp ~/Projects/scanner-clock/dist/scanner-clock.umd.js /path/to/your/task/lib/
```

```html
<script src="lib/scanner-clock.umd.js"></script>
```

Write down which version you copied — `ScannerClock.VERSION` and
`clock.snapshot().version` both report it, and `snapshot()` goes in your data
file, so a vendored copy is still traceable after the fact.

This route is for a `<script>` tag in a browser, which is how both example pages
load it. A vendored `.js` copied into a **Node** project whose `package.json`
says `"type": "module"` won't `require()` — Node parses the loose `.js` as ESM
and the UMD wrapper can't see `module`. Use route B there instead.

---

## The two things you actually write

### Just press 5s (piloting, or testing a task that isn't yours)

```js
const scanner = ScannerClock.simulate(2);   // a "5" keydown every 2s
// ...
scanner.stop();
```

It dispatches real keyboard events at the window, so **any** task that listens
for the trigger will advance — it doesn't need to know this module exists. Use
it to check a task reacts to triggers at all before you're standing in the
console room.

### Run a task off the pulses

```js
const clock = ScannerClock.create({
  trSec: 2,            // your sequence's TR
  fauxFives: false,    // true ONLY when piloting away from the scanner
  onLog: (event, data) => jsPsych.data.write({ clock_event: event, ...data }),
});

await clock.awaitRunStart();        // waits for the scan to start
await clock.holdVolumes(5);         // burn-in

for (const trial of trials) {
  showImage(trial);
  await clock.holdVolumes(1);
  showBlank();
  await clock.holdVolumes(trial.jitterVolumes);
}

jsPsych.data.addProperties({ scanner_clock: clock.snapshot() });
```

`holdVolumes(n)` holds for exactly `n` volumes and ends on the pulse that
completes the last one. `hold(ms)` takes milliseconds instead and rounds to
whole volumes, telling you when the rounding wasn't exact.

In jsPsych, give the trial `trial_duration: null` and call
`jsPsych.finishTrial()` from the hold — see [examples/jspsych.js](examples/jspsych.js).

## Check it worked

Write `clock.snapshot()` into every data file and check four fields:

| Field | Must be |
| --- | --- |
| `fauxPulses` | `0` on a scanner run — anything else means the generator was left on |
| `doubleClockDetected` | `false` |
| `hiddenMs` | `0` — otherwise the task left the foreground and timing is suspect |
| `trMs` | the TR the sequence actually ran at |

If those four are right, the timing is right.

## When it doesn't work

**Nothing advances, the task just sits there.** That is the designed behaviour
when no trigger is arriving — it's waiting for the scanner. Press `5` yourself
to check it moves. For piloting, you forgot `fauxFives: true`. To be warned
about this in the scanner instead of staring at a frozen screen, set
`pulseTimeoutMs: 15000`.

**Everything runs about twice as fast.** You left `fauxFives: true` on in the
scanner, so the generator and the scanner are both counting. The console will
have one `scanner-clock:` error saying exactly this.

**A participant's `5` response is counted as a volume.** It isn't, if the
response went into an `<input>` or `<textarea>` — those are ignored. If your
response collector uses something else, use a different response key, or a
different trigger key via `key: 't'`.

**`create()` throws about the TR.** The TR must be a multiple of 0.1 s, and
seconds and milliseconds are guarded against each other — `trSec: 2` and
`trMs: 2000` are the same thing, `trMs: 2` is an error. For a TR finer than a
tenth of a second, pass `trStepMs: 10` (or `0` for anything).

## Updating

```bash
cd ~/Projects/scanner-clock && git pull
```

Then bump the pinned version in your task (the `@v0.1.0` in routes A and B).
Tasks that pinned an older tag keep running the clock they were validated with —
which is the point of pinning.
