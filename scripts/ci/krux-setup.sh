#!/bin/bash
# Fetches what tests/krux.test.ts and tests/krux.e2e.test.ts need to run Paperclip's Krux signing code: the
# firmware source at its release commit, its embit submodule, and the UR library built for this Python.
# Used by the GitHub workflows; see tools/krux-check/README.md for doing it by hand.
#
#   scripts/ci/krux-setup.sh <folder>
# Prints KRUX_SRC and KRUX_UUR lines, for $GITHUB_ENV.

set -euo pipefail

dir="$1"
# Paperclip's Krux v26.09.0-xbt.2, the firmware release Crossbill 0.4.0 was tested against
KRUX_COMMIT="fd75a549d3f0ff3d87e6f57c0ffece8420a748ab"
# selfcustody/cUR, the commit the firmware's MaixPy submodule uses
CUR_COMMIT="ed744562f738a9b28a8fabd3b9eb28ef34d76b35"
PYTHON="${KRUX_PYTHON:-python3}"

mkdir -p "$dir"
git clone --quiet --filter=blob:none https://github.com/connorslab/krux-blake2b.git "$dir/krux"
git -C "$dir/krux" -c advice.detachedHead=false checkout --quiet "$KRUX_COMMIT"
git -C "$dir/krux" submodule update --quiet --init --depth 1 vendor/embit

git clone --quiet --filter=blob:none https://github.com/selfcustody/cUR.git "$dir/cur"
git -C "$dir/cur" -c advice.detachedHead=false checkout --quiet "$CUR_COMMIT"
"$PYTHON" -m pip install --quiet --disable-pip-version-check --target "$dir/uur" "$dir/cur" >&2

echo "KRUX_SRC=$dir/krux"
echo "KRUX_UUR=$dir/uur"
