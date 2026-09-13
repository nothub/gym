#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

# Two tiers.
#
#   logic   - the app's own <script> against a fake DOM and a fake clock.
#             Runs on deno in about 50 ms. Owns cue schedules, minute
#             boundaries, preference precedence.
#   browser - real Chromium in Docker. Owns layout geometry, the service
#             worker, the manifest, and the fact that rAF actually runs.
#
# Docker is only needed for the second tier, so the tier you run constantly
# needs nothing installed but deno.

# Project root, one level up from scripts/.
cd "$(dirname "$(readlink -f "$0")")/.."

readonly IMAGE="emom-test"

usage() {
    cat >&2 << 'EOF'
usage: scripts/test.sh [--logic | --browser]

  (no flag)   run both tiers
  --logic     fast tier only, no Docker
  --browser   browser tier only
EOF
}

logic() {
    echo "==> logic tests" >&2
    deno test --allow-read test/logic.test.js
}

browser() {
    echo "==> browser tests" >&2

    if ! docker info > /dev/null 2>&1; then
        echo "test: docker daemon is not reachable" >&2
        return 1
    fi

    docker build --quiet --tag "${IMAGE}" --file test/Dockerfile test/ > /dev/null

    # --ipc=host keeps Chromium from exhausting the default 64 MB /dev/shm.
    # --init reaps the browser processes Chromium leaves behind.
    # The repo mounts read-only; Playwright writes its artefacts to /tmp.
    docker run --rm \
        --ipc=host \
        --init \
        --volume "${PWD}:/work/app:ro" \
        "${IMAGE}" \
        npx playwright test --config test/playwright.config.js
}

main() {
    case "${1:-}" in
        --logic)
            logic
            ;;
        --browser)
            browser
            ;;
        "")
            logic
            browser
            ;;
        -h | --help)
            usage
            ;;
        *)
            echo "test: unknown argument '${1}'" >&2
            usage
            exit 2
            ;;
    esac
}

main "$@"
