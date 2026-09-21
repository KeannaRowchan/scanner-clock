/**
 * Using scanner-clock inside a jsPsych timeline.
 *
 * The idea: jsPsych owns what is on screen and how responses are collected;
 * the clock owns when each screen ends. So every trial sets
 * `trial_duration: null` and calls `jsPsych.finishTrial()` from a hold.
 */
import { create } from 'scanner-clock';

const clock = create({
  trMs: 2400,          // whatever the sequence runs at; nothing else assumes 1s
  key: '5',
  dummyVolumes: 4,     // steady-state volumes discarded before the run
  strictDurations: true, // refuse a schedule that isn't whole volumes
  pulseTimeoutMs: 15000, // shout if no trigger arrives while we are waiting
  fauxFives: false,    // <- true only for behavioural piloting
  onLog: (event, data) => jsPsych.data.write({ clock_event: event, ...data }),
});

/** A screen that lasts an exact number of volumes. */
function lockedTrial({ stimulus, choices, volumes, label }) {
  return {
    type: jsPsychHtmlKeyboardResponse,
    stimulus,
    choices,
    trial_duration: null,        // the clock ends this trial, not jsPsych
    on_load() {
      // holdVolumes, not hold(ms): the design is specified in volumes, so there
      // is nothing to round.
      clock.holdVolumes(volumes, { label }).then(() => jsPsych.finishTrial());
    },
    data: { label },
    on_start: () => ({ onset_volume: clock.count }),
    on_finish(data) {
      data.offset_volume = clock.count;
      data.volumes_used = data.offset_volume - data.onset_volume;  // QC: should equal `volumes`
    },
  };
}

const timeline = [
  {
    type: jsPsychHtmlKeyboardResponse,
    stimulus: '<p>Waiting for the scanner…</p>',
    choices: 'NO_KEYS',
    trial_duration: null,
    on_load() {
      clock.awaitRunStart({ run: 'main' })          // waits 1 pulse + 4 dummies
        .then(() => clock.holdVolumes(5, { label: 'burn-in' }))
        .then(() => jsPsych.finishTrial());
    },
  },
  ...trials.flatMap(t => [
    lockedTrial({ stimulus: `<img src="${t.src}">`, choices: ['1', '2'], volumes: 1, label: 'stim' }),
    lockedTrial({ stimulus: '<p>+</p>', choices: 'NO_KEYS', volumes: t.jitterVolumes, label: 'iti' }),
  ]),
  lockedTrial({ stimulus: '<p>+</p>', choices: 'NO_KEYS', volumes: 1, label: 'burn-out' }),
];

jsPsych.run(timeline).then(() => {
  // One row per session with everything QC needs.
  jsPsych.data.addProperties({ scanner_clock: clock.snapshot() });
  clock.destroy();
});
