# Shrike for iPhone

A personal iPhone build of the [Shrike](https://shrikewallet.com/) wallet: the unofficial Sparrow fork that follows Bitcoin's change of proof of work to BLAKE2b and signs with the unified opt-in signature hash. It talks only to your own Bitcoin Knots node, over Tor, and keeps your seed words in the iPhone Keychain behind Face ID.

Unofficial: not affiliated with or endorsed by the Shrike, Sparrow or Bitcoin Knots projects.

Not audited. Use at your own risk, under the same Apache 2.0 terms as Shrike (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Start with a small amount.

**New here? Start with [GETTING-STARTED.md](GETTING-STARTED.md).** It goes from a new Mac to a working wallet on your iPhone, and `./setup.sh` does most of the work.

## What it does

- Holds one or more seed-word wallets (Native Segwit, Taproot, Nested Segwit or Legacy), with an optional passphrase. A wallet's settings can open the same seed words with a passphrase as a second wallet.
- Finds a wallet you already use in Shrike on your computer on your node, with no rescan. It uses the same `cormorant` watch-only wallet and the same descriptors the desktop app imports, so both apps keep working side by side.
- Receive with QR codes and labels. Send to one or more recipients, with fee rates from your node, Max, coin control, and a My wallets button that fills in the next address of another wallet on the phone.
- Signs with the unified signature hash (hash type `0x21`) whenever the desktop app would: when the chain tip carries a v2 header and the activation height built into the app agrees with the one your node reports. The send and review screens say whether a transaction is replay protected, and why not when it isn't.
- Raise the fee on, or cancel, an unconfirmed send (replace by fee).
- Labels and frozen coins, imported and exported as BIP329 files, the same format as Shrike's Export Labels and Import Labels.
- Face ID to open the app and to sign. The seed is read from the Keychain only for the moment of signing. Screens showing seed words warn if a screenshot is taken.
- Transaction pages link to a block explorer: mempool.guide by default, as in desktop Shrike, or your own, or none. Onion explorers open in Onion Browser.

What it doesn't do (yet): hardware wallets, multisig, PSBT import or export, payment codes, silent payments, and connecting to anything but your own Knots node.

- [Shrike for iPhone](https://github.com/finchly6819/shrike-mobile-wallet) - An iPhone wallet that connects only to your own Knots node over Tor, finds wallets you already use in Shrike with no rescan, and signs with the unified sighash. New, unaudited, built yourself with Xcode.

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

1. Select the **App** project in the left sidebar, then the **App** target, then **Signing & Capabilities**. Tick **Automatically manage signing** and pick your Apple ID under **Team** (add it in Xcode Settings, Accounts, if it isn't listed). If Xcode says the bundle identifier is taken, change it to something of your own, such as `com.yourname.shrike`.
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
| App model and screens | `src/app`, `src/ui` |
| Native: Tor, Keychain, Face ID, QR scanner | `plugins/shrike-native/ios/Sources` |

## Tests

```sh
npm test
```

- `tests/core-vectors.test.ts` checks keys, descriptors, addresses and 64 fully signed transactions byte for byte against output from Shrike's own Java library (drongo), for all four address types, with and without the unified signature hash and a passphrase. It also runs the 166 reference vectors for the unified signature hash that ship with drongo.
- `tests/core-logic.test.ts` covers coin selection, fees, the replay decision, v2 headers, addresses, labels and the signature readback.
- `tests/regtest.e2e.test.ts` runs the whole core against a real Bitcoin Knots `v29.4.1.knots20260508` node in regtest, with the fork activating at height 20: it checks the opt-in is declined before activation and taken after, that the node accepts sends from all four address types, that a forged `0x21` is refused, that fee bumping replaces the original, and that a spent coin is never offered again. Point it at a build of that Knots tag: `KNOTS_BIN=/path/to/knots/build/bin npm test`.

`tools/vectorgen` holds the Java program that produced the reference vectors from Shrike's own library.

## Trying it in a browser

`DEV_RPC_TARGET=http://127.0.0.1:18443 npm run dev` serves the app on your Mac against a local regtest node, with Tor off. The browser version keeps seed words in memory only and exists for testing screens; don't use it with real funds.

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm test` and say what you tried on a real iPhone. Anything that changes signing, the replay decision or coin selection needs a test that shows the change, like the ones in `tests/`.

Please don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).
