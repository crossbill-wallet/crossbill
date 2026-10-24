#!/bin/bash
# Builds bitcoind and bitcoin-cli from Bitcoin Knots v29.4.1.knots20260508, the BLAKE2b fork release the regtest
# suites run against, into <folder>. Used by the weekly GitHub workflow; takes 15 to 30 minutes on a runner.
# Needs: build-essential cmake pkgconf libevent-dev libboost-dev libsqlite3-dev
#
#   scripts/ci/knots-build.sh <folder>

set -euo pipefail

out="$1"
KNOTS_TAG="v29.4.1.knots20260508"
KNOTS_COMMIT="8c85b1585dac23f964e2dd32045624de7f02aa58"
src="$(mktemp -d)/knots"

git clone --quiet --depth 1 --branch "$KNOTS_TAG" https://github.com/bitcoinknots/bitcoin.git "$src"
got="$(git -C "$src" rev-parse HEAD)"
if [ "$got" != "$KNOTS_COMMIT" ]; then
  echo "Tag $KNOTS_TAG is at $got, not $KNOTS_COMMIT" >&2
  exit 1
fi

cmake -S "$src" -B "$src/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTS=OFF \
  -DBUILD_BENCH=OFF \
  -DBUILD_GUI=OFF \
  -DWITH_ZMQ=OFF \
  -DENABLE_IPC=OFF \
  -DWITH_CCACHE=OFF
cmake --build "$src/build" --parallel "$(nproc)" --target bitcoind bitcoin-cli

mkdir -p "$out"
cp "$src/build/bin/bitcoind" "$src/build/bin/bitcoin-cli" "$out/"
"$out/bitcoind" -version | head -1
