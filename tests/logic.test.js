// Fast tier: runs the app's real <script> against a fake DOM, clock, storage and
// navigator. No browser, no network, no dependencies -- `deno test --allow-read`.
//
// This tier owns the parts that are pure logic: when cues fire, where the minute
// boundaries land, which preference wins. Anything that needs a real rendering
// engine lives in browser.spec.js instead.

import { deepStrictEqual, strictEqual, ok } from "node:assert";

const ROOT = new URL("../", import.meta.url);
const src = Deno.readTextFileSync(new URL("index.html", ROOT));
const code = src.match(/<script>([\s\S]*?)<\/script>/)[1];

// Slider order, mirroring CUE_MODES in the app.
const CUE_MODES = ["sound", "both", "vibrate", "off"];
const STEP = 16; // ~60fps, matching requestAnimationFrame

/**
 * Load the app into a synthetic environment and run a whole workout.
 * Returns everything the app tried to do to the outside world.
 */
async function run({
    vibrate = true,
    search = "",
    stored = null,
    pick = null,
    rounds = 3,
    stopAt = null,
} = {}) {
    let now = 0;
    const beeps = [];
    const buzzes = [];
    const urls = [];
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
            "pause", "reset", "live", "cues", "cue-scale",
        ]
    ) {
        els[id] = makeEl(id);
    }

    // The label above each slider stop. The app highlights one and removes the
    // ones this device cannot offer, so both have to be modelled.
    let cueSpans = CUE_MODES.map((mode) => {
        const span = { dataset: { mode }, on: false };
        span.classList = {
            toggle(name, force) {
                if (name === "on") span.on = force;
            },
        };
        span.remove = () => {
            cueSpans = cueSpans.filter((s) => s !== span);
        };
        return span;
    });

    els["cue-scale"].querySelectorAll = (sel) => {
        const wanted = [...sel.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1]);
        return cueSpans.filter((s) => wanted.includes(s.dataset.mode));
    };
    Object.defineProperty(els["cue-scale"], "children", { get: () => cueSpans });

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
        location: { search },
        history: { replaceState: (_state, _title, url) => urls.push(url) },
        URLSearchParams,
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
        // Drag the slider to the stop that names this mode, as a user would.
        const modes = vibrate ? CUE_MODES : CUE_MODES.filter((m) => m === "sound" || m === "off");
        els.cues.value = String(modes.indexOf(pick));
        els.cues.fire("input");
    }

    els.rounds.valueAsNumber = rounds;
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

    const litLabel = () => cueSpans.find((s) => s.on)?.dataset.mode ?? null;
    const labels = () => cueSpans.map((s) => s.dataset.mode);

    return {
        els, initialRounds, beeps, buzzes, urls, flashes, store, wakeLog,
        setVisibility, litLabel, labels,
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

Deno.test("the slider offers four labelled stops when the device can buzz", async () => {
    const { els, labels, litLabel } = await run({ rounds: 1 });
    strictEqual(els.cues.max, "3");
    deepStrictEqual(labels(), ["sound", "both", "vibrate", "off"]);
    strictEqual(litLabel(), "both");
});

Deno.test("without a Vibration API the slider shortens and a stored mode degrades", async () => {
    const { els, labels, litLabel, buzzes, beeps } = await run({
        rounds: 1,
        vibrate: false,
        stored: { cues: "both" },
    });
    // Sound and Silent only: two dead stops are worse than a shorter slider.
    strictEqual(els.cues.max, "1");
    deepStrictEqual(labels(), ["sound", "off"]);
    // "both" would be silent on a device that cannot buzz, so it falls back.
    strictEqual(litLabel(), "sound");
    deepStrictEqual(buzzes, []);
    ok(beeps.length > 0);
});

Deno.test("exactly one label is lit, and the slider names it for a screen reader", async () => {
    for (const [mode, label] of Object.entries({
        sound: "Sound",
        both: "Sound + buzz",
        vibrate: "Buzz",
        off: "Silent",
    })) {
        const { els, litLabel } = await run({ rounds: 1, pick: mode });
        strictEqual(litLabel(), mode);
        strictEqual(els.cues.getAttribute("aria-valuetext"), label);
    }
});

Deno.test("round count: url beats storage beats default", async () => {
    const url = await run({ search: "?rounds=7", stored: { rounds: 22 }, rounds: 1 });
    strictEqual(url.initialRounds, "7");

    const storage = await run({ stored: { rounds: 22 }, rounds: 1 });
    strictEqual(storage.initialRounds, "22");

    const fallback = await run({ rounds: 1 });
    strictEqual(fallback.initialRounds, "10");
});

Deno.test("unusable round counts in the url are ignored", async () => {
    const tooBig = await run({ search: "?rounds=500", stored: { rounds: 22 }, rounds: 1 });
    strictEqual(tooBig.initialRounds, "22");

    const garbage = await run({ search: "?rounds=abc", rounds: 1 });
    strictEqual(garbage.initialRounds, "10");
});

Deno.test("writes the round count to the url and the cue mode to storage", async () => {
    const { urls, store } = await run({ rounds: 4, pick: "sound" });
    strictEqual(urls[0], "?rounds=10");
    deepStrictEqual(JSON.parse(store.get("emom")), { cues: "sound", rounds: 4 });
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
