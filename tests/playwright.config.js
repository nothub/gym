import { defineConfig } from "@playwright/test";

const PORT = 8080;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: ".",
    testMatch: "*.spec.js",

    // Service worker registrations and caches are per-origin, so parallel
    // workers would fight over the same one.
    workers: 1,
    fullyParallel: false,

    reporter: [["list"]],
    // Artefacts stay outside the repo, which lets the container mount it read-only.
    outputDir: "/tmp/playwright-artifacts",
    timeout: 30_000,

    use: {
        baseURL,
        serviceWorkers: "allow",
    },

    projects: [
        { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
        { name: "phone", use: { viewport: { width: 412, height: 915 } } },
    ],

    webServer: {
        // .mjs so node reads it as ESM without a package.json to point at.
        command: "node serve.mjs",
        url: `${baseURL}/index.html`,
        reuseExistingServer: false,
        timeout: 10_000,
    },
});
