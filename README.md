# gym-timer

A conditioning timer. Three strategies, one row of chips on the setup screen:

- **Intervals** -- work, then rest, repeated. Work and rest are always on
  screen, so there is nothing to configure to hand-type your own; EMOM
  (60/0), E2MOM (120/0) and Tabata (20/10 x8) are presets that fill them in,
  not separate modes -- clicking one never leaves Intervals.
- **AMRAP** -- a fixed countdown, and nothing else. How many rounds you got is
  yours to remember; the app has no way to know what a round was, so counting
  them is a job for your head, not a button.
- **RFT** -- a lap timer. Tap the big number to close a round: its time goes
  into the list and the digits restart from zero for the next one, while the
  total runs on in the label above, since the total is what RFT is scored on.
  It ends on the target round and reports every split. The only place a tap
  decides anything, because the round count is what ends it.

Live at <https://nothub.github.io/gym-timer/>.

Three short beeps lead into every transition a strategy has, a longer one
marks it, and the screen flashes at the same moment so the cue carries across
a noisy room. RFT counts up with nothing to count down to, so it only cues the
prep countdown and the finish.

## Running it

Plain HTML, CSS and JavaScript. No framework, no bundler, no package manager.

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
  reset.css   Meyer's reset, verbatim and unedited
  style.css   everything the app styles itself
dist/       build output, gitignored
scripts/    build.sh, test.sh
tests/      both tiers, the fake-DOM harness, and a static server
```

`build.sh` copies `src/` into `dist/` and rewrites exactly one line: the commit
id in `version.js`. Nothing else is generated or transformed, and `src/` is
never written to.

Pushing to `trunk` runs the suite and deploys `dist/` to GitHub Pages if it
passes. Pull requests run the suite without deploying.

## Notes

Safari on iOS has never implemented the Vibration API, so the buzz checkbox
disables itself wherever `navigator.vibrate` is missing rather than offering a
setting that does nothing.

The browser releases the screen wake lock whenever the page is hidden, and a
released lock cannot be reused, so a new one is requested on `visibilitychange`
while a workout is on screen.

Sound is a cue, not the clock. A browser that refuses to build an `AudioContext`
gets a silent workout, not a broken one.
