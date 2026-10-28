# Crossbill

[![CI](https://github.com/crossbill-wallet/crossbill/actions/workflows/ci.yml/badge.svg)](https://github.com/crossbill-wallet/crossbill/actions/workflows/ci.yml)

An iPhone wallet for Bitcoin (XBT) on the BLAKE2b chain: the chain that changed Bitcoin's proof of work to BLAKE2b and signs with the unified opt-in signature hash. It talks to your own Bitcoin Knots node over Tor, and keeps your seed words in the iPhone Keychain behind Face ID. Paired with your own Lightning Fork node, it sends and receives on Lightning too. The only other site it contacts is Neoxa Exchange, for the XBT price, which can be turned off.

It works alongside [Shrike](https://shrikewallet.com/), the desktop wallet that parts of it are ported from: a wallet you already use in Shrike on your computer opens here with no rescan.

Crossbill was called Shrike for iPhone before version 0.4.0. It is independent: not affiliated with or endorsed by the Shrike, Sparrow, Bitcoin Knots or Lightning Fork projects, Paperclip or Connor's Lab.

Not audited. Use at your own risk, under the Apache 2.0 terms (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Start with a small amount.

**New here? Start with [GETTING-STARTED.md](GETTING-STARTED.md).** It goes from a new Mac to a working wallet on your iPhone, and `./setup.sh` does most of the work. To try a test build without a Mac of your own, see [TESTERS.md](TESTERS.md).

## What it does

- Holds one or more seed-word wallets (Native Segwit, Taproot, Nested Segwit or Legacy), with an optional passphrase. A wallet's settings can open the same seed words with a passphrase as a second wallet.
- Finds a wallet you already use in Shrike on your computer on your node, with no rescan. It uses the same `cormorant` watch-only wallet and the same descriptors the desktop app imports, so both apps keep working side by side.
- Receive with QR codes and labels. Send to one or more recipients, with fee rates from your node, Max, coin control, and a My wallets button that fills in the next address of another wallet on the phone.
- Signs with the unified signature hash (hash type `0x21`) whenever the desktop app would: when the chain tip carries a v2 header and the activation height built into the app agrees with the one your node reports. The send and review screens say whether a transaction is replay protected, and why not when it isn't.
- Raise the fee on, or cancel, an unconfirmed send (replace by fee).
- Labels and frozen coins, imported and exported as BIP329 files, the same format as Shrike's Export Labels and Import Labels.
- Face ID to open the app and to sign. The seed is read from the Keychain only for the moment of signing. Screens showing seed words warn if a screenshot is taken.
- Transaction pages link to a block explorer: mempool.guide by default, as in desktop Shrike, or your own, or none. Onion explorers open in Onion Browser.
- Two-factor: a 6-digit code from any authenticator app (time-based, RFC 6238) before every send, fee raise and cancel, before showing seed words, and to turn it off. Offered once after setup, with Skip, and any time in Settings. Eight one-time recovery codes. The key stays in the Keychain on this device.
- A tab bar along the bottom: Wallet, Market, Lightning (once paired), Contacts and Settings.
- Lightning through your own [Lightning Fork](https://github.com/paulscode/lightning-fork) node, using its dashboard's mobile API: pay Lightning invoices and offers, pay invoices on the SHA256 chain through your node's bridge (your own bridge pays them with BTC, with no XBT spent), make invoices and offers, send and receive on chain from the node's wallet, and see its balances and payments. Pairing is by QR code from the dashboard. At home the app reaches the node over HTTPS pinned to its root certificate, and away it uses the dashboard's onion through Tor. Every payment needs Face ID and the two-factor code when it's on, and carries a request ID, so a lost answer is asked about, never paid twice.
- Market: the XBT/USDC price from [Neoxa Exchange](https://neoxa.exchange/trade/BTCB2_USDC)'s public API, through Tor, with a chart (day, week, month, year), what XBT is, and links to the community. Tap the balance to see it in US dollars.
- Contacts: saved addresses, such as exchange deposit addresses, to pick from Saved on the Send screen. After a send to a new address the app offers to save it.
- Frozen coins show with an ice-blue tint in the Coins list.
- Appearance: light, dark, or matching the iPhone; four skins, three of which open as the phone's wallets hold 0.1, 1 and 10 confirmed coins on mainnet; and three fonts (Atkinson Hyperlegible, San Francisco, IBM Plex).
- An app PIN that replaces the iPhone passcode as the fallback when Face ID doesn't work, for opening the app and signing, and stops trusting Face ID if a face is added. An optional duress PIN opens one decoy wallet and nothing else.
- An encrypted backup file of everything but secrets (wallets' details, labels, frozen coins, contacts, settings, the node's address), restored on a new iPhone before entering seed words.
- Address-poisoning checks: a recipient that looks like a contact, an address you've paid or one of your own without being it is flagged, with the differences marked, before you can send.
- Widgets for the Home Screen and the Lock Screen: the XBT price, with the day's change and chart, and a wallet's balance in BTC or sats. They show what the app last got through Tor, with the time, and never go online themselves. The balance can be kept out of them in Settings.
- Paperclip's [K210 Krux Hardware Wallet](https://shop.paperclip-xbt.xyz/product/k210-krux-hardware-wallet/): add a wallet from the key the Krux shows, or link one already on the phone (with the choice to take its seed words off the iPhone). Sends go to the Krux as BBQr codes or a microSD file (an unfinalized PSBT with unified ALL, `0x21`, on every input), and come back the same way. Crossbill checks every signature against the wallet's keys before sending. Settings, Hardware wallet has the guide and links. Only [Paperclip's Krux firmware](https://github.com/connorslab/krux-blake2b) works; standard Krux refuses unified signatures.

What it doesn't do (yet): other hardware wallets, multisig, PSBTs from other apps, payment codes, silent payments, Lightning addresses, managing channels (the dashboard does that), and connecting to anything but your own Knots and Lightning Fork nodes.

## What you need

- A Mac with Xcode installed (the full Xcode from the App Store, not only the command line tools).
- Homebrew, then Node.js and CocoaPods: `brew install node cocoapods`
- Your iPhone, a USB cable, and your Apple ID. A free Apple ID works, but the app stops opening after 7 days until you run it from Xcode again. A paid developer account ($99 a year) makes that a year.
- Your node's RPC details: the RPC onion address, port, user and password. The node needs `rpcauth` (or `rpcuser`/`rpcpassword`) in `bitcoin.conf`; a cookie file can't be read from a phone. On StartOS 0.4, the address is under Bitcoin Knots, Interfaces, RPC, in the Tor section (an `https://` onion address on port 443), and the user comes from the **Generate RPC User Credentials** action. On Umbrel and similar, it's with the Bitcoin Knots app's connection details.

## Build and install

`./setup.sh` runs all of this and sets your own bundle ID. To do it by hand, from this folder, in Terminal:

```sh
npm install
npm run ios:sync      # builds the app and runs pod install, which downloads the Tor library
npm run ios:open      # opens the project in Xcode
```

In Xcode:

1. Select the **App** project in the left sidebar, then the **App** target, then **Signing & Capabilities**. Tick **Automatically manage signing** and pick your Apple ID under **Team** (add it in Xcode Settings, Accounts, if it isn't listed). If Xcode says the bundle identifier is taken, change it to something of your own, such as `com.yourname.crossbill`. Then do the same for the **ShrikeWidgets** target, the widgets (the target keeps its old name; see [NOTICE](NOTICE)). Or close Xcode and run `npm run ios:widgets`, which gives the widgets the app's team and bundle ID.
2. Plug in your iPhone and choose it at the top of the window. The first time, the iPhone asks you to turn on **Developer Mode** (Settings, Privacy & Security) and restart.
3. Press **Run** (the play button). After the first install, open Settings on the iPhone, then General, VPN & Device Management, and trust your developer certificate.

Whenever the code changes, run `npm run ios:sync` again before pressing Run.

## First run

1. **Your node.** Mainnet, the RPC onion address, port, user and password. Pasting the full address fills in the port and the HTTPS switch: StartOS uses HTTPS on 443, a plain bitcoind uses HTTP on 8332. Tor starts inside the app; the first connection takes up to a minute.
2. **Your wallet.** Enter the seed words (and passphrase, if it has one). The app checks your node: if Shrike on your computer already watches this wallet, it says so and needs no scan. Otherwise choose the address type and when the wallet was created, and your node scans from that date.
3. Check the balance and the first receive address match Shrike on your computer before you rely on it.

If the app doesn't find your wallet on the node, check the derivation in Shrike on your computer (the wallet's Settings tab, Keystore, Derivation). This version supports the standard account 0 paths only: m/84'/0'/0', m/86'/0'/0', m/49'/0'/0' and m/44'/0'/0'.

## Before sending real money

- Send a small amount from the phone to an address of your own first, and check it in Shrike on your computer.
- Look at the review screen's replay status. It should read Replay protected once your node is past the activation height.
- Keep your seed words on paper. The phone is a second copy, not a backup.

## How it fits together

| Part | Where |
| --- | --- |
| Keys, addresses, descriptors | `src/core/keys.ts`, `script.ts`, `descriptor.ts` |
| Signature hashes (legacy, BIP143, BIP341, unified) | `src/core/sighash.ts` |
| Signing and the replay readback | `src/core/sign.ts`, `signer.ts` |
| Replay protection decision | `src/core/replay.ts`, ported from Shrike's `AppServices.chainDecision` |
| Coin selection, change, fees, replace by fee | `src/core/txbuilder.ts` |
| Knots RPC and Cormorant-compatible sync | `src/core/rpc.ts`, `sync.ts` |
| Labels (BIP329) | `src/core/labels.ts` |
| Two-factor codes and recovery codes | `src/core/totp.ts` |
| XBT price from Neoxa Exchange | `src/core/price.ts` |
| Light and dark, skins, fonts | `src/app/look.ts`, `src/ui/styles.css` |
| Community links, donation address | `src/app/links.ts` |
| App PIN and duress PIN | `src/core/pin.ts`; the PIN section of `src/app/model.ts`; `src/ui/Pin.tsx` |
| Backup file | `src/core/backup.ts` (encryption), `src/app/backup.ts` (contents), `src/ui/Backup.tsx` |
| Address-poisoning checks | `src/core/poison.ts` |
| PSBTs for the Krux, and its signatures read back | `src/core/psbt.ts` |
| BBQr codes, and the Krux's other replies | `src/core/qrtransfer.ts` |
| Reading the Krux's key | `src/core/hwkey.ts` |
| Krux screens: adding, linking, signing, Settings page | `src/ui/Krux.tsx`; the Krux section of `src/app/model.ts` |
| What the widgets show | `src/app/widgets.ts`, written for them by `ShrikeNativePlugin.swift` |
| The widgets themselves (SwiftUI) | `ios/App/ShrikeWidgets` |
| Adding the widgets to the Xcode project | `scripts/ios-widgets.mjs` |
| Lightning Fork's mobile API: pairing codes, the ways to the node, the calls | `src/core/lfapi.ts` |
| Lightning in the app: pairing, approval, payments written down before they're sent | `src/app/lightning.ts`; screens in `src/ui/Lightning.tsx` |
| HTTPS pinned to the node's root certificate, Wi-Fi or cellular | `plugins/shrike-native/ios/Sources/PinnedTrust.swift` |
| A pretend Lightning Fork dashboard, for tests and the browser | `tools/lf-mock` |
| App model and screens | `src/app`, `src/ui` |
| The StartOS build: which build this is, and the browser's stand-in for the native plugin | `src/app/target.ts`, `src/app/server-native.ts`, `src/app/server-api.ts` |
| The StartOS server: sign-in, the app's files, and the way to the node and Lightning Fork | `server/` ([docs/server.md](docs/server.md)) |
| Native: Tor, Keychain, Face ID, QR scanner | `plugins/shrike-native/ios/Sources` (`TorService.swift` also reopens Tor's local port when iOS takes it back; `QrScanner.swift` stays open for animated codes) |

## Tests

```sh
npm test
```

- `tests/core-vectors.test.ts` checks keys, descriptors, addresses and 64 fully signed transactions byte for byte against output from Shrike's own Java library (drongo), for all four address types, with and without the unified signature hash and a passphrase. It also runs the 166 reference vectors for the unified signature hash that ship with drongo.
- `tests/core-logic.test.ts` covers coin selection, fees, the replay decision, v2 headers, addresses, labels and the signature readback.
- `tests/features.test.ts` checks the two-factor codes against the RFC 6238 and RFC 4226 test vectors, recovery codes, reading Neoxa's price data, and the skin thresholds.
- `tests/twofactor-model.test.ts` covers the two-factor checks in the app model: codes used once, recovery codes, the lockout, and the Keychain deciding whether two-factor is on.
- `tests/security.test.ts` checks the app PIN's rules and hashing, the backup file (round trip, wrong password, tampering, refusing costly headers) and the look-alike address rules. `tests/security-model.test.ts` covers the PIN standing in for the passcode, Face ID changes, the duress session showing nothing of the hidden wallets, backups and restoring them, and the recipient checks.
- `tests/widgets.test.ts` checks what the widgets are handed, the short amounts on the round Lock Screen widget, the widgets' colors against the stylesheet, and the script that adds them to the Xcode project, on a project with someone's own bundle ID and team. `tests/widgets-model.test.ts` covers the app handing them a snapshot only when something on it changed, fetching the price for a price widget, the balance setting and the links a widget opens.
- `tests/lightning.test.ts` covers Lightning against a pretend dashboard: reading pairing codes, the order the ways to the node are tried, pairing at home (pinning the root the code names) and away, refusing a server with another certificate, payments needing the code and Face ID, the own-bridge and service paths for SHA256 invoices, and payments whose answer was lost (behind a proxy's error, across a dashboard restart, after pairing again, or a double tap), each asked about with its request ID and never paid twice.
- `tests/price-flow.test.ts` covers getting the price after iOS took back Tor's port, retries on new routes, a stuck Tor, going without Tor once, and resending a request the dead port refused.
- `tests/krux.test.ts` checks the PSBT Crossbill hands the Krux for all four address types, BBQr codes (sizes, any order, the Krux's other replies), reading the Krux's key, and refusing a signature that isn't `0x21`, doesn't verify, or is for another transaction. `tests/krux-model.test.ts` covers linking (keeping or removing the seed words), sends signed on the Krux with no Face ID or code, the waiting send across a lock and never in a duress session, and backups.
- With `KRUX_SRC` and `KRUX_UUR` set, `tests/krux.test.ts` also hands Crossbill's PSBTs to Paperclip's own signing code, through [tools/krux-check](tools/krux-check/README.md): by QR at each code density and by microSD, for all four address types, with change shown as change. `tests/krux.e2e.test.ts` adds `KNOTS_BIN` and has a regtest node accept and mine what it signed.
- `tests/server.test.ts` covers the StartOS server: the password made at first start, sessions a page on another site can't use, signing everyone out when the password changes, the app's files and a vault that refuses seed words, passing on only the RPC calls the app makes with the password only the server holds (or the node's cookie file, read for every call), Lightning through StartOS or Tor with payments refused (in a way the app knows moved nothing) until turned on, and the price from Neoxa Exchange only. `tests/server-model.test.ts` runs the app model as the StartOS page against that server.
- `tests/regtest.e2e.test.ts` runs the whole core against a real Bitcoin Knots `v29.4.1.knots20260508` node in regtest, with the fork activating at height 20: it checks the opt-in is declined before activation and taken after, that the node accepts sends from all four address types, that a forged `0x21` is refused, that fee bumping replaces the original, and that a spent coin is never offered again. Point it at a build of that Knots tag: `KNOTS_BIN=/path/to/knots/build/bin npm test`.

`tools/vectorgen` holds the Java program that produced the reference vectors from Shrike's own library.

### On GitHub

`.github/workflows/ci.yml` runs on every push and pull request:

- **Type check and tests** on Linux.
- **Paperclip's Krux signing code:** `scripts/ci/krux-setup.sh` fetches the firmware at its release commit (v26.09.0-xbt.2) and the UR library, then `tests/krux.test.ts` runs against them.
- **The iOS app, unsigned,** on a macOS runner: `scripts/build-ios-unsigned.sh` compiles the app, the native plugin and the widgets, so Swift that doesn't compile shows up here. The .ipa it makes is kept for 14 days with the run.
- **Weekly, or when started by hand:** the regtest suites, against Bitcoin Knots built from source by `scripts/ci/knots-build.sh` (cached after the first build).

`.github/workflows/release.yml` runs when a release is published. It builds `Crossbill-<version>-unsigned.ipa` from the release's tag, attests its provenance and attaches it, with its SHA-256, to the release. Nothing in it is signed, so it holds no certificate, team or name. [TESTERS.md](TESTERS.md) explains installing it.

Actions are pinned to full commits. The workflows use only `GITHUB_TOKEN`; no secrets are stored.

## Trying it in a browser

`DEV_RPC_TARGET=http://127.0.0.1:18443 npm run dev` serves the app on your Mac against a local regtest node, with Tor off. The browser version keeps seed words in memory only and exists for testing screens; don't use it with real funds. Prices come straight from Neoxa Exchange there, or from `DEV_PRICE_TARGET` if set. To see the Market tab's reconnect steps without a phone, set `localStorage['shrike.devTor']` to `dead-port`, `no-route` or `stuck`, reload, and run `__shrike.torAvailable = true` in the console. To see Settings, Widgets with widgets on screen, set `localStorage['shrike.devWidgets']` to a list such as `["ShrikePrice:systemSmall"]`; what the app would hand the widgets is kept in `localStorage['shrike.widgetSnapshot']`. For the app PIN, `localStorage['shrike.devFaceId']` set to `fail` makes Face ID fail, and `changed` acts as if a face was added; `__shrike.locked = true; __shrike['emit']()` shows the lock screen. For the Krux, scanning a key asks for its text; scanning the Krux's signed codes reads them from `localStorage['shrike.devScan']`, a JSON list, as if they came off its screen. For Lightning, run `node tools/lf-mock/server.ts` beside `npm run dev` (Node 22.18 or later): it prints a pairing code to paste in Settings, Lightning, and `http://127.0.0.1:18480/__mock/sample?kind=sha256&amount=1250` makes an invoice to pay (`kind=xbt`, `offer` or `address` for the others). `LF_MOCK_BRIDGE=service` pays SHA256 invoices through a pretend service instead of your own bridge. `localStorage['shrike.devLf']` set to `away` acts as if the iPhone were on cellular (run `__shrike.torAvailable = true` too), and `home-only` or `down` as if the onion, or everything, were unreachable.

## Crossbill on StartOS

The same screens, served from your own StartOS server to a browser: watch-only, signed on a Krux, with the node's password kept on the server and Lightning payments off until you turn them on. It isn't packaged for StartOS yet. [docs/server.md](docs/server.md) explains how it differs from the iPhone app and how to try it from a Mac against your own node. `npm run build:server` builds its screens into `dist-server`, and `npm run server` starts it.

## What's next

[docs/multi-server.md](docs/multi-server.md) scopes choosing between several servers, each with its own wallets, after Face ID. It isn't built yet.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm test` and say what you tried on a real iPhone. Anything that changes signing, the replay decision or coin selection needs a test that shows the change, like the ones in `tests/`.

Please don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).
