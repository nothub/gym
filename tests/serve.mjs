// Static file server for the browser tests. Exists because a service worker
// will not register over file://, and 127.0.0.1 counts as a secure context.
//
// node:http only -- the app has no dependencies and neither does testing it.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
};

createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (path.endsWith("/")) path += "index.html";

    // normalize collapses ../ segments; the leading-dots strip stops anything
    // that survives from climbing out of ROOT.
    const file = join(ROOT, normalize(path).replace(/^(\.\.(\/|\\|$))+/, ""));

    try {
        const body = await readFile(file);
        res.writeHead(200, {
            "content-type": TYPES[extname(file)] ?? "application/octet-stream",
            // Keep the HTTP cache out of it so the tests measure the service
            // worker's cache and nothing else.
            "cache-control": "no-store",
        });
        res.end(body);
    } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
}).listen(PORT, "127.0.0.1", () => {
    console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
