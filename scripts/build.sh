#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

# Build src/ into dist/, stamping the commit being built.
#
# A commit cannot contain its own hash, so the build id is substituted here
# rather than committed. src/ is never written to: the placeholders it carries
# are valid values on their own, so src/index.html opens directly in a browser
# and honestly reads "dev".
#
# Usage: build.sh [commit-sha]
#   Defaults to HEAD. The deploy workflow passes GITHUB_SHA explicitly.

# Project root, one level up from scripts/.
cd "$(dirname "$(readlink -f "$0")")/.."

readonly SRC="src"
readonly OUT="dist"

SHA="${1:-$(git rev-parse HEAD)}"
readonly SHA
readonly SHORT="${SHA:0:7}"

# sed reports success when it matches nothing, so each substitution is checked
# both before and after. A silent miss would publish a page still claiming to
# be a dev build. The patterns are fixed strings free of regex metacharacters,
# and these two guards catch it loudly if that ever stops being true.
replace() {
    local file=$1 from=$2 to=$3

    if ! grep -qF -- "${from}" "${file}"; then
        echo "build: ${file} has no '${from}' to replace" >&2
        exit 1
    fi

    sed -i "s|${from}|${to}|g" "${file}"

    if ! grep -qF -- "${to}" "${file}"; then
        echo "build: replacing '${from}' in ${file} did not take" >&2
        exit 1
    fi
}

rm -rf "${OUT}"
mkdir -p "${OUT}"
cp -R "${SRC}/." "${OUT}/"

replace "${OUT}/index.html" "/commits/trunk" "/commit/${SHA}"
replace "${OUT}/index.html" ">dev</a>" ">${SHORT}</a>"

# sw.js reads this rather than carrying the id itself, so the worker source is
# never rewritten. Imported scripts count toward the service worker's update
# check, so changing this file is what triggers a reinstall.
replace "${OUT}/version.js" '"dev"' "\"${SHORT}\""

echo "build: ${OUT} from ${SRC} at ${SHORT}" >&2
