// Browser tier: only the things a fake DOM cannot prove.
//
// Timing, cue schedules and preference precedence are covered far more cheaply
// in logic.test.js. What lives here needs a real rendering engine: layout
// geometry, service worker registration, manifest parsing, and the fact that
// the requestAnimationFrame loop actually runs.

import { expect, test } from "@playwright/test";

const start = (page) => page.getByRole("button", { name: "Start" }).click();

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

test("stacks round count, countdown, phase, then controls", async ({ page }) => {
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

    await expect(repo).toHaveAttribute("href", "https://github.com/nothub/gym");

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

test("runs a whole workout on a real requestAnimationFrame loop", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await page.locator("#rounds").fill("1");
    await start(page);
    await expect(page.locator("#phase")).toHaveText("Get ready");

    // 10 s of prep plus the single minute. fastForward rather than runFor:
    // this asserts the end state, so paying for ~4000 intermediate animation
    // frames buys nothing. The test below uses runFor, where they matter.
    await page.clock.fastForward(70_500);

    await expect(page.locator("#phase")).toHaveText("Done");
    await expect(page.locator("#round-label")).toHaveText("1 rounds");
    await expect(page.locator("#pause")).toBeHidden();

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

test("counts a real minute down to the flash at the boundary", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");

    await page.locator("#rounds").fill("2");
    await start(page);

    await page.clock.runFor(9_000); // one second of prep left
    await expect(page.locator("#seconds")).toHaveText("1");
    await expect(page.locator("#seconds")).toHaveClass("warn");

    await page.clock.runFor(1_100); // over the line into round 1
    await expect(page.locator("#phase")).toHaveText("Work");
    await expect(page.locator("#round-label")).toHaveText("Round 1 / 2");
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

    await expect(page.locator("h1")).toHaveText("EMOM");
    await expect(page.locator("#rounds")).toBeVisible();

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

    await expect(page.locator("h1")).toHaveText("EMOM");
    await context.setOffline(false);
});

test("round count persists without touching the url", async ({ page }) => {
    await page.goto("/");
    const url = page.url();

    await page.locator("#rounds").fill("12");
    // Typing used to rewrite the address bar. All state lives in one place now.
    expect(page.url()).toBe(url);

    await page.reload();
    await expect(page.locator("#rounds")).toHaveValue("12");
    expect(page.url()).toBe(url);
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
