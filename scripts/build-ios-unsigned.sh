#!/bin/bash
# Builds an unsigned Crossbill .ipa from this checkout, the way the release workflow does: no certificate, no team
# and no name in it. Testers sign it with their own Apple Account in a sideloading tool (see TESTERS.md).
#
# Run on a Mac with Xcode 26 or later and CocoaPods, after `npm ci`:
#   scripts/build-ios-unsigned.sh [output folder, default build/ios]

set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-build/ios}"
version="$(node -p "require('./package.json').version")"
rm -rf "$out"
mkdir -p "$out"

npm run build
npx cap sync ios
node scripts/ios-widgets.mjs

# Compiles the app, the native plugin and the widgets, signing nothing
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$out/Crossbill.xcarchive" \
  -quiet \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  archive

app="$out/Crossbill.xcarchive/Products/Applications/App.app"
if [ ! -d "$app" ]; then
  echo "The archive has no App.app" >&2
  exit 1
fi
if [ ! -d "$app/PlugIns/ShrikeWidgets.appex" ]; then
  echo "The widgets extension is missing from App.app" >&2
  exit 1
fi

# Ad hoc signatures: no certificate and no name, but they carry each part's entitlements, so a sideloading tool
# knows the app and its widgets share an App Group. The tool replaces them with the tester's own.
if [ -d "$app/Frameworks" ]; then
  find "$app/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' \) -print0 |
    xargs -0 -n 1 codesign --force --sign - --timestamp=none
fi
codesign --force --sign - --timestamp=none --entitlements ios/App/ShrikeWidgets/ShrikeWidgets.entitlements "$app/PlugIns/ShrikeWidgets.appex"
codesign --force --sign - --timestamp=none --entitlements ios/App/App/App.entitlements "$app"
codesign --verify --deep "$app" || echo "warning: codesign --verify didn't pass; sideloading tools re-sign everything anyway" >&2

ipa_name="Crossbill-$version-unsigned.ipa"
mkdir -p "$out/ipa/Payload"
cp -R "$app" "$out/ipa/Payload/"
(cd "$out/ipa" && zip -qry -X "../$ipa_name" Payload)
rm -rf "$out/ipa"
(cd "$out" && shasum -a 256 "$ipa_name" > "$ipa_name.sha256")
cat "$out/$ipa_name.sha256"
