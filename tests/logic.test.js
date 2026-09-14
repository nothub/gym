// Fast tier: runs the app's real <script> against a fake DOM, clock, storage and
// navigator. No browser, no network, no dependencies -- `deno test --allow-read`.
//
// This tier owns the parts that are pure logic: when cues fire, where the
// boundaries land for each strategy, which preference wins. Anything that needs
// a real rendering engine lives in browser.spec.js instead.

import { deepStrictEqual, strictEqual, ok } from "node:assert";

// The build output, not the source: the tests assert on what ships.
const ROOT = new URL("../dist/", import.meta.url);
const src = Deno.readTextFileSync(new URL("index.html", ROOT));
const code = src.match(/<script>([\s\S]*?)<\/script>/)[1];

const PRESET_KEYS = ["emom", "e2mom", "tabata", "custom", "amrap", "rft"];

// Two independent checkboxes, so the four cue modes are their combinations.
// Named here purely to keep the test bodies readable.
const CUE_STATES = {
    both: { sound: true, buzz: true },
    sound: { sound: true, buzz: false },
    vibrate: { sound: false, buzz: true },
    off: { sound: false, buzz: false },
};
const STEP = 16; // ~60fps, matching requestAnimationFrame

/**
 * Load the app into a synthetic environment and run one workout.
 * Returns everything the app tried to do to the outside world.
 *
 * `stopAt`, when given, runs the clock to exactly that many simulated ms and
 * stops there -- for inspecting a workout mid-flight. Without it, the clock
 * runs until the app itself declares "Done" (works for every strategy, since
 * RFT never reaches that through elapsed time alone) or a safety cap trips.
 *
 * `tapAt` schedules clicks on the tap target at given elapsed-ms offsets, for
 * driving AMRAP and RFT the way a finger would.
 */
async function run({
    vibrate = true,
    stored = null,
    pick = null,
    preset = "emom",
    count = 3,
    workSecs = null,
    restSecs = null,
    tapAt = [],
    stopAt = null,
    build = "dev",
    audioThrows = false,
} = {}) {
    let now = 0;
    const beeps = [];
    const buzzes = [];
    const frames = [];
    const timeouts = [];
    const flashes = [];
    const wakeLog = [];

    const makeEl = (id) => ({
        id,
        _cls: "",
        _value: "",
        _attrs: {},
        textContent: "",
        hidden: false,
        disabled: false,
        max: "",
        name: "",
        value: undefined, // overwritten below for plain fields; radios use this directly
        checked: false,
        _handlers: {},
        addEventListener(type, fn) {
            (this._handlers[type] ||= []).push(fn);
        },
        fire(type, ev = { preventDefault() {} }) {
            (this._handlers[type] || []).forEach((fn) => fn(ev));
        },
        focus() {},
        setAttribute(name, v) {
            this._attrs[name] = v;
        },
        getAttribute(name) {
            return this._attrs[name] ?? null;
        },
        removeAttribute(name) {
            delete this._attrs[name];
        },
        get className() {
            return this._cls;
        },
        set className(v) {
            this._cls = v;
        },
    });

    // Number inputs: value and valueAsNumber are two views of one field, as in
    // the DOM. Built separately from makeEl because radios use `value` as a
    // plain string constant instead.
    const makeNumberEl = (id) => {
        const el = makeEl(id);
        Object.defineProperty(el, "value", {
            get() {
                return el._value;
            },
            set(v) {
                el._value = String(v);
            },
        });
        Object.defineProperty(el, "valueAsNumber", {
            get() {
                return el._value === "" ? NaN : Number(el._value);
            },
            set(n) {
                el._value = String(n);
            },
        });
        return el;
    };

    const els = {};
    for (
        const id of [
            "setup", "count", "count-label", "custom-fields", "work-secs", "rest-secs",
            "timer", "phase", "seconds", "round-label",
            "pause", "reset", "live", "presets", "cues", "cue-sound", "cue-buzz", "build",
        ]
    ) {
        els[id] = makeNumberEl(id);
    }
    els.presets.name = "presets";

    // One fake radio per preset, found via document.querySelector the same way
    // the app finds them -- name/value attribute matching, not an id lookup.
    // Real radio inputs sharing a name are mutually exclusive: setting one
    // checked unchecks its siblings. A plain field on each fake element would
    // let init()'s "set the restored preset checked" leave the built-in EMOM
    // default also checked, and .find(r => r.checked) would return whichever
    // comes first rather than the one actually selected.
    const presetRadios = PRESET_KEYS.map((value) => {
        const r = makeEl(`preset-${value}`);
        r.name = "preset";
        r.value = value;
        r._checked = value === "emom";
        return r;
    });
    for (const r of presetRadios) {
        Object.defineProperty(r, "checked", {
            get() {
                return r._checked;
            },
            set(v) {
                r._checked = v;
                if (v) presetRadios.forEach((other) => other !== r && (other._checked = false));
            },
        });
    }

    const bodyClasses = new Set();
    const docHandlers = {};
    const document = {
        visibilityState: "visible",
        addEventListener(type, fn) {
            (docHandlers[type] ||= []).push(fn);
        },
        fire(type) {
            (docHandlers[type] || []).forEach((fn) => fn());
        },
        getElementById: (id) => els[id],
        querySelector(sel) {
            if (sel === 'input[name="preset"]:checked') {
                return presetRadios.find((r) => r.checked) ?? null;
            }
            const m = sel.match(/input\[name="preset"\]\[value="([^"]+)"\]/);
            return m ? presetRadios.find((r) => r.value === m[1]) ?? null : null;
        },
        body: {
            offsetWidth: 0,
            classList: {
                add: (c) => {
                    bodyClasses.add(c);
                    if (c === "flash") flashes.push(now);
                },
                remove: (...cs) => cs.forEach((c) => bodyClasses.delete(c)),
                contains: (c) => bodyClasses.has(c),
            },
        },
    };

    class FakeAudioContext {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
        }
        resume() {
            this.state = "running";
        }
        createOscillator() {
            const o = { frequency: { value: 0 }, connect() {}, stop() {} };
            o.start = () => beeps.push({ t: now, freq: o.frequency.value });
            return o;
        }
        createGain() {
            return {
                gain: {
                    setValueAtTime() {},
                    linearRampToValueAtTime() {},
                    exponentialRampToValueAtTime() {},
                },
                connect() {},
            };
        }
    }

    const store = new Map();
    if (stored) store.set("emom", JSON.stringify(stored));

    // A sentinel the browser can release on its own, as it does when the page
    // is hidden. Released sentinels cannot be reused, so the app has to notice.
    let sentinel = null;

    const navigator = {
        wakeLock: {
            request: async () => {
                wakeLog.push("acquire");
                const listeners = [];
                sentinel = {
                    released: false,
                    addEventListener(type, fn) {
                        if (type === "release") listeners.push(fn);
                    },
                    fireRelease() {
                        sentinel.released = true;
                        listeners.forEach((fn) => fn());
                    },
                    async release() {
                        wakeLog.push("release");
                        sentinel.fireRelease();
                    },
                };
                return sentinel;
            },
        },
    };
    if (vibrate) {
        navigator.vibrate = (pattern) => {
            buzzes.push(pattern);
            return true;
        };
    }

    const sandbox = {
        // version.js assigns onto self; in a page that is window. The worker
        // imports the same file, which is what keeps the two in step.
        self: { BUILD: build },
        document,
        window: {
            // A browser can refuse to construct one at all.
            AudioContext: audioThrows
                ? function () {
                    throw new Error("audio blocked");
                }
                : FakeAudioContext,
            isSecureContext: false,
            addEventListener() {},
        },
        performance: { now: () => now },
        navigator,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, v),
        },
        requestAnimationFrame: (fn) => frames.push(fn),
        cancelAnimationFrame: () => {
            frames.length = 0;
        },
        setTimeout: (fn, ms) => timeouts.push({ fn, at: now + ms }),
    };

    // Not user input: `code` is the <script> block of a first-party file in this
    // repo. Executing it verbatim is the whole point -- a copy would test a copy.
    const keys = Object.keys(sandbox);
    new Function(...keys, code)(...keys.map((k) => sandbox[k]));

    // What init() put in the box, before the run below types over it.
    const initial = {
        preset: presetRadios.find((r) => r.checked)?.value,
        count: els.count.value,
        workSecs: els["work-secs"].value,
        restSecs: els["rest-secs"].value,
    };

    if (pick) {
        els["cue-sound"].checked = CUE_STATES[pick].sound;
        els["cue-buzz"].checked = CUE_STATES[pick].buzz;
        els.cues.fire("change");
    }

    if (preset !== "emom") {
        const radio = presetRadios.find((r) => r.value === preset);
        radio.checked = true; // unchecks its siblings via the setter above
        els.presets.fire("change", { target: radio });
    }

    // What selecting the preset filled in, before `count` below overwrites it
    // with whatever this run asked for.
    const seeded = {
        count: els.count.value,
        workSecs: els["work-secs"].value,
        restSecs: els["rest-secs"].value,
    };

    if (preset === "custom") {
        if (workSecs !== null) {
            els["work-secs"].valueAsNumber = workSecs;
            els["work-secs"].fire("input");
        }
        if (restSecs !== null) {
            els["rest-secs"].valueAsNumber = restSecs;
            els["rest-secs"].fire("input");
        }
    }

    els.count.valueAsNumber = count;
    els.count.fire("input"); // typing is what persists the count
    els.setup.fire("submit");
    await Promise.resolve(); // let the wake-lock request settle

    const tapQueue = [...tapAt].sort((a, b) => a - b);
    const cap = 20 * 60_000; // safety bound: no real test should ever reach this
    const bound = stopAt ?? cap;

    // Once "Done" is reached in completion mode, keep running a little longer:
    // the finish fanfare's last two beeps are scheduled via setTimeout at 220
    // and 440 ms out, and stopping the instant the phase flips would cut them.
    let doneAt = null;

    while (now < bound) {
        now += STEP;
        while (tapQueue.length && tapQueue[0] <= now) {
            tapQueue.shift();
            els.seconds.fire("click");
        }
        frames.splice(0).forEach((fn) => fn());
        timeouts
            .filter((t) => t.at <= now && !t.done)
            .forEach((t) => {
                t.done = true;
                t.fn();
            });
        if (stopAt === null) {
            if (doneAt === null && els.phase.textContent === "Done") doneAt = now;
            if (doneAt !== null && now - doneAt > 1000) break;
        }
    }

    const setVisibility = async (state) => {
        document.visibilityState = state;
        document.fire("visibilitychange");
        await Promise.resolve();
    };

    // What the browser does when the page is hidden: releases the lock without
    // the app asking, so nothing is appended to wakeLog.
    const browserDropsLock = async () => {
        sentinel?.fireRelease();
        await Promise.resolve();
    };

    const bodyHasClass = (c) => bodyClasses.has(c);
    const tap = () => els.seconds.fire("click");

    return {
        els, initial, seeded, beeps, buzzes, flashes, store, wakeLog,
        setVisibility, browserDropsLock, bodyHasClass, tap,
    };
}

const freqs = (beeps, hz) => beeps.filter((b) => b.freq === hz);

/* ---------- Intervals: EMOM shape (rest = 0) ---------- */

Deno.test("counts down three ticks before every cycle, prep included", async () => {
    const { beeps } = await run({ preset: "emom", count: 3 });
    // Four countdowns: the prep, then one leading into each of cycles 2, 3 and the end.
    strictEqual(freqs(beeps, 660).length, 12);
});

Deno.test("marks the top of every cycle exactly once", async () => {
    const { beeps } = await run({ preset: "emom", count: 3 });
    strictEqual(freqs(beeps, 880).length, 3);
});

Deno.test("cycle boundaries do not drift", async () => {
    const { beeps } = await run({ preset: "emom", count: 5 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    // 10 s of prep, then one cycle per minute, to the millisecond.
    deepStrictEqual(starts, [10_000, 70_000, 130_000, 190_000, 250_000]);
});

Deno.test("never fires the same tick twice inside one second", async () => {
    const { beeps } = await run({ preset: "emom", count: 3 });
    const ticks = freqs(beeps, 660);
    const tooClose = ticks.filter((b, i) => i > 0 && b.t - ticks[i - 1].t < 900);
    deepStrictEqual(tooClose, []);
});

Deno.test("ends on an ascending fanfare and settles the screen", async () => {
    const { beeps, els } = await run({ preset: "emom", count: 3 });
    deepStrictEqual(
        beeps.filter((b) => [523, 659, 784].includes(b.freq)).map((b) => b.freq),
        [523, 659, 784],
    );
    strictEqual(els.seconds.textContent, "💪");
    strictEqual(els["round-label"].textContent, "3 cycles");
    strictEqual(els.pause.hidden, true);
    strictEqual(els.seconds.disabled, true);
    strictEqual(els.reset.textContent, "Again");
});

Deno.test("a workout runs to the end when audio cannot start", async () => {
    const { els, beeps, buzzes, flashes } = await run({ preset: "emom", count: 2, audioThrows: true });

    // The clock is the product; sound is a cue. Losing the cue must not lose
    // the workout, and the visual and haptic cues carry on regardless.
    strictEqual(els.seconds.textContent, "💪");
    strictEqual(els["round-label"].textContent, "2 cycles");
    deepStrictEqual(beeps, []);
    strictEqual(flashes.length, 3);
    ok(buzzes.length > 0);
});

Deno.test("silent mode drops sound and buzz but keeps the flash", async () => {
    const { beeps, buzzes, flashes } = await run({ preset: "emom", count: 2, pick: "off" });
    deepStrictEqual(beeps, []);
    deepStrictEqual(buzzes, []);
    // One per cycle start, one for the finish.
    strictEqual(flashes.length, 3);
});

Deno.test("sound and buzz modes are independent", async () => {
    const sound = await run({ preset: "emom", count: 2, pick: "sound" });
    ok(sound.beeps.length > 0);
    deepStrictEqual(sound.buzzes, []);

    const buzz = await run({ preset: "emom", count: 2, pick: "vibrate" });
    deepStrictEqual(buzz.beeps, []);
    ok(buzz.buzzes.length > 0);
});

/* ---------- Intervals: rest > 0 (the E2MOM/Tabata/Custom shape) ---------- */

Deno.test("Tabata cues both the work-to-rest and rest-to-work transitions", async () => {
    const { beeps } = await run({ preset: "tabata", count: 2 });
    // Prep->work, work->rest, rest->work, work->rest, rest->work(would-be cycle 3,
    // but count=2 stops it): 2 cycles of work+rest is 4 real transitions plus the
    // initial "go", so 880Hz fires once per phase entry -- 4 for 2 full cycles.
    strictEqual(freqs(beeps, 880).length, 4);
});

Deno.test("Tabata's phase label alternates Work and Rest, never Run", async () => {
    const { els } = await run({ preset: "tabata", count: 1, stopAt: 10_000 + 15_000 });
    // 15 s into a 20/10 cycle: still inside the 20 s work period.
    strictEqual(els.phase.textContent, "Work");

    const rest = await run({ preset: "tabata", count: 1, stopAt: 10_000 + 25_000 });
    // 25 s in: 20 s of work has elapsed, 5 s into the 10 s rest.
    strictEqual(rest.els.phase.textContent, "Rest");
});

Deno.test("the countdown into rest gets the same 3-2-1 tick as the countdown into work", async () => {
    const { beeps } = await run({ preset: "tabata", count: 1 });
    // 20/10, one cycle: every boundary gets a countdown, including the last
    // one, which leads into "done" rather than another phase -- prep->work,
    // work->rest, rest->done. Three windows, three ticks each.
    strictEqual(freqs(beeps, 660).length, 9);
});

Deno.test("E2MOM is Intervals(120, 0): the collapse holds at a different work length", async () => {
    const { beeps } = await run({ preset: "e2mom", count: 2 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    deepStrictEqual(starts, [10_000, 130_000]);
    // prep->work1, work1->work2 (rest = 0, so no rest phase), work2->done.
    strictEqual(freqs(beeps, 660).length, 9);
});

Deno.test("Custom reads work and rest from the form, not a canonical preset", async () => {
    // 8/8 rather than 5/5: both divide the test's 16 ms step evenly, so the
    // transitions land on exact simulated milliseconds instead of a few
    // milliseconds late -- a step-size artifact, not a claim about derive().
    const { beeps } = await run({ preset: "custom", count: 2, workSecs: 8, restSecs: 8 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    // Work and rest both cue: two cycles of work+rest is four entries.
    deepStrictEqual(starts, [10_000, 18_000, 26_000, 34_000]);
});

/* ---------- Presets: what selecting one fills into the form ---------- */

Deno.test("every named preset seeds its canonical work, rest and cycle count", async () => {
    const canonical = {
        emom: { count: "10", workSecs: "60", restSecs: "0" },
        e2mom: { count: "6", workSecs: "120", restSecs: "0" },
        tabata: { count: "8", workSecs: "20", restSecs: "10" },
    };
    for (const [preset, want] of Object.entries(canonical)) {
        const { seeded } = await run({ preset, count: 1, stopAt: 0 });
        deepStrictEqual(seeded, want, preset);
    }
});

Deno.test("Custom reveals the work/rest fields; named presets and AMRAP/RFT hide them", async () => {
    for (const preset of ["emom", "e2mom", "tabata", "amrap", "rft"]) {
        const { els } = await run({ preset, count: 1, stopAt: 0 });
        strictEqual(els["custom-fields"].hidden, true, preset);
    }
    const { els } = await run({ preset: "custom", count: 1, stopAt: 0 });
    strictEqual(els["custom-fields"].hidden, false);
});

Deno.test("the count field is relabelled per strategy", async () => {
    const labels = { emom: "Cycles", e2mom: "Cycles", tabata: "Cycles", custom: "Cycles", amrap: "Minutes", rft: "Rounds" };
    for (const [preset, label] of Object.entries(labels)) {
        const { els } = await run({ preset, count: 1, stopAt: 0 });
        strictEqual(els["count-label"].textContent, label, preset);
    }
});

/* ---------- AMRAP ---------- */

Deno.test("AMRAP counts down a fixed window and reports rounds by tap", async () => {
    const { els } = await run({
        preset: "amrap",
        count: 1, // 1 minute window
        tapAt: [10_000 + 20_000, 10_000 + 45_000],
    });
    strictEqual(els.phase.textContent, "Done");
    strictEqual(els["round-label"].textContent, "2 rounds");
});

Deno.test("AMRAP cues the start and the finish, never an intermediate boundary", async () => {
    const { beeps } = await run({
        preset: "amrap",
        count: 1,
        tapAt: [10_000 + 20_000, 10_000 + 40_000, 10_000 + 55_000],
    });
    // One "go" at prep's end, no more until the fanfare -- taps must not re-fire it.
    strictEqual(freqs(beeps, 880).length, 1);
    deepStrictEqual(
        beeps.filter((b) => [523, 659, 784].includes(b.freq)).map((b) => b.freq),
        [523, 659, 784],
    );
});

Deno.test("AMRAP ticks the last three seconds of the window", async () => {
    const { beeps } = await run({ preset: "amrap", count: 1 });
    // Prep's countdown, plus the window's own final three seconds.
    strictEqual(freqs(beeps, 660).length, 6);
});

Deno.test("a tap while paused does not count", async () => {
    const { els, tap } = await run({
        preset: "amrap",
        count: 5,
        stopAt: 10_000 + 5_000,
    });
    els.pause.fire("click");
    tap();
    tap();
    els.pause.fire("click");
    // The live round-label reflects taps taken only while running.
    strictEqual(els["round-label"].textContent, "Round 0");
});

Deno.test("the live progress label carries no total for AMRAP", async () => {
    const { els } = await run({
        preset: "amrap",
        count: 5,
        tapAt: [10_000 + 5_000],
        stopAt: 10_000 + 6_000,
    });
    strictEqual(els["round-label"].textContent, "Round 1");
});

/* ---------- RFT ---------- */

Deno.test("RFT counts up and ends on the target tap, not on elapsed time", async () => {
    const { els } = await run({
        preset: "rft",
        count: 3,
        tapAt: [10_000 + 5_000, 10_000 + 12_000, 10_000 + 20_000],
    });
    strictEqual(els.phase.textContent, "Done");
    // Final result is the clock, not the emoji -- elapsed time is RFT's score.
    strictEqual(els.seconds.textContent, "0:20");
    strictEqual(els["round-label"].textContent, "3 rounds");
});

Deno.test("RFT never fires the 3-2-1 tick cue", async () => {
    const { beeps } = await run({
        preset: "rft",
        count: 1,
        tapAt: [10_000 + 3_000],
    });
    // Only the prep countdown counts down to anything; nothing counts down
    // within RFT itself, since it has no bound to count down to.
    strictEqual(freqs(beeps, 660).length, 3);
});

Deno.test("RFT's live display is a clock, counting up past a minute", async () => {
    const { els } = await run({
        preset: "rft",
        count: 5,
        stopAt: 10_000 + 65_000,
    });
    strictEqual(els.seconds.textContent, "1:05");
});

Deno.test("RFT does not finish just because time passed", async () => {
    const { els } = await run({
        preset: "rft",
        count: 3,
        tapAt: [10_000 + 5_000], // only one of the three taps needed
        stopAt: 10_000 + 120_000,
    });
    strictEqual(els.phase.textContent, "Work");
    strictEqual(els["round-label"].textContent, "Round 1");
});

/* ---------- Persistence ---------- */

Deno.test("preset, count, and custom work/rest are restored from storage", async () => {
    const stored = { preset: "custom", count: 7, workSecs: 33, restSecs: 11 };
    const { initial } = await run({ preset: "custom", stored, stopAt: 0 });
    strictEqual(initial.preset, "custom");
    strictEqual(initial.count, "7");
    strictEqual(initial.workSecs, "33");
    strictEqual(initial.restSecs, "11");
});

Deno.test("an unknown stored preset falls back to EMOM", async () => {
    const { initial } = await run({ preset: "emom", stored: { preset: "nonsense" }, stopAt: 0 });
    strictEqual(initial.preset, "emom");
});

Deno.test("an unusable stored count falls back to the preset's canonical default", async () => {
    for (const bad of [500, 0, -3, 1.5, "abc", null]) {
        const { initial } = await run({ preset: "tabata", stored: { preset: "tabata", count: bad }, stopAt: 0 });
        strictEqual(initial.count, "8", `count: ${JSON.stringify(bad)}`);
    }
});

Deno.test("selecting a preset persists it alongside the cue choices", async () => {
    const { store } = await run({ preset: "rft", count: 4, pick: "sound" });
    const saved = JSON.parse(store.get("emom"));
    strictEqual(saved.preset, "rft");
    strictEqual(saved.count, 4);
    strictEqual(saved.sound, true);
    strictEqual(saved.buzz, false);
});

/* ---------- Cues on/off, unrelated to strategy ---------- */

Deno.test("both cues are on by default", async () => {
    const { els } = await run({ preset: "emom", count: 1 });
    strictEqual(els["cue-sound"].checked, true);
    strictEqual(els["cue-buzz"].checked, true);
    strictEqual(els["cue-buzz"].disabled, false);
});

Deno.test("without a Vibration API the buzz box is off and disabled", async () => {
    const { els, buzzes, beeps } = await run({
        preset: "emom",
        count: 1,
        vibrate: false,
        stored: { sound: true, buzz: true },
    });
    strictEqual(els["cue-buzz"].disabled, true);
    // Left ticked it would read as working, which it would not be.
    strictEqual(els["cue-buzz"].checked, false);
    deepStrictEqual(buzzes, []);
    ok(beeps.length > 0);
});

Deno.test("each checkbox is restored from storage independently", async () => {
    for (const [mode, want] of Object.entries(CUE_STATES)) {
        const { els } = await run({ preset: "emom", count: 1, stored: want });
        strictEqual(els["cue-sound"].checked, want.sound, `${mode} sound`);
        strictEqual(els["cue-buzz"].checked, want.buzz, `${mode} buzz`);
    }
});

/* ---------- Build id in the footer ---------- */

Deno.test("shows the build id in the footer when there is one", async () => {
    const { els } = await run({ preset: "emom", count: 1, build: "4094c69" });
    strictEqual(els.build.textContent, "4094c69");
    strictEqual(els.build.href, "https://github.com/nothub/gym-timer/commit/4094c69");
});

Deno.test("leaves the footer fallback alone for an unbuilt copy", async () => {
    // The markup already says "dev" pointing at the commit list; overwriting it
    // with the literal placeholder would be worse than leaving it.
    const { els } = await run({ preset: "emom", count: 1, build: "dev" });
    strictEqual(els.build.textContent, "");
    strictEqual(els.build.href, undefined);
});

/* ---------- Screen wake lock and the paused pulse ---------- */

Deno.test("holds the screen awake for the workout and releases it at the end", async () => {
    const { wakeLog } = await run({ preset: "emom", count: 1 });
    deepStrictEqual(wakeLog, ["acquire", "release"]);
});

Deno.test("does not release a sentinel the browser already dropped", async () => {
    const mid = await run({ preset: "emom", count: 5, stopAt: 40_000 });
    strictEqual(mid.wakeLog.filter((x) => x === "release").length, 0);

    await mid.browserDropsLock();
    mid.els.reset.fire("click"); // back to setup, which releases the screen

    // A released sentinel cannot be reused, so calling release on it again is
    // working on a dead object. The app should have let go of the reference.
    strictEqual(mid.wakeLog.filter((x) => x === "release").length, 0);
});

Deno.test("freezes the pulse while paused", async () => {
    const mid = await run({ preset: "emom", count: 5, stopAt: 40_000 });
    strictEqual(mid.bodyHasClass("paused"), false);

    mid.els.pause.fire("click");
    strictEqual(mid.bodyHasClass("paused"), true);
    strictEqual(mid.els.pause.textContent, "Resume");

    mid.els.pause.fire("click");
    strictEqual(mid.bodyHasClass("paused"), false);

    // Reset must clear it too, or the next workout starts frozen.
    mid.els.pause.fire("click");
    mid.els.reset.fire("click");
    strictEqual(mid.bodyHasClass("paused"), false);
});

Deno.test("re-acquires the screen lock the browser dropped while backgrounded", async () => {
    const mid = await run({ preset: "emom", count: 5, stopAt: 40_000 });
    deepStrictEqual(mid.wakeLog, ["acquire"]);

    await mid.setVisibility("hidden");
    deepStrictEqual(mid.wakeLog, ["acquire"], "hiding must not request a new lock");

    await mid.setVisibility("visible");
    deepStrictEqual(mid.wakeLog, ["acquire", "acquire"]);

    mid.els.reset.fire("click");
    strictEqual(mid.wakeLog.at(-1), "release");

    // Back on the setup screen there is no workout to keep awake.
    await mid.setVisibility("visible");
    strictEqual(mid.wakeLog.filter((x) => x === "acquire").length, 2);
});
