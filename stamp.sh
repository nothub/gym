#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

# Rewrite the CACHE constant in sw.js with a hash of the assets it precaches.
#
# A service worker is only reinstalled when its own bytes change, so stamping
# the content hash here is what makes the browser re-precache exactly when the
# app actually changed -- and leave sw.js untouched when it did not.
#
# Run before deploying. Safe to run repeatedly.

cd "$(dirname "$(readlink -f "$0")")"

readonly SW="sw.js"

if [[ ! -f ${SW} ]]; then
    echo "stamp: ${SW} not found" >&2
    exit 1
fi

# Read the asset list out of sw.js rather than duplicating it here, so the two
# cannot drift. The bare "./" entry aliases index.html and drops out empty.
mapfile -t assets < <(
    sed -n '/^const ASSETS = \[/,/^\];/p' "${SW}" \
        | grep -o '"\./[^"]*"' \
        | tr -d '"' \
        | sed 's|^\./||' \
        | grep -v '^$' \
        | LC_ALL=C sort
)

if [[ ${#assets[@]} -eq 0 ]]; then
    echo "stamp: no assets parsed from ${SW}" >&2
    exit 1
fi

for asset in "${assets[@]}"; do
    if [[ ! -f ${asset} ]]; then
        echo "stamp: ${SW} precaches '${asset}', which does not exist" >&2
        exit 1
    fi
done

hash=$(sha256sum "${assets[@]}" | sha256sum | cut -c1-12)
readonly hash

old=$(grep -o '^const CACHE = "[^"]*"' "${SW}" | cut -d'"' -f2)
readonly old
readonly new="emom-${hash}"

if [[ ${old} == "${new}" ]]; then
    echo "stamp: unchanged (${new}), ${#assets[@]} assets" >&2
    echo "${new}"
    exit 0
fi

sed -i "s|^const CACHE = .*|const CACHE = \"${new}\";|" "${SW}"

echo "stamp: ${old} -> ${new} (${#assets[@]} assets)" >&2
echo "${new}"
