# gym

An EMOM timer. Pick a number of minutes, press start, do the work at the top of
each one.

Live at <https://nothub.github.io/gym/>.

EMOM means every minute on the minute. A round is always 60 seconds, so the
round count is the only thing to configure. Three short beeps lead into each
minute, a longer one marks it, and the screen flashes at the same moment so the
cue carries across a noisy room.

## Running it

Plain HTML, CSS and JavaScript in one file. No framework, no bundler, no
package manager.

```
./scripts/build.sh
python3 -m http.server -d dist 8000
```

A service worker needs a secure context, and localhost counts as one, so the
offline behaviour works locally too. Opening `src/index.html` straight off disk
works for everything except the service worker, which will not register over
`file://`.

## Tests

```
./scripts/test.sh
```

Two tiers, both run, about ten seconds together.

**Logic** runs the app's own `<script>` against a fake DOM, clock, storage and
navigator, on deno, in about 50 ms. It owns the parts that are pure logic: when
cues fire, where the minute boundaries land, which preference wins.

**Browser** drives real Chromium through Playwright, in Docker. It owns what a
fake DOM cannot prove: layout geometry, service worker registration and offline
behaviour, manifest parsing, and that the animation frame loop actually runs.

Docker is needed for the second tier only. Playwright and its browsers live in
that image, so the app itself keeps no dependencies.

## Layout

```
src/        the site
dist/       build output, gitignored
scripts/    build.sh, test.sh
tests/      both tiers, the fake-DOM harness, and a static server
```

`build.sh` copies `src/` into `dist/` and rewrites exactly one line: the commit
id in `version.js`. Nothing else is generated or transformed, and `src/` is
never written to.

Pushing to `trunk` runs the suite and deploys `dist/` to GitHub Pages if it
passes. Pull requests run the suite without deploying.

## Why version.js is JavaScript and not a text file

A commit cannot contain its own hash, so the build id has to be stamped after
the commit exists, at deploy time.

A service worker only reinstalls when its own bytes change. If the build id sat
in a plain text file that the worker fetched, deploying a new one would change
nothing: the old worker would keep serving the old cache indefinitely. Scripts
pulled in with `importScripts()` are inside that byte comparison, so
`version.js` changing is what triggers the update.

The page loads the same file with a `<script>` tag. `self` is the window in a
page and the global scope in a worker, so one file serves both, and the footer
link and the cache name cannot disagree about which build is running.

Registration passes `updateViaCache: "none"`. The HTTP cache is still consulted
for imported scripts, so without it a stale `version.js` would hold updates
back for as long as the host's max-age.

## Notes

Safari on iOS has never implemented the Vibration API, so the buzz checkbox
disables itself wherever `navigator.vibrate` is missing rather than offering a
setting that does nothing.

The browser releases the screen wake lock whenever the page is hidden, and a
released lock cannot be reused, so a new one is requested on `visibilitychange`
while a workout is on screen.

Sound is a cue, not the clock. A browser that refuses to build an `AudioContext`
gets a silent workout, not a broken one.
