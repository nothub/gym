#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

# Stamp a commit into the files that ship, replacing the "dev" placeholders.
#
# Run by the deploy workflow, which passes GITHUB_SHA. A commit cannot contain
# its own hash, so this cannot happen before the commit exists -- which is why
# it runs at deploy time rather than as a pre-commit step.
#
# Two places want the same value, for different reasons:
#   index.html  a footer link to the exact commit the page was built from
#   sw.js       a cache name that changes, so browsers reinstall the worker

# Project root, one level up from scripts/.
cd "$(dirname "$(readlink -f "$0")")/.."

readonly SHA="${1:-}"

if [[ -z ${SHA} ]]; then
    echo "inject-build: usage: inject-build.sh <commit-sha>" >&2
    exit 2
fi

readonly SHORT="${SHA:0:7}"

# sed reports success when it matches nothing, so every replacement is checked
# both before and after. A silent miss would publish a page still claiming to
# be a dev build. The patterns are fixed strings free of regex metacharacters,
# and these two guards catch it loudly if that ever stops being true.
replace() {
    local file=$1 from=$2 to=$3

    if ! grep -qF -- "${from}" "${file}"; then
        echo "inject-build: ${file} has no '${from}' to replace" >&2
        exit 1
    fi

    sed -i "s|${from}|${to}|g" "${file}"

    if ! grep -qF -- "${to}" "${file}"; then
        echo "inject-build: replacing '${from}' in ${file} did not take" >&2
        exit 1
    fi
}

replace index.html "/commits/trunk" "/commit/${SHA}"
replace index.html ">dev</a>" ">${SHORT}</a>"
replace sw.js '"emom-dev"' "\"emom-${SHORT}\""

echo "inject-build: stamped ${SHORT}" >&2
