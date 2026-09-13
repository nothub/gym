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

test("centres the countdown in the space above the controls", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const clock = await page.locator("#clock").boundingBox();
    const phase = await page.locator("#phase").boundingBox();
    const label = await page.locator("#round-label").boundingBox();

    // Measure the ink, not the flex region: the region is centred by
    // construction, its contents are what drifted when #round-label carried a
    // bottom margin that nothing above it balanced.
    const contentCentre = (phase.y + label.y + label.height) / 2;
    const regionCentre = clock.y + clock.height / 2;

    expect(Math.abs(contentCentre - regionCentre)).toBeLessThan(4);
});

test("centres the digits horizontally", async ({ page }) => {
    await page.goto("/");
    await start(page);

    const seconds = await page.locator("#seconds").boundingBox();
    const width = page.viewportSize().width;

    // Tolerance is for glyph side bearings, which no amount of CSS removes.
    expect(Math.abs(seconds.x + seconds.width / 2 - width / 2)).toBeLessThan(width * 0.03);
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

test("serves the app from cache with the network cut", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    await page.reload();

    await expect(page.locator("h1")).toHaveText("EMOM");
    await expect(page.locator("#rounds")).toBeVisible();

    // The timer must still be usable, not merely painted.
    await start(page);
    await expect(page.locator("#timer")).toBeVisible();

    await context.setOffline(false);
});

test("keeps a bookmarked round count working offline", async ({ page, context }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    // ignoreSearch in the fetch handler is what makes this resolve; without it
    // the query string misses the cached entry and the page fails to load.
    await page.goto("/?rounds=12");

    await expect(page.locator("#rounds")).toHaveValue("12");
    await context.setOffline(false);
});

test("round count round-trips through the url", async ({ page }) => {
    await page.goto("/");

    await page.locator("#rounds").fill("12");
    await expect(page).toHaveURL(/\?rounds=12$/);

    await page.goto("/?rounds=7");
    await expect(page.locator("#rounds")).toHaveValue("7");
});

test("disables the buzz options when the browser has no Vibration API", async ({ page }) => {
    await page.addInitScript(() => {
        delete Object.getPrototypeOf(navigator).vibrate;
    });
    await page.goto("/");

    await expect(page.locator('input[value="vibrate"]')).toBeDisabled();
    await expect(page.locator('input[value="both"]')).toBeDisabled();
    // "both" on a device that cannot buzz would be silent, so it degrades.
    await expect(page.locator('input[value="sound"]')).toBeChecked();
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
