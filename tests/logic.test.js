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

const STRATEGIES = ["intervals", "amrap", "rft"];

// Two independent checkboxes, so the four cue modes are their combinations.
// Named here purely to keep the test bodies readable.
const CUE_STATES = {
    both: { sound: true, buzz: true },
    sound: { sound: true, buzz: false },
    vibrate: { sound: false, buzz: true },
    off: { sound: false, buzz: false },
};
const STEP = 16; // ~60fps, matching requestAnimationFrame
const PREP_MS = 10_000; // mirrors the app's own constant, which every strategy waits out first

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
 *
 * Presets are momentary actions, not a persisted selection, so driving one is
 * separate from choosing the strategy: `strategy` picks the row-1 radio,
 * `intervalsPreset`/`amrapPreset`/`rftPreset` optionally click a row-2 button
 * for whichever strategy is active, and `workSecs`/`restSecs`/`count` let a
 * test type directly into the fields the way editing after a preset would.
 */
async function run({
    vibrate = true,
    stored = null,
    pick = null,
    strategy = "intervals",
    intervalsPreset = null,
    amrapPreset = null,
    rftPreset = null,
    workSecs = null,
    workSecsText = null, // typed verbatim, for exercising the MM:SS parser
    restSecs = null,
    count = 3,
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
        _text: "",
        // Enough of a child model for the RFT lap list, which render() builds
        // with createElement/append. Setting textContent drops the children,
        // as it does in a real DOM -- that is what makes the rebuild on every
        // frame idempotent rather than append-forever.
        children: [],
        get textContent() {
            return this._text;
        },
        set textContent(v) {
            // Coerced, as the real property is: assigning a number and reading
            // back a number is a divergence the app would never see in a
            // browser, and one the tests would then encode as correct.
            this._text = String(v);
            this.children.length = 0;
        },
        append(...nodes) {
            this.children.push(...nodes);
        },
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
            "setup", "count", "count-label", "interval-fields", "work-secs", "rest-secs",
            "timer", "phase", "seconds", "round-label",
            "pause", "reset", "live", "strategies",
            "intervals-presets", "amrap-presets", "rft-presets",
            "cues", "cue-sound", "cue-buzz", "build", "install", "install-sep", "tap-hint", "laps",
        ]
    ) {
        els[id] = makeNumberEl(id);
    }

    // Real radio inputs sharing a name are mutually exclusive: setting one
    // checked unchecks its siblings. A plain field on each fake element would
    // let init()'s "set the restored strategy checked" leave the built-in
    // Intervals default also checked, and .find(r => r.checked) would return
    // whichever comes first rather than the one actually selected.
    const strategyRadios = STRATEGIES.map((value) => {
        const r = makeEl(`strategy-${value}`);
        r.name = "strategy";
        r.value = value;
        r._checked = value === "intervals";
        return r;
    });
    for (const r of strategyRadios) {
        Object.defineProperty(r, "checked", {
            get() {
                return r._checked;
            },
            set(v) {
                r._checked = v;
                if (v) strategyRadios.forEach((other) => other !== r && (other._checked = false));
            },
        });
    }

    // Preset buttons: the app finds them via event.target.closest(selector),
    // walking up from wherever inside the button the click landed. There is
    // nothing to walk up to here -- the fake target IS the button -- so
    // closest() just checks whether this element carries that dataset key.
    const makeButton = (id, datasetKey, datasetValue) => {
        const b = makeEl(id);
        b.dataset = { [datasetKey]: String(datasetValue) };
        // Selectors are kebab-case HTML attributes ("data-intervals-preset");
        // dataset keys are the camelCase the real DOM's dataset API exposes
        // ("intervalsPreset"). Match by converting one to the other.
        b.closest = (sel) => {
            const m = sel.match(/data-([\w-]+)/);
            const camel = m?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            return camel && camel in b.dataset ? b : null;
        };
        return b;
    };
    const intervalsButtons = {
        emom: makeButton("btn-emom", "intervalsPreset", "emom"),
        e2mom: makeButton("btn-e2mom", "intervalsPreset", "e2mom"),
        tabata: makeButton("btn-tabata", "intervalsPreset", "tabata"),
    };
    const amrapButtons = Object.fromEntries(
        [10, 15, 20].map((m) => [m, makeButton(`btn-amrap-${m}`, "amrapPreset", m)]),
    );
    const rftButtons = Object.fromEntries(
        [3, 5, 10].map((n) => [n, makeButton(`btn-rft-${n}`, "rftPreset", n)]),
    );

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
        createElement: (tag) => makeEl(tag),
        querySelector(sel) {
            const m = sel.match(/input\[name="strategy"\]\[value="([^"]+)"\]/);
            if (m) return strategyRadios.find((r) => r.value === m[1]) ?? null;
            if (sel === 'input[name="strategy"]:checked') {
                return strategyRadios.find((r) => r.checked) ?? null;
            }
            return null;
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

    // What init() put in the box, before anything below overwrites it.
    const initial = {
        strategy: strategyRadios.find((r) => r.checked)?.value,
        count: els.count.value,
        workSecs: els["work-secs"].value,
        restSecs: els["rest-secs"].value,
    };

    if (pick) {
        els["cue-sound"].checked = CUE_STATES[pick].sound;
        els["cue-buzz"].checked = CUE_STATES[pick].buzz;
        els.cues.fire("change");
    }

    if (strategy !== "intervals") {
        const radio = strategyRadios.find((r) => r.value === strategy);
        radio.checked = true;
        els.strategies.fire("change", { target: radio });
    }

    if (intervalsPreset) {
        els["intervals-presets"].fire("click", { target: intervalsButtons[intervalsPreset] });
    }
    if (amrapPreset) {
        els["amrap-presets"].fire("click", { target: amrapButtons[amrapPreset] });
    }
    if (rftPreset) {
        els["rft-presets"].fire("click", { target: rftButtons[rftPreset] });
    }

    // What a strategy switch or a preset click left in the fields, before
    // count/workSecs/restSecs below (which every run applies) overwrite it.
    const seeded = {
        count: els.count.value,
        workSecs: els["work-secs"].value,
        restSecs: els["rest-secs"].value,
    };

    if (workSecs !== null) {
        els["work-secs"].valueAsNumber = workSecs;
        els["work-secs"].fire("input");
    }
    if (workSecsText !== null) {
        els["work-secs"].value = workSecsText;
        els["work-secs"].fire("input");
        // What a browser fires when the field is left, which is where the
        // app normalises "90" into "1:30".
        els["work-secs"].fire("change");
    }
    if (restSecs !== null) {
        els["rest-secs"].valueAsNumber = restSecs;
        els["rest-secs"].fire("input");
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
            // Suffix rather than equality: this once had to tolerate RFT's
            // "🏁 Done", and staying loose costs nothing if a strategy
            // ever prefixes the label again.
            if (doneAt === null && els.phase.textContent.endsWith("Done")) doneAt = now;
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
    // [["1", "1:52"], ...] -- the rendered lap rows, number beside time.
    const lapRows = () => els.laps.children.map((li) => li.children.map((c) => c.textContent));
    const tap = () => els.seconds.fire("click");

    return {
        els, initial, seeded, beeps, buzzes, flashes, store, wakeLog, doneAt,
        setVisibility, browserDropsLock, bodyHasClass, tap, lapRows,
    };
}

const freqs = (beeps, hz) => beeps.filter((b) => b.freq === hz);

/* ---------- Intervals: EMOM shape (rest = 0) ---------- */
// No preset click needed for EMOM: it is Intervals' own static default (60/0),
// so the strategy opening on it is what keeps the common case two taps.

Deno.test("counts down three ticks before every cycle, prep included", async () => {
    const { beeps } = await run({ count: 3 });
    // Four countdowns: the prep, then one leading into each of cycles 2, 3 and the end.
    strictEqual(freqs(beeps, 660).length, 12);
});

Deno.test("marks the top of every cycle exactly once", async () => {
    const { beeps } = await run({ count: 3 });
    strictEqual(freqs(beeps, 880).length, 3);
});

Deno.test("cycle boundaries do not drift", async () => {
    const { beeps } = await run({ count: 5 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    // 10 s of prep, then one cycle per minute, to the millisecond.
    deepStrictEqual(starts, [10_000, 70_000, 130_000, 190_000, 250_000]);
});

Deno.test("never fires the same tick twice inside one second", async () => {
    const { beeps } = await run({ count: 3 });
    const ticks = freqs(beeps, 660);
    const tooClose = ticks.filter((b, i) => i > 0 && b.t - ticks[i - 1].t < 900);
    deepStrictEqual(tooClose, []);
});

Deno.test("ends on an ascending fanfare and settles the screen", async () => {
    const { beeps, els } = await run({ count: 3 });
    deepStrictEqual(
        beeps.filter((b) => [523, 659, 784].includes(b.freq)).map((b) => b.freq),
        [523, 659, 784],
    );
    strictEqual(els.phase.textContent, "Done");
    strictEqual(els.seconds.textContent, "💪");
    strictEqual(els["round-label"].textContent, "3 cycles");
    strictEqual(els.pause.hidden, true);
    strictEqual(els.seconds.disabled, true);
    strictEqual(els.reset.textContent, "Again");
});

Deno.test("a workout runs to the end when audio cannot start", async () => {
    const { els, beeps, buzzes, flashes } = await run({ count: 2, audioThrows: true });

    // The clock is the product; sound is a cue. Losing the cue must not lose
    // the workout, and the visual and haptic cues carry on regardless.
    strictEqual(els.seconds.textContent, "💪");
    strictEqual(els["round-label"].textContent, "2 cycles");
    deepStrictEqual(beeps, []);
    strictEqual(flashes.length, 3);
    ok(buzzes.length > 0);
});

Deno.test("silent mode drops sound and buzz but keeps the flash", async () => {
    const { beeps, buzzes, flashes } = await run({ count: 2, pick: "off" });
    deepStrictEqual(beeps, []);
    deepStrictEqual(buzzes, []);
    // One per cycle start, one for the finish.
    strictEqual(flashes.length, 3);
});

Deno.test("sound and buzz modes are independent", async () => {
    const sound = await run({ count: 2, pick: "sound" });
    ok(sound.beeps.length > 0);
    deepStrictEqual(sound.buzzes, []);

    const buzz = await run({ count: 2, pick: "vibrate" });
    deepStrictEqual(buzz.beeps, []);
    ok(buzz.buzzes.length > 0);
});

/* ---------- Intervals: rest > 0, and presets in general ---------- */

Deno.test("the Tabata preset fills work, rest and cycles, and cues both directions", async () => {
    const { beeps } = await run({ intervalsPreset: "tabata", count: 2 });
    // Prep->work, work->rest, rest->work, work->rest: 2 full cycles is 4
    // transitions, each cued, plus the initial "go" already counted in that.
    strictEqual(freqs(beeps, 880).length, 4);
});

Deno.test("Tabata's phase label alternates Work and Rest, never Run", async () => {
    const { els } = await run({ intervalsPreset: "tabata", count: 1, stopAt: 10_000 + 15_000 });
    // 15 s into a 20/10 cycle: still inside the 20 s work period.
    strictEqual(els.phase.textContent, "Work");

    const rest = await run({ intervalsPreset: "tabata", count: 1, stopAt: 10_000 + 25_000 });
    // 25 s in: 20 s of work has elapsed, 5 s into the 10 s rest.
    strictEqual(rest.els.phase.textContent, "Rest");
});

Deno.test("the countdown into rest gets the same 3-2-1 tick as the countdown into work", async () => {
    const { beeps } = await run({ intervalsPreset: "tabata", count: 1 });
    // 20/10, one cycle: every boundary gets a countdown, including the last
    // one, which leads into "done" rather than another phase -- prep->work,
    // work->rest, rest->done. Three windows, three ticks each.
    strictEqual(freqs(beeps, 660).length, 9);
});

Deno.test("E2MOM is Intervals(120, 0): the collapse holds at a different work length", async () => {
    const { beeps } = await run({ intervalsPreset: "e2mom", count: 2 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    deepStrictEqual(starts, [10_000, 130_000]);
    // prep->work1, work1->work2 (rest = 0, so no rest phase), work2->done.
    strictEqual(freqs(beeps, 660).length, 9);
});

Deno.test("typing work and rest directly drives the clock, no preset needed", async () => {
    // 8/8 rather than 5/5: both divide the test's 16 ms step evenly, so the
    // transitions land on exact simulated milliseconds instead of a few
    // milliseconds late -- a step-size artifact, not a claim about derive().
    const { beeps } = await run({ workSecs: 8, restSecs: 8, count: 2 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    // Work and rest both cue: two cycles of work+rest is four entries.
    deepStrictEqual(starts, [10_000, 18_000, 26_000, 34_000]);
});

Deno.test("every Intervals preset seeds its canonical work, rest and cycle count", async () => {
    // Durations read MM:SS in the fields; the presets themselves stay seconds.
    const canonical = {
        emom: { count: "10", workSecs: "1:00", restSecs: "0:00" },
        e2mom: { count: "6", workSecs: "2:00", restSecs: "0:00" },
        tabata: { count: "8", workSecs: "0:20", restSecs: "0:10" },
    };
    for (const [preset, want] of Object.entries(canonical)) {
        const { seeded } = await run({ intervalsPreset: preset, count: 1, stopAt: 0 });
        deepStrictEqual(seeded, want, preset);
    }
});

Deno.test("work and rest are never hidden: Intervals shows them without a preset", async () => {
    const { els } = await run({ count: 1, stopAt: 0 });
    strictEqual(els["interval-fields"].hidden, false);
});

Deno.test("AMRAP and RFT dim and disable work/rest rather than removing them", async () => {
    // Dimmed in place, not hidden: main centres the form, so removing the
    // fields would shrink it and drag everything above them down too.
    for (const strategy of ["amrap", "rft"]) {
        const { els } = await run({ strategy, count: 1, stopAt: 0 });
        strictEqual(els["interval-fields"].hidden, false, strategy);
        strictEqual(els["interval-fields"].className, "inactive", strategy);
        strictEqual(els["work-secs"].disabled, true, strategy);
        strictEqual(els["rest-secs"].disabled, true, strategy);
        strictEqual(els["intervals-presets"].hidden, true, strategy);
    }
    const { els } = await run({ count: 1, stopAt: 0 });
    strictEqual(els["interval-fields"].className, "");
    strictEqual(els["work-secs"].disabled, false);
    strictEqual(els["rest-secs"].disabled, false);
    strictEqual(els["intervals-presets"].hidden, false);
    strictEqual(els["amrap-presets"].hidden, true);
    strictEqual(els["rft-presets"].hidden, true);
});

Deno.test("every strategy's finish reads the same phase label", async () => {
    // The huge slot differs by strategy because the results genuinely differ:
    // a glyph where there is no number, elapsed time for RFT. The label under
    // it is not a second glyph slot, and RFT alone once filled it with a flag.
    const runs = {
        intervals: await run({ count: 1 }),
        amrap: await run({ strategy: "amrap", count: 60 }),
        rft: await run({ strategy: "rft", count: 1, tapAt: [PREP_MS + 2_000] }),
    };
    for (const [name, r] of Object.entries(runs)) {
        strictEqual(r.els.phase.textContent, "Done", `${name} finish label`);
    }
});

Deno.test("a duration field takes MM:SS or bare seconds, and normalises on blur", async () => {
    // 90 and 1:30 are the same duration typed two ways, which is what lets a
    // numeric keypad with no colon on it still reach every value.
    for (const [typed, shown] of [["90", "1:30"], ["1:30", "1:30"], ["12", "0:12"], ["2:05", "2:05"]]) {
        const { els } = await run({ workSecsText: typed, count: 1, stopAt: 0 });
        strictEqual(els["work-secs"].value, shown, `typed ${typed}`);
    }
});

Deno.test("a typed duration is the one the clock actually runs", async () => {
    // Not just how it reads back: one cycle of work typed as "1:30" has to end
    // 90 s after prep, or the parse is decorative.
    const { doneAt } = await run({ workSecsText: "1:30", restSecs: 0, count: 1 });
    ok(
        doneAt >= PREP_MS + 90_000 && doneAt < PREP_MS + 90_000 + STEP,
        `finished at ${doneAt}, expected ${PREP_MS + 90_000}`,
    );
});

Deno.test("a duration that cannot be read leaves the field alone and refuses to start", async () => {
    for (const bad of ["", "abc", "1:75", "1:2:3", "-5"]) {
        const { els } = await run({ workSecsText: bad, count: 1, stopAt: 0 });
        // Untouched rather than silently corrected to something never asked for.
        strictEqual(els["work-secs"].value, bad, `typed ${bad}`);
        // And the workout never starts. Asserted on the setup screen rather
        // than the timer one: every fake element defaults to hidden = false,
        // so "timer is not hidden" is the harness's initial state and would
        // pass whether the app started or not. Hiding setup is something only
        // a successful start does.
        strictEqual(els.setup.hidden, false, `typed ${bad}`);
    }
});

Deno.test("the count field is relabelled per strategy", async () => {
    const { els: intervals } = await run({ count: 1, stopAt: 0 });
    strictEqual(intervals["count-label"].textContent, "🔁 Cycles");

    const { els: amrap } = await run({ strategy: "amrap", count: 60, stopAt: 0 });
    strictEqual(amrap["count-label"].textContent, "⏳ Window");

    const { els: rft } = await run({ strategy: "rft", count: 1, stopAt: 0 });
    strictEqual(rft["count-label"].textContent, "🎯 Rounds");
});

/* ---------- AMRAP ---------- */

Deno.test("AMRAP counts down a fixed window and reports the window", async () => {
    // Deliberately not a whole number of minutes. This label used to divide by
    // 60000 and print minutes, which a 60-second window hid perfectly -- 1
    // minute is what both the right answer and the wrong one produce.
    const { els } = await run({ strategy: "amrap", count: 20 });
    strictEqual(els.phase.textContent, "Done");
    // The window, not a round count: AMRAP scores nothing, so it restates what
    // the clock delivered, the way Intervals restates its cycles.
    strictEqual(els["round-label"].textContent, "0:20");
    // Same finish glyph as Intervals: neither has a number to show here.
    strictEqual(els.seconds.textContent, "💪");
});

Deno.test("the AMRAP window reads MM:SS whatever it was set to", async () => {
    for (const [secs, shown] of [[20, "0:20"], [60, "1:00"], [90, "1:30"], [12 * 60, "12:00"]]) {
        const { els } = await run({ strategy: "amrap", count: secs });
        strictEqual(els["round-label"].textContent, shown, `${secs}s window`);
    }
});

Deno.test("AMRAP never makes the countdown tappable, in any phase", async () => {
    for (const [label, stopAt] of [["prep", 5_000], ["work", PREP_MS + 5_000], ["done", null]]) {
        const { els } = await run({ strategy: "amrap", count: 60, stopAt });
        strictEqual(els.seconds.disabled, true, `amrap ${label}`);
        strictEqual(els["tap-hint"].hidden, true, `amrap ${label} hint`);
    }
});

Deno.test("tapping an AMRAP countdown records nothing", async () => {
    // Nothing should reach recordTap now that the button is inert, but the
    // handler is still attached to it, so assert the guard directly rather
    // than trusting that no path ever fires it.
    const { els, tap } = await run({ strategy: "amrap", count: 60, stopAt: PREP_MS + 5_000 });
    tap();
    tap();
    strictEqual(els["round-label"].textContent, "\u00a0");
});

Deno.test("the 15-minute AMRAP preset fills the window, not a round count", async () => {
    const { seeded } = await run({ strategy: "amrap", amrapPreset: 15, count: 60, stopAt: 0 });
    // The field reads MM:SS now, and the preset's attribute is still minutes.
    strictEqual(seeded.count, "15:00");
});

Deno.test("the AMRAP window runs exactly as long as it was set", async () => {
    // Each tier bounded this from one side only. The browser tier fast-forwards
    // to the nominal end and asserts Done, so it catches a window that runs
    // long but not one that finishes early; nothing here pinned the finish at
    // all, so a window running long passed the whole tier. Pinning the instant
    // closes both directions in one place.
    for (const minutes of [1, 2]) {
        const { doneAt } = await run({ strategy: "amrap", count: minutes * 60 });
        const expected = PREP_MS + minutes * 60_000;
        // The loop only looks between frames, so the first frame to report Done
        // is the first one at or after the true end -- never earlier, and never
        // a whole frame late.
        ok(
            doneAt >= expected && doneAt < expected + STEP,
            `${minutes}-minute window finished at ${doneAt}, expected ${expected}`,
        );
    }
});

Deno.test("AMRAP cues the start and the finish, never an intermediate boundary", async () => {
    const { beeps } = await run({ strategy: "amrap", count: 60 });
    // One "go" at prep's end, then nothing until the fanfare.
    strictEqual(freqs(beeps, 880).length, 1);
    deepStrictEqual(
        beeps.filter((b) => [523, 659, 784].includes(b.freq)).map((b) => b.freq),
        [523, 659, 784],
    );
});

Deno.test("AMRAP ticks the last three seconds of the window", async () => {
    const { beeps } = await run({ strategy: "amrap", count: 60 });
    // Prep's countdown, plus the window's own final three seconds.
    strictEqual(freqs(beeps, 660).length, 6);
});

Deno.test("AMRAP shows no progress label while it runs, having nothing to count", async () => {
    const { els } = await run({ strategy: "amrap", count: 300, stopAt: PREP_MS + 6_000 });
    // The blank is prep's reserved line kept in place, not an empty string:
    // collapsible whitespace would lay the paragraph out at zero height and
    // jog the centred group. See the U+00A0 in render().
    strictEqual(els["round-label"].textContent, "\u00a0");
});

/* ---------- RFT ---------- */

Deno.test("RFT counts up and ends on the target tap, not on elapsed time", async () => {
    const { els, lapRows } = await run({
        strategy: "rft",
        count: 3,
        // Offsets land on 16 ms frame boundaries so the durations below are
        // exact: a tap scheduled between frames is taken on the next one, and
        // formatClock floors, which turns a 6,992 ms round into "0:06".
        tapAt: [PREP_MS + 5_008, PREP_MS + 12_016, PREP_MS + 20_016],
    });
    strictEqual(els.phase.textContent, "Done");
    // The total rides on the label, the finish glyph sits above the table.
    strictEqual(els["round-label"].textContent, "3 rounds \u00b7 0:20");
    strictEqual(els.seconds.textContent, "💪");
    strictEqual(els.seconds.className, "done");
    strictEqual(els.laps.hidden, false);
    // Durations, not the running total: 5s, then 12-5, then 20-12.
    deepStrictEqual(lapRows(), [["1", "0:05"], ["2", "0:07"], ["3", "0:08"]]);
});

Deno.test("only RFT's finish shows the table, and the glyph is one size everywhere", async () => {
    const rft = await run({ strategy: "rft", count: 1, tapAt: [PREP_MS + 2_000] });
    strictEqual(rft.els.laps.hidden, false);
    strictEqual(rft.els.seconds.className, "done");

    // The other two have nothing to list, and are otherwise the same screen.
    for (const strategy of ["intervals", "amrap"]) {
        const other = await run({ strategy, count: strategy === "amrap" ? 60 : 1 });
        strictEqual(other.els.laps.hidden, true, strategy);
        strictEqual(other.els.seconds.className, "done", strategy);
    }
});

Deno.test("each RFT tap restarts the round clock without disturbing the total", async () => {
    // Mid-round, after a tap that landed 4.992 s in: the digits show this round
    // alone while the label keeps the total the workout is scored on.
    const { els } = await run({
        strategy: "rft",
        count: 3,
        tapAt: [PREP_MS + 4_992], // on a frame boundary, as above
        stopAt: PREP_MS + 8_000,
    });
    // 0:04, not the 0:03 a stopwatch started at the tap would read: round
    // lengths are differences of whole seconds, so the 8 ms the tap fell short
    // of the fifth second go to this round rather than being dropped. See
    // wholeSecs -- the alternative ticks the two clocks out of step and loses
    // up to a second per round off the finish screen's column.
    strictEqual(els.seconds.textContent, "0:04");
    strictEqual(els["round-label"].textContent, "Round 2 \u00b7 0:08");
});

Deno.test("both clocks turn over on the same second", async () => {
    // The complaint that started this: the label read 0:12 beside digits
    // reading 0:09, then they changed a fraction of a second apart. Sampled
    // either side of a whole second, with a tap deliberately off one.
    const before = await run({
        strategy: "rft", count: 3,
        tapAt: [PREP_MS + 2_496], stopAt: PREP_MS + 6_992,
    });
    const after = await run({
        strategy: "rft", count: 3,
        tapAt: [PREP_MS + 2_496], stopAt: PREP_MS + 7_008,
    });
    // Total crosses 6 -> 7, and the round's clock advances on the same frame.
    strictEqual(before.els["round-label"].textContent, "Round 2 \u00b7 0:06");
    strictEqual(before.els.seconds.textContent, "0:04");
    strictEqual(after.els["round-label"].textContent, "Round 2 \u00b7 0:07");
    strictEqual(after.els.seconds.textContent, "0:05");
});

Deno.test("the round times on the finish screen add up to the total above them", async () => {
    // They did not: three rounds ending on fractions of a second each lost
    // their remainder to a separate floor, so the column came up short.
    const { els, lapRows } = await run({
        strategy: "rft", count: 3,
        tapAt: [PREP_MS + 1_904, PREP_MS + 3_808, PREP_MS + 5_712],
    });
    const toSecs = (mmss) => {
        const [m, s] = mmss.split(":").map(Number);
        return m * 60 + s;
    };
    const sum = lapRows().reduce((n, [, time]) => n + toSecs(time), 0);
    const total = toSecs(els["round-label"].textContent.split("\u00b7")[1].trim());
    strictEqual(sum, total, `laps ${JSON.stringify(lapRows())} under ${els["round-label"].textContent}`);
});

Deno.test("the 10-round RFT preset fills the target, not a duration", async () => {
    const { seeded } = await run({ strategy: "rft", rftPreset: 10, count: 1, stopAt: 0 });
    strictEqual(seeded.count, "10");
});

Deno.test("RFT never fires the 3-2-1 tick cue", async () => {
    const { beeps } = await run({
        strategy: "rft",
        count: 1,
        tapAt: [10_000 + 3_000],
    });
    // Only the prep countdown counts down to anything; nothing counts down
    // within RFT itself, since it has no bound to count down to.
    strictEqual(freqs(beeps, 660).length, 3);
});

Deno.test("a tap while paused does not count", async () => {
    const { els, tap } = await run({ strategy: "rft", count: 5, stopAt: PREP_MS + 5_000 });
    els.pause.fire("click");
    tap();
    tap();
    els.pause.fire("click");
    ok(els["round-label"].textContent.startsWith("Round 1 "), els["round-label"].textContent);
});

Deno.test("a tap during prep does not bank a round", async () => {
    // The tap target is the whole countdown, on screen through prep too, and
    // an eager finger there used to bank a round that appeared the instant the
    // work phase opened.
    const { els } = await run({ strategy: "rft", count: 3, tapAt: [5_000], stopAt: PREP_MS + 2_000 });
    strictEqual(els["round-label"].textContent, "Round 1 \u00b7 0:02");
});

Deno.test("the tap target is live only while a round can be recorded", async () => {
    const prep = await run({ strategy: "rft", count: 3, stopAt: 5_000 });
    strictEqual(prep.els.seconds.disabled, true);

    const work = await run({ strategy: "rft", count: 3, stopAt: PREP_MS + 5_000 });
    strictEqual(work.els.seconds.disabled, false);

    const done = await run({ strategy: "rft", count: 1, tapAt: [PREP_MS + 2_000] });
    strictEqual(done.els.seconds.disabled, true);
});

Deno.test("only RFT carries the tap hint, and only once tapping does something", async () => {
    // Reserved, not removed, during prep: see #tap-hint.reserved.
    const prep = await run({ strategy: "rft", count: 3, stopAt: 5_000 });
    strictEqual(prep.els["tap-hint"].hidden, false);
    strictEqual(prep.els["tap-hint"].className, "reserved");

    const work = await run({ strategy: "rft", count: 3, stopAt: PREP_MS + 5_000 });
    strictEqual(work.els["tap-hint"].className, "");

    // The other two record nothing, so the line leaves the layout entirely.
    for (const strategy of ["intervals", "amrap"]) {
        const other = await run({ strategy, count: strategy === "amrap" ? 300 : 5, stopAt: PREP_MS + 5_000 });
        strictEqual(other.els["tap-hint"].hidden, true, strategy);
    }
});

Deno.test("RFT's live display is a clock, counting up past a minute", async () => {
    const { els } = await run({
        strategy: "rft",
        count: 5,
        stopAt: 10_000 + 65_000,
    });
    strictEqual(els.seconds.textContent, "1:05");
});

Deno.test("RFT does not finish just because time passed", async () => {
    const { els } = await run({
        strategy: "rft",
        count: 3,
        tapAt: [10_000 + 5_000], // only one of the three taps needed
        stopAt: 10_000 + 120_000,
    });
    strictEqual(els.phase.textContent, "Work");
    ok(els["round-label"].textContent.startsWith("Round 2 "), els["round-label"].textContent);
});

/* ---------- Persistence ---------- */

Deno.test("strategy, cycles and custom work/rest are restored from storage", async () => {
    const stored = { strategy: "intervals", cycles: 7, workSecs: 33, restSecs: 11 };
    const { initial } = await run({ stored, stopAt: 0 });
    strictEqual(initial.strategy, "intervals");
    strictEqual(initial.count, "7");
    // Stored as seconds, shown as MM:SS.
    strictEqual(initial.workSecs, "0:33");
    strictEqual(initial.restSecs, "0:11");
});

Deno.test("each strategy remembers its own count independently", async () => {
    const stored = { strategy: "rft", cycles: 9, amrapMinutes: 17, rftRounds: 4 };
    const { initial } = await run({ strategy: "rft", stored, stopAt: 0 });
    // Restored as RFT (4 rounds), not Intervals' 9 cycles or AMRAP's 17 minutes
    // -- switching strategy later would read each of those back independently.
    strictEqual(initial.strategy, "rft");
    strictEqual(initial.count, "4");
});

Deno.test("switching strategy loads that strategy's own stored count, not the last one shown", async () => {
    const stored = { strategy: "intervals", cycles: 9, amrapWindowSecs: 17 * 60 };
    // seeded, not els.count.value: run() always types its own count (1) into
    // the field afterward, same as a user editing post-switch would. What is
    // under test is what the switch itself loaded, before that edit lands.
    const { seeded } = await run({ stored, strategy: "amrap", count: 60, stopAt: 0 });
    strictEqual(seeded.count, "17:00");
});

Deno.test("an unknown stored strategy falls back to Intervals", async () => {
    const { initial } = await run({ stored: { strategy: "nonsense" }, stopAt: 0 });
    strictEqual(initial.strategy, "intervals");
});

Deno.test("an unusable stored count falls back to the strategy's default", async () => {
    for (const bad of [500, 0, -3, 1.5, "abc", null]) {
        const { initial } = await run({ stored: { strategy: "intervals", cycles: bad }, stopAt: 0 });
        strictEqual(initial.count, "10", `cycles: ${JSON.stringify(bad)}`);
    }
});

Deno.test("typing a count persists it under the active strategy's own key", async () => {
    const { store } = await run({ strategy: "rft", count: 4, pick: "sound" });
    const saved = JSON.parse(store.get("emom"));
    strictEqual(saved.strategy, "rft");
    strictEqual(saved.rftRounds, 4);
    strictEqual(saved.sound, true);
    strictEqual(saved.buzz, false);
});

/* ---------- Cues on/off, unrelated to strategy ---------- */

Deno.test("both cues are on by default", async () => {
    const { els } = await run({ count: 1 });
    strictEqual(els["cue-sound"].checked, true);
    strictEqual(els["cue-buzz"].checked, true);
    strictEqual(els["cue-buzz"].disabled, false);
});

Deno.test("without a Vibration API the buzz box is off and disabled", async () => {
    const { els, buzzes, beeps } = await run({
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
        const { els } = await run({ count: 1, stored: want });
        strictEqual(els["cue-sound"].checked, want.sound, `${mode} sound`);
        strictEqual(els["cue-buzz"].checked, want.buzz, `${mode} buzz`);
    }
});

/* ---------- Build id in the footer ---------- */

Deno.test("shows the build id in the footer when there is one", async () => {
    const { els } = await run({ count: 1, build: "4094c69" });
    strictEqual(els.build.textContent, "4094c69");
    strictEqual(els.build.href, "https://github.com/nothub/gym-timer/commit/4094c69");
});

Deno.test("leaves the footer fallback alone for an unbuilt copy", async () => {
    // The markup already says "dev" pointing at the commit list; overwriting it
    // with the literal placeholder would be worse than leaving it.
    const { els } = await run({ count: 1, build: "dev" });
    strictEqual(els.build.textContent, "");
    strictEqual(els.build.href, undefined);
});

/* ---------- Screen wake lock and the paused pulse ---------- */

Deno.test("holds the screen awake for the workout and releases it at the end", async () => {
    const { wakeLog } = await run({ count: 1 });
    deepStrictEqual(wakeLog, ["acquire", "release"]);
});

Deno.test("does not release a sentinel the browser already dropped", async () => {
    const mid = await run({ count: 5, stopAt: 40_000 });
    strictEqual(mid.wakeLog.filter((x) => x === "release").length, 0);

    await mid.browserDropsLock();
    mid.els.reset.fire("click"); // back to setup, which releases the screen

    // A released sentinel cannot be reused, so calling release on it again is
    // working on a dead object. The app should have let go of the reference.
    strictEqual(mid.wakeLog.filter((x) => x === "release").length, 0);
});

Deno.test("freezes the pulse while paused", async () => {
    const mid = await run({ count: 5, stopAt: 40_000 });
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
    const mid = await run({ count: 5, stopAt: 40_000 });
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
