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

test("the strategy row and every preset row start at the same left edge", async ({ page }) => {
    await page.goto("/");

    // #strategies is a <fieldset>, and a bare `fieldset { justify-content:
    // center }` rule exists for #cues. It has silently reached other
    // fieldsets before (see git history) whenever a row was narrower than
    // the form, centering it instead of aligning it with everything above.
    const rows = [
        // The chip is the label; the radio itself is visually hidden via
        // position:absolute and does not sit at the chip's edge.
        page.locator("#strategies label").first(),
        page.locator("#intervals-presets button").first(),
    ];
    const lefts = await Promise.all(rows.map(async (r) => (await r.boundingBox()).x));
    for (const x of lefts.slice(1)) {
        expect(Math.abs(x - lefts[0])).toBeLessThan(2);
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

test("switching strategy swaps the preset row and the visible fields", async ({ page }) => {
    await page.goto("/");

    await strategy(page, "amrap");
    await expect(page.locator("#intervals-presets")).toBeHidden();
    await expect(page.locator("#amrap-presets")).toBeVisible();
    await expect(page.locator("#interval-fields")).toBeHidden();
    await expect(page.locator("#count-label")).toHaveText("Minutes");

    await strategy(page, "rft");
    await expect(page.locator("#amrap-presets")).toBeHidden();
    await expect(page.locator("#rft-presets")).toBeVisible();
    await expect(page.locator("#count-label")).toHaveText("Rounds");

    await strategy(page, "intervals");
    await expect(page.locator("#rft-presets")).toBeHidden();
    await expect(page.locator("#intervals-presets")).toBeVisible();
    await expect(page.locator("#interval-fields")).toBeVisible();
    await expect(page.locator("#count-label")).toHaveText("🔁 Cycles");
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
    await expect(seconds).toBeEnabled();
    await expect(seconds).toHaveAttribute("aria-label", "Record round");

    await page.clock.runFor(10_000); // clear prep
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

    await expect(page.locator("h1")).toHaveText("Timer");
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

    await expect(page.locator("h1")).toHaveText("Timer");
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
