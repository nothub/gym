// Browser tier: only the things a fake DOM cannot prove.
//
// Timing, cue schedules and preference precedence are covered far more cheaply
// in logic.test.js. What lives here needs a real rendering engine: layout
// geometry, service worker registration, manifest parsing, and the fact that
// the requestAnimationFrame loop actually runs.

import { expect, test } from "@playwright/test";

const start = (page) => page.getByRole("button", { name: "Start" }).click();
const strategy = (page, value) => page.locator(`input[name="strategy"][value="${value}"]`).check();
const intervalsPreset = (page, key) => page.locator(`#intervals-presets button[data-intervals-preset="${key}"]`).click();
const amrapPreset = (page, mins) => page.locator(`#amrap-presets button[data-amrap-preset="${mins}"]`).click();
const rftPreset = (page, rounds) => page.locator(`#rft-presets button[data-rft-preset="${rounds}"]`).click();

test("the background vignette never gets bright enough to erode --dim's contrast", async ({ page }) => {
    await page.goto("/");

    // --dim was tuned to just clear 4.5:1 against the flat --bg it once was.
    // A background that brightens anywhere -- a glow behind the header, say
    // -- silently pulls that below AA wherever --dim text lands on it. This
    // reads the real computed styles rather than trusting the source: it
    // would have caught the first version of this vignette, which brightened
    // toward the centre and measured 4.08:1 there.
    const ratios = await page.evaluate(() => {
        // A custom property's computed value is its raw authored text ("#7c7c7c"),
        // not the normalized "rgb(...)" real CSS properties serialize to -- so
        // it, and any of the gradient's colour keyword or hex stops, need the
        // browser's own colour parser rather than a hand-rolled one. Letting a
        // 1x1 canvas resolve the fillStyle does that for any valid CSS colour.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        const toRgb = (cssColor) => {
            ctx.fillStyle = cssColor;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };

        const toLin = (c) => {
            c /= 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
        const contrast = (aRgb, bRgb) => {
            const a = luminance(aRgb), b = luminance(bRgb);
            const [hi, lo] = a > b ? [a, b] : [b, a];
            return (hi + 0.05) / (lo + 0.05);
        };

        const dim = toRgb(getComputedStyle(document.documentElement).getPropertyValue("--dim"));
        const stops = [...getComputedStyle(document.body).backgroundImage.matchAll(/rgb\([^)]+\)/g)]
            .map((m) => toRgb(m[0]));
        return stops.map((stop) => contrast(dim, stop));
    });

    expect(ratios.length).toBeGreaterThan(0);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
});

test("centres the setup form instead of sizing it to its contents", async ({ page }) => {
    await page.goto("/");

    const form = await page.locator("#setup").boundingBox();
    const width = page.viewportSize().width;

    expect(Math.abs(form.x + form.width / 2 - width / 2)).toBeLessThan(2);
    // max-width is 20rem. A shrink-to-fit parent used to let this take its
    // width from the fieldset's contents instead.
    expect(form.width).toBeLessThanOrEqual(320);
});

test("centres the cue checkboxes across the form", async ({ page }) => {
    await page.goto("/");

    const form = await page.locator("#setup").boundingBox();
    const labels = page.locator("#cues label");
    const first = await labels.first().boundingBox();
    const last = await labels.last().boundingBox();

    // The fieldset stretches to the form's width, so this measures where its
    // contents sit inside it rather than where the box is.
    const contentCentre = (first.x + last.x + last.width) / 2;
    expect(Math.abs(contentCentre - (form.x + form.width / 2))).toBeLessThan(2);
});

test("the strategy row and every preset row centre on the form, like everything else", async ({ page }) => {
    await page.goto("/");

    // #strategies is a block-level <fieldset>: it already spans the form's
    // full width regardless of how its own children are laid out, so its own
    // bounding box cannot tell centred chips from chips packed to one side.
    // The union of the chips themselves is the thing that actually moves.
    const form = await page.locator("#setup").boundingBox();
    const formCentre = form.x + form.width / 2;

    for (const sel of ["#strategies label", "#intervals-presets button"]) {
        const chips = page.locator(sel);
        const first = await chips.first().boundingBox();
        const last = await chips.last().boundingBox();
        const contentCentre = (first.x + last.x + last.width) / 2;
        expect(Math.abs(contentCentre - formCentre)).toBeLessThan(2);
    }
});

test("every strategy chip's label text is centred in its own chip", async ({ page }) => {
    await page.goto("/");

    // #strategies is a <fieldset>, and a generic "fieldset label { display:
    // flex }" rule exists for #cues' checkbox+emoji+word layout. It reached
    // #strategies too, since that is a fieldset as well: the lone text node
    // became a flex item packed to flex-start, which text-align: center --
    // meant for a block box, not a flex item's position -- could not fix.
    for (const value of ["intervals", "amrap", "rft"]) {
        const chip = page.locator(`input[value="${value}"]`).locator("xpath=..");
        const box = await chip.boundingBox();
        const textBox = await chip.evaluate((el) => {
            const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
            const r = document.createRange();
            r.selectNodeContents(node);
            const box = r.getBoundingClientRect();
            return { x: box.x, width: box.width };
        });
        const boxCentre = box.x + box.width / 2;
        const textCentre = textBox.x + textBox.width / 2;
        expect(Math.abs(textCentre - boxCentre)).toBeLessThan(2);
    }
});

test("stacks the progress label, countdown, phase, then controls", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const tops = [];
    for (const id of ["round-label", "seconds", "phase", "controls"]) {
        tops.push((await page.locator(`#${id}`).boundingBox()).y);
    }

    for (let i = 1; i < tops.length; i++) {
        expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
});

test("centres the timer group in the space it is given", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const top = await page.locator("#round-label").boundingBox();
    const bottom = await page.locator("#controls").boundingBox();
    // Against main, not the viewport: the footer takes height off the bottom,
    // so viewport centre and main's centre are not the same point.
    const main = await page.locator("main").boundingBox();

    // Measure the ink, not the flex container, which is centred by construction.
    const groupCentre = (top.y + bottom.y + bottom.height) / 2;
    const mainCentre = main.y + main.height / 2;

    expect(Math.abs(groupCentre - mainCentre)).toBeLessThan(6);
});

test("centres the digits horizontally", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const seconds = await page.locator("#seconds").boundingBox();
    const width = page.viewportSize().width;

    // Tolerance is for glyph side bearings, which no amount of CSS removes.
    expect(Math.abs(seconds.x + seconds.width / 2 - width / 2)).toBeLessThan(width * 0.03);
});

test("links to the repository and the build without navigating away", async ({ page }) => {
    await page.goto("/");

    const repo = page.locator("footer a").first();
    const build = page.locator("#build");

    await expect(repo).toHaveAttribute("href", "https://github.com/nothub/gym-timer");

    // Filled in at runtime from version.js, which the build stamps. Asserting
    // the shape rather than a fixed value tests that path end to end: an
    // unstamped build leaves the "dev" fallback in place and fails here.
    const href = await build.getAttribute("href");
    const sha = href.match(/\/commit\/([0-9a-f]{7,40})$/)?.[1];
    expect(sha, `build link href was ${href}`).toBeTruthy();
    await expect(build).toHaveText(sha);

    for (const link of [repo, build]) {
        // Opening in place would lose a running workout in a standalone install.
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", /noopener/);
    }
});

test("the install button waits for the browser to offer an install, and goes after one use", async ({ page }) => {
    await page.goto("/");

    // Nothing offered yet: a button that cannot install anything must not be
    // on screen, which is also the permanent state on every engine that never
    // fires this event.
    await expect(page.locator("#install")).toBeHidden();
    await expect(page.locator("#install-sep")).toBeHidden();

    // Chromium fires beforeinstallprompt only for an app it judges installable
    // and not already installed, which a throwaway test profile on 127.0.0.1
    // is not. Synthesising it drives the page's own handler down the same path
    // a real offer would.
    await page.evaluate(() => {
        window.__prompted = 0;
        const offer = new Event("beforeinstallprompt");
        offer.prompt = () => {
            window.__prompted++;
            return Promise.resolve({ outcome: "accepted" });
        };
        window.dispatchEvent(offer);
    });
    await expect(page.locator("#install")).toBeVisible();
    await expect(page.locator("#install-sep")).toBeVisible();

    await page.locator("#install").click();
    expect(await page.evaluate(() => window.__prompted)).toBe(1);

    // The event is single-use: prompting it twice throws, so the button has to
    // leave rather than sit there offering a dead second go.
    await expect(page.locator("#install")).toBeHidden();
    await expect(page.locator("#install-sep")).toBeHidden();
});

test("never scrolls horizontally", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
});

test("runs a whole EMOM workout on a real requestAnimationFrame loop", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await page.locator("#count").fill("1");
    await start(page);
    await expect(page.locator("#phase")).toHaveText("Get ready");

    // 10 s of prep plus the single minute. fastForward rather than runFor:
    // this asserts the end state, so paying for ~4000 intermediate animation
    // frames buys nothing. The test below uses runFor, where they matter.
    await page.clock.fastForward(70_500);

    await expect(page.locator("#phase")).toHaveText("Done");
    await expect(page.locator("#round-label")).toHaveText("1 cycle");
    await expect(page.locator("#pause")).toBeHidden();
    await expect(page.locator("#seconds")).toBeDisabled();

    // The finish glyph is an emoji, which draws taller than the em square the
    // 0.9 line height gives the digits, and spills over the line below.
    // Bounding boxes cannot see that -- the box is line-height by definition
    // and the ink escapes it -- so this asserts the line box is tall enough to
    // contain a glyph rather than that two boxes fail to intersect.
    const ratio = await page.locator("#seconds").evaluate((node) => {
        const style = getComputedStyle(node);
        return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
    });
    expect(ratio).toBeGreaterThan(1.1);
});

test("counts a real minute down to the flash at the cycle boundary", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await page.locator("#count").fill("2");
    await start(page);

    await page.clock.runFor(9_000); // one second of prep left
    await expect(page.locator("#seconds")).toHaveText("1");
    await expect(page.locator("#seconds")).toHaveClass("warn");

    await page.clock.runFor(1_100); // over the line into cycle 1
    await expect(page.locator("#phase")).toHaveText("Work");
    await expect(page.locator("#round-label")).toHaveText("Cycle 1 / 2");
});

test("Intervals shows work and rest without needing a preset first", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('input[name="strategy"][value="intervals"]')).toBeChecked();
    await expect(page.locator("#interval-fields")).toBeVisible();
    await expect(page.locator("#work-secs")).toHaveValue("60");
    await expect(page.locator("#rest-secs")).toHaveValue("0");
});

test("a preset fills the fields but never switches which strategy is active", async ({ page }) => {
    await page.goto("/");

    await intervalsPreset(page, "tabata");
    await expect(page.locator('input[name="strategy"][value="intervals"]')).toBeChecked();
    await expect(page.locator("#work-secs")).toHaveValue("20");
    await expect(page.locator("#rest-secs")).toHaveValue("10");
    await expect(page.locator("#count")).toHaveValue("8");
});

test("switching strategy swaps the preset row and dims/re-enables work and rest", async ({ page }) => {
    await page.goto("/");

    await strategy(page, "amrap");
    await expect(page.locator("#intervals-presets")).toBeHidden();
    await expect(page.locator("#amrap-presets")).toBeVisible();
    // Dimmed in place, not hidden: main centres the form, so removing the
    // fields would shrink it and drag everything above them down too.
    await expect(page.locator("#interval-fields")).toBeVisible();
    await expect(page.locator("#interval-fields")).toHaveClass("inactive");
    await expect(page.locator("#work-secs")).toBeDisabled();
    await expect(page.locator("#rest-secs")).toBeDisabled();
    await expect(page.locator("#count-label")).toHaveText("⏳ Minutes");

    await strategy(page, "rft");
    await expect(page.locator("#amrap-presets")).toBeHidden();
    await expect(page.locator("#rft-presets")).toBeVisible();
    await expect(page.locator("#count-label")).toHaveText("🎯 Rounds");

    await strategy(page, "intervals");
    await expect(page.locator("#rft-presets")).toBeHidden();
    await expect(page.locator("#intervals-presets")).toBeVisible();
    await expect(page.locator("#interval-fields")).not.toHaveClass("inactive");
    await expect(page.locator("#work-secs")).toBeEnabled();
    await expect(page.locator("#rest-secs")).toBeEnabled();
    await expect(page.locator("#count-label")).toHaveText("🔁 Cycles");
});

test("nothing on the setup screen moves when switching strategy", async ({ page }) => {
    await page.goto("/");

    // main centres the form vertically. Before work/rest were dimmed in place
    // rather than removed, switching away from Intervals shrank the form and
    // re-centred it, dragging the header and strategy row down with it --
    // this caught that even though neither element's own box ever changed.
    const h1Top = () => page.locator("h1").evaluate((n) => n.getBoundingClientRect().y);
    const before = await h1Top();

    for (const s of ["amrap", "rft", "intervals"]) {
        await strategy(page, s);
        expect(await h1Top()).toBe(before);
    }
});

test("preset buttons are the same size in every strategy's row", async ({ page }) => {
    await page.goto("/");

    const box = async (sel) => page.locator(sel).first().boundingBox();
    const intervalsBtn = await box("#intervals-presets button");

    await strategy(page, "amrap");
    const amrapBtn = await box("#amrap-presets button");
    await strategy(page, "rft");
    const rftBtn = await box("#rft-presets button");

    // Intervals' buttons are two lines (name + work/rest); AMRAP's and RFT's
    // are one ("10 min"). Without a shared min-height/min-width the row would
    // resize when switching swapped which button style was showing.
    for (const btn of [amrapBtn, rftBtn]) {
        expect(btn.width).toBe(intervalsBtn.width);
        expect(btn.height).toBe(intervalsBtn.height);
    }
});

test("AMRAP and RFT presets fill the single count field", async ({ page }) => {
    await page.goto("/");

    await strategy(page, "amrap");
    await amrapPreset(page, 15);
    await expect(page.locator("#count")).toHaveValue("15");

    await strategy(page, "rft");
    await rftPreset(page, 10);
    await expect(page.locator("#count")).toHaveValue("10");
});

test("each alias chip shows its own work/rest under its name", async ({ page }) => {
    await page.goto("/");

    // Populated from the same INTERVALS_PRESETS object buildConfig() reads, so
    // the chip cannot claim numbers the preset does not actually use.
    await expect(page.locator("#detail-emom")).toHaveText("60/0");
    await expect(page.locator("#detail-e2mom")).toHaveText("120/0");
    await expect(page.locator("#detail-tabata")).toHaveText("20/10");
});

test("AMRAP: the countdown is the tap target and records a round on tap", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await strategy(page, "amrap");
    await page.locator("#count").fill("1"); // 1-minute window
    await start(page);

    const seconds = page.locator("#seconds");
    // Prep has no round to record yet, so the target stays inert -- and with
    // it the ring that marks it, which is drawn off :not(:disabled).
    await expect(seconds).toBeDisabled();

    await page.clock.runFor(10_000); // clear prep
    await expect(seconds).toBeEnabled();
    await expect(seconds).toHaveAttribute("aria-label", "Record round");

    await seconds.click();
    await seconds.click();
    // A tap only mutates a counter; the display updates on the next animation
    // frame, and the installed clock only advances on request.
    await page.clock.runFor(50);
    await expect(page.locator("#round-label")).toHaveText("Round 2");

    await page.clock.fastForward(60_000);
    await expect(page.locator("#phase")).toHaveText("Done");
    await expect(page.locator("#round-label")).toHaveText("2 rounds");
});

test("Intervals: the countdown is not a tap target", async ({ page }) => {
    await page.goto("/");
    await start(page);
    await expect(page.locator("#seconds")).toBeDisabled();
});

test("RFT: the countdown shows elapsed time and ends on the target round", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await strategy(page, "rft");
    await page.locator("#count").fill("2");
    await start(page);

    await page.clock.runFor(10_000); // clear prep
    // fastForward, not runFor: nothing mid-flight is asserted here, so paying
    // for ~4000 intermediate animation frames buys nothing but 19 real seconds.
    await page.clock.fastForward(65_000);
    await expect(page.locator("#seconds")).toHaveText("1:05");
    await expect(page.locator("#phase")).toHaveText("Work");

    await page.locator("#seconds").click();
    await page.locator("#seconds").click();
    // Same as above: the tap itself is silent, the render waits for a frame.
    await page.clock.runFor(50);
    // Flag on the phase label, digits stay bare: elapsed time is RFT's actual
    // result, and --text-huge has no room for a glyph beside it.
    await expect(page.locator("#phase")).toHaveText("🏁 Done");
    await expect(page.locator("#seconds")).toHaveText("1:05");
    await expect(page.locator("#round-label")).toHaveText("2 rounds");
});

test("ships a manifest Chrome will accept for install", async ({ page, request }) => {
    await page.goto("/");

    const href = await page.locator("link[rel=manifest]").getAttribute("href");
    const res = await request.get(new URL(href, page.url()).toString());

    expect(res.status()).toBe(200);
    // Served as text/plain and Chrome silently declines to install, with no
    // error anywhere the user would see it.
    expect(res.headers()["content-type"]).toContain("application/manifest+json");

    const manifest = await res.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBeTruthy();

    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
});

test("names its cache after the build it was compiled from", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);

    const build = await page.locator("#build").textContent();
    const keys = await page.evaluate(() => caches.keys());

    // The worker gets this through importScripts("./version.js"); the footer
    // gets it from a separate substitution. They can only agree if the build
    // stamped both, so this covers the whole chain in one assertion.
    expect(keys).toContain(`emom-${build}`);
});

test("serves the app from cache with the network cut", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload();

    await expect(page.locator("h1")).toHaveText("Gym Timer");
    await expect(page.locator("#count")).toBeVisible();

    // version.js is precached for this: without it in ASSETS the footer would
    // fall back to "dev" the moment the network went away.
    await expect(page.locator("#build")).not.toHaveText("dev");

    // The timer must still be usable, not merely painted.
    await start(page);
    await expect(page.locator("#timer")).toBeVisible();

    await context.setOffline(false);
});

test("survives a tracking query string offline", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    // The app makes no query strings, but a shared link can arrive with one.
    // ignoreSearch in the fetch handler is what makes this resolve; without it
    // the query misses the cached entry and the page fails to load.
    await page.goto("/?utm_source=somewhere");

    await expect(page.locator("h1")).toHaveText("Gym Timer");
    await context.setOffline(false);
});

test("strategy and count persist without touching the url", async ({ page }) => {
    await page.goto("/");
    const url = page.url();

    await strategy(page, "amrap");
    await page.locator("#count").fill("4");
    // Typing used to rewrite the address bar. All state lives in one place now.
    expect(page.url()).toBe(url);

    await page.reload();
    await expect(page.locator('input[name="strategy"][value="amrap"]')).toBeChecked();
    await expect(page.locator("#count")).toHaveValue("4");
    expect(page.url()).toBe(url);
});

test("Intervals' own count survives a detour through AMRAP", async ({ page }) => {
    await page.goto("/");

    await page.locator("#count").fill("7");
    await strategy(page, "amrap");
    await strategy(page, "intervals");

    await expect(page.locator("#count")).toHaveValue("7");
});

test("cue checkboxes toggle independently and survive a reload", async ({ page }) => {
    await page.goto("/");

    const sound = page.getByLabel("Sound");
    const buzz = page.getByLabel("Buzz");

    await expect(sound).toBeChecked();
    await expect(buzz).toBeChecked();

    await sound.uncheck();
    await expect(sound).not.toBeChecked();
    await expect(buzz).toBeChecked();

    await page.reload();
    await expect(sound).not.toBeChecked();
    await expect(buzz).toBeChecked();
});

test("disables the buzz checkbox when the browser has no Vibration API", async ({ page }) => {
    await page.addInitScript(() => {
        delete Object.getPrototypeOf(navigator).vibrate;
    });
    await page.goto("/");

    const buzz = page.getByLabel("Buzz");
    await expect(buzz).toBeDisabled();
    // Left ticked it would read as working, which it would not be.
    await expect(buzz).not.toBeChecked();
    await expect(page.getByLabel("Sound")).toBeEnabled();
});

test("completes a workout when the browser refuses to make an AudioContext", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.addInitScript(() => {
        window.AudioContext = function () {
            throw new Error("audio blocked");
        };
        delete window.webkitAudioContext;
    });
    await page.clock.install();
    await page.goto("/");

    await page.locator("#count").fill("1");
    await start(page);
    // Start calls initAudio before start(); an escaping throw stops it here.
    await expect(page.locator("#timer")).toBeVisible();

    // beep runs inside the animation frame, so a throw there kills the loop.
    await page.clock.fastForward(70_500);
    await expect(page.locator("#phase")).toHaveText("Done");

    expect(errors).toEqual([]);
});

test("starting the timer does not throw", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await start(page);
    await expect(page.locator("#timer")).toBeVisible();

    // Constructing an AudioContext is the realistic failure here, and it sits
    // in the submit handler ahead of everything else.
    expect(errors).toEqual([]);
});
