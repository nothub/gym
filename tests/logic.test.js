// Fast tier: runs the app's real <script> against a fake DOM, clock, storage and
// navigator. No browser, no network, no dependencies -- `deno test --allow-read`.
//
// This tier owns the parts that are pure logic: when cues fire, where the minute
// boundaries land, which preference wins. Anything that needs a real rendering
// engine lives in browser.spec.js instead.

import { deepStrictEqual, strictEqual, ok } from "node:assert";

// The build output, not the source: the tests assert on what ships.
const ROOT = new URL("../dist/", import.meta.url);
const src = Deno.readTextFileSync(new URL("index.html", ROOT));
const code = src.match(/<script>([\s\S]*?)<\/script>/)[1];

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
 * Load the app into a synthetic environment and run a whole workout.
 * Returns everything the app tried to do to the outside world.
 */
async function run({
    vibrate = true,
    stored = null,
    pick = null,
    rounds = 3,
    stopAt = null,
    build = "dev",
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
        max: "",
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
        // value and valueAsNumber are two views of one field, as in the DOM.
        get value() {
            return this._value;
        },
        set value(v) {
            this._value = String(v);
        },
        get valueAsNumber() {
            return this._value === "" ? NaN : Number(this._value);
        },
        set valueAsNumber(n) {
            this._value = String(n);
        },
        get className() {
            return this._cls;
        },
        set className(v) {
            this._cls = v;
        },
    });

    const els = {};
    for (
        const id of [
            "setup", "rounds", "timer", "phase", "seconds", "round-label",
            "pause", "reset", "live", "cues", "cue-sound", "cue-buzz", "build",
        ]
    ) {
        els[id] = makeEl(id);
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
        body: {
            offsetWidth: 0,
            classList: {
                add: (c) => {
                    bodyClasses.add(c);
                    if (c === "flash") flashes.push(now);
                },
                remove: (c) => bodyClasses.delete(c),
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

    const navigator = {
        wakeLock: {
            request: async () => {
                wakeLog.push("acquire");
                return { release: () => wakeLog.push("release") };
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
            AudioContext: FakeAudioContext,
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
    // value and valueAsNumber are one field, exactly as in the DOM.
    const initialRounds = els.rounds.value;

    if (pick) {
        els["cue-sound"].checked = CUE_STATES[pick].sound;
        els["cue-buzz"].checked = CUE_STATES[pick].buzz;
        els.cues.fire("change");
    }

    els.rounds.valueAsNumber = rounds;
    els.rounds.fire("input"); // typing is what persists the round count
    els.setup.fire("submit");
    await Promise.resolve(); // let the wake-lock request settle

    const end = stopAt ?? 10_000 + rounds * 60_000 + 500;
    while (now < end) {
        now += STEP;
        frames.splice(0).forEach((fn) => fn());
        timeouts
            .filter((t) => t.at <= now && !t.done)
            .forEach((t) => {
                t.done = true;
                t.fn();
            });
    }

    const setVisibility = async (state) => {
        document.visibilityState = state;
        document.fire("visibilitychange");
        await Promise.resolve();
    };

    return {
        els, initialRounds, beeps, buzzes, flashes, store, wakeLog, setVisibility,
    };
}

const freqs = (beeps, hz) => beeps.filter((b) => b.freq === hz);

Deno.test("counts down three ticks before every minute, prep included", async () => {
    const { beeps } = await run({ rounds: 3 });
    // Four countdowns: the prep, then one leading into each of rounds 2, 3 and the end.
    strictEqual(freqs(beeps, 660).length, 12);
});

Deno.test("marks the top of every minute exactly once", async () => {
    const { beeps } = await run({ rounds: 3 });
    strictEqual(freqs(beeps, 880).length, 3);
});

Deno.test("round boundaries do not drift", async () => {
    const { beeps } = await run({ rounds: 5 });
    const starts = freqs(beeps, 880).map((b) => b.t);
    // 10 s of prep, then one round per minute, to the millisecond.
    deepStrictEqual(starts, [10_000, 70_000, 130_000, 190_000, 250_000]);
});

Deno.test("never fires the same tick twice inside one second", async () => {
    const { beeps } = await run({ rounds: 3 });
    const ticks = freqs(beeps, 660);
    const tooClose = ticks.filter((b, i) => i > 0 && b.t - ticks[i - 1].t < 900);
    deepStrictEqual(tooClose, []);
});

Deno.test("ends on an ascending fanfare and settles the screen", async () => {
    const { beeps, els } = await run({ rounds: 3 });
    deepStrictEqual(
        beeps.filter((b) => [523, 659, 784].includes(b.freq)).map((b) => b.freq),
        [523, 659, 784],
    );
    strictEqual(els.seconds.textContent, "✓");
    strictEqual(els["round-label"].textContent, "3 rounds");
    strictEqual(els.pause.hidden, true);
    strictEqual(els.reset.textContent, "Again");
});

Deno.test("silent mode drops sound and buzz but keeps the flash", async () => {
    const { beeps, buzzes, flashes } = await run({ rounds: 2, pick: "off" });
    deepStrictEqual(beeps, []);
    deepStrictEqual(buzzes, []);
    // One per round start, one for the finish.
    strictEqual(flashes.length, 3);
});

Deno.test("sound and buzz modes are independent", async () => {
    const sound = await run({ rounds: 2, pick: "sound" });
    ok(sound.beeps.length > 0);
    deepStrictEqual(sound.buzzes, []);

    const buzz = await run({ rounds: 2, pick: "vibrate" });
    deepStrictEqual(buzz.beeps, []);
    ok(buzz.buzzes.length > 0);
});

Deno.test("shows the build id in the footer when there is one", async () => {
    const { els } = await run({ rounds: 1, build: "4094c69" });
    strictEqual(els.build.textContent, "4094c69");
    strictEqual(els.build.href, "https://github.com/nothub/gym/commit/4094c69");
});

Deno.test("leaves the footer fallback alone for an unbuilt copy", async () => {
    // The markup already says "dev" pointing at the commit list; overwriting it
    // with the literal placeholder would be worse than leaving it.
    const { els } = await run({ rounds: 1, build: "dev" });
    strictEqual(els.build.textContent, "");
    strictEqual(els.build.href, undefined);
});

Deno.test("both cues are on by default", async () => {
    const { els } = await run({ rounds: 1 });
    strictEqual(els["cue-sound"].checked, true);
    strictEqual(els["cue-buzz"].checked, true);
    strictEqual(els["cue-buzz"].disabled, false);
});

Deno.test("without a Vibration API the buzz box is off and disabled", async () => {
    const { els, buzzes, beeps } = await run({
        rounds: 1,
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
        const { els } = await run({ rounds: 1, stored: want });
        strictEqual(els["cue-sound"].checked, want.sound, `${mode} sound`);
        strictEqual(els["cue-buzz"].checked, want.buzz, `${mode} buzz`);
    }
});

Deno.test("round count is restored from storage, or falls back to ten", async () => {
    const storage = await run({ stored: { rounds: 22 }, rounds: 1 });
    strictEqual(storage.initialRounds, "22");

    const fallback = await run({ rounds: 1 });
    strictEqual(fallback.initialRounds, "10");
});

Deno.test("unusable stored round counts are ignored", async () => {
    for (const bad of [500, 0, -3, 1.5, "abc", null]) {
        const { initialRounds } = await run({ stored: { rounds: bad }, rounds: 1 });
        strictEqual(initialRounds, "10", `rounds: ${JSON.stringify(bad)}`);
    }
});

Deno.test("round count and cue choices share one storage entry", async () => {
    const { store } = await run({ rounds: 4, pick: "sound" });
    deepStrictEqual(JSON.parse(store.get("emom")), { sound: true, buzz: false, rounds: 4 });
});

Deno.test("holds the screen awake for the workout and releases it at the end", async () => {
    const { wakeLog } = await run({ rounds: 1 });
    deepStrictEqual(wakeLog, ["acquire", "release"]);
});

Deno.test("re-acquires the screen lock the browser dropped while backgrounded", async () => {
    const mid = await run({ rounds: 5, stopAt: 40_000 });
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
