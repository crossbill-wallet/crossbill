#!/bin/bash
# Gets Shrike for iPhone ready to install from a Mac, in one go:
#   1. checks Xcode is installed
#   2. installs Node.js and CocoaPods with Homebrew if they're missing
#   3. sets a bundle ID of your own
#   4. installs the app's packages and builds it (this downloads the Tor library)
#   5. opens the project in Xcode
# Safe to run again. See GETTING-STARTED.md for what comes after.

set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() {
  printf '\n\033[31m%s\033[0m\n' "$1" >&2
  exit 1
}

[[ "$(uname)" == "Darwin" ]] || fail "This needs to run on a Mac."

step "1/5  Checking Xcode"
if ! xcodebuild -version >/dev/null 2>&1; then
  if [[ -d /Applications/Xcode.app ]]; then
    fail "Xcode is installed but Terminal isn't using it yet. Run this, enter your Mac password, then run ./setup.sh again:
  sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept"
  fi
  fail "Install Xcode from the Mac App Store, open it once so it can finish setting up, then run ./setup.sh again."
fi
xcodebuild -version | head -1

step "2/5  Checking Node.js and CocoaPods"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$b" ]] && eval "$("$b" shellenv)" && break
  done
fi
if ! command -v node >/dev/null 2>&1 || ! command -v pod >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Installing Homebrew, the usual way to get developer tools on a Mac. It asks for your Mac password."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      [[ -x "$b" ]] && eval "$("$b" shellenv)" && break
    done
  fi
  command -v node >/dev/null 2>&1 || brew install node
  command -v pod >/dev/null 2>&1 || brew install cocoapods
fi
# The build tools need Node.js 20.19 or newer
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' ||
  fail "Node.js $(node --version) is too old. Run: brew upgrade node, then ./setup.sh again."
echo "Node.js $(node --version), CocoaPods $(pod --version)"

step "3/5  Your app's bundle ID"
CURRENT=$(sed -nE "s/.*appId: '([^']+)'.*/\1/p" capacitor.config.ts | head -1)
echo "Apple identifies the app by a bundle ID that has to be yours alone, such as com.yourname.shrike."
BID=""
read -r -p "Bundle ID [$CURRENT]: " BID || true
BID=${BID:-$CURRENT}
[[ "$BID" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]] ||
  fail "\"$BID\" isn't a bundle ID. Use letters, numbers and dashes, separated by dots, such as com.yourname.shrike."
sed -i '' -E "s/appId: '[^']+'/appId: '$BID'/" capacitor.config.ts
sed -i '' -E "s/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/PRODUCT_BUNDLE_IDENTIFIER = $BID;/" ios/App/App.xcodeproj/project.pbxproj
echo "Using $BID"

step "4/5  Installing packages and building (a few minutes the first time)"
npm install --no-audit --no-fund || npm install --no-audit --no-fund --legacy-peer-deps
npm run ios:sync

step "5/5  Opening Xcode"
npx cap open ios

cat <<'EOF'

Done. Now, in Xcode (step 3 of GETTING-STARTED.md goes through this in more detail):
  1. If Xcode offers to "Update to recommended settings", choose Cancel.
  2. Click App in the left sidebar, then the App target, then Signing & Capabilities.
     Tick "Automatically manage signing" and choose your Apple ID under Team.
  3. Plug in your iPhone, choose it at the top of the window, and press Run.
EOF
