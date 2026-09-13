#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

# Two tiers, always both.
#
#   logic   - the app's own <script> against a fake DOM and a fake clock.
#             Cue schedules, minute boundaries, preference precedence.
#   browser - real Chromium in Docker. Layout geometry, the service worker,
#             the manifest, and that the animation frame loop really runs.
#
# The whole run is about ten seconds. That is cheap enough that choosing a
# tier cost more attention than skipping one ever saved.

# Project root, one level up from scripts/.
cd "$(dirname "$(readlink -f "$0")")/.."

readonly IMAGE="emom-test"

echo "==> logic tests" >&2
deno test --allow-read tests/logic.test.js

echo "==> browser tests" >&2
if ! docker info > /dev/null 2>&1; then
    echo "test: docker daemon is not reachable" >&2
    exit 1
fi

docker build --quiet --tag "${IMAGE}" --file tests/Dockerfile tests/ > /dev/null

# --ipc=host keeps Chromium from exhausting the default 64 MB /dev/shm.
# --init reaps the processes Chromium leaves behind.
# The repo mounts read-only; Playwright writes its artefacts to /tmp.
docker run --rm \
    --ipc=host \
    --init \
    --volume "${PWD}:/work/app:ro" \
    "${IMAGE}" \
    npx playwright test --config tests/playwright.config.js
