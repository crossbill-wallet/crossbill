# Changes

## Unreleased

New:

- **Crossbill on StartOS, the server** (not packaged yet). The same screens, served from your own server to a browser. Watch-only: the server never holds seed words, and every send is signed on a Krux. One password signs in; the server makes it at first start. The node's RPC password stays on the server, which passes on only the calls the app makes. Lightning works through StartOS or Tor, with payments refused by the server until they're turned on for it. See [docs/server.md](docs/server.md).

Changed:

- The server can sign in to the node with its RPC cookie file (`CROSSBILL_RPC_COOKIE_FILE`), read again for each call, as the StartOS package does.
- `npm run build:server` builds the StartOS version's screens into `dist-server`, `npm run server` starts the server, and CI builds both. The iPhone build is unchanged: it carries none of the StartOS code.

## 0.4.1

New:

- **Lightning, through your own Lightning Fork node.** Pair Crossbill with the dashboard of [Lightning Fork](https://github.com/paulscode/lightning-fork), Paul Lamb's Lightning node for the BLAKE2b chain, and a **Lightning** tab appears between Market and Contacts. Your node holds the money and the keys. Crossbill holds a key to the dashboard, which you can remove there at any time.
- **Pairing.** In the dashboard's menu, choose **Mobile app**, then **Pair a phone**, and scan the code from Settings, Lightning in Crossbill. At home Crossbill reaches the node on your network over HTTPS, and trusts only the root certificate whose fingerprint the code carries. Away from home it uses the dashboard's onion address through Crossbill's own Tor.
- **Send:**
  - Lightning invoices and offers (BOLT 11 and BOLT 12) on this chain.
  - Invoices on the SHA256 chain, such as a shop's, through your node's bridge setup.
  - On-chain sends from your node's wallet, with its fee rates.
- **SHA256 invoices.** With your own bridge, the bridge's SHA256 node pays the invoice with BTC: no swap, no fee, and no XBT spent. Through a bridge service, Crossbill shows the price in XBT as soon as the invoice is read, with how long the price holds. A price that went up is shown again before anything is paid.
- **Receive.** An invoice with a QR code, which says when it's paid; a reusable offer; or an on-chain address of your node's wallet.
- **Balances and activity.** What your channels can send, the node's on-chain balance, and its payments, with the proof of payment for each.
- **Approval.** Every payment needs Face ID (or the app PIN), and the two-factor code when two-factor is on, as a send from the wallet does. Lightning needs a passcode on the iPhone.
- **Never paid twice.** Each payment is written down before it's sent and carries a request ID. If the answer is lost, Crossbill asks your node about that same request rather than sending a new one, even after the app was closed.
- **The duress PIN** opens a session without Lightning.
- [docs/own-bridge.md](docs/own-bridge.md) walks through running your own bridge on StartOS, so your node pays SHA256 invoices itself.

Changed:

- The native plugin can make HTTPS requests pinned to one root certificate, refuses redirects for them, and tells Wi-Fi from cellular.
- Backups don't include the Lightning pairing. After restoring, pair again from the dashboard.
- `npm run dev` can show the Lightning screens against a pretend dashboard, `node tools/lf-mock/server.ts`. Nothing in it is real.

## 0.4.0

**Shrike for iPhone is now Crossbill.** The community encouraged a name of its own, so the app isn't mistaken for part of the Shrike project, which it isn't. The new name comes with a new logo, a red low-poly crossbill in front of a shield, on the app icon, the launch screen, the lock and welcome screens and the price widget.

- On your iPhone it updates in place: same wallets, settings, PIN and seed words. Your 0.3.0 backup files still restore.
- The app shows Crossbill everywhere, including Face ID prompts, the widget gallery and backup file names (`crossbill-backup-<date>.json`). The skins are named for crossbills: Crossbill, Red, White-winged and Gilded. The one you chose stays chosen.
- An authenticator entry added for two-factor before 0.4.0 is still called Shrike in your authenticator app. The codes don't change; rename it there if you like.
- Widget taps use the `crossbill://` link scheme.
- The code moved to [github.com/crossbill-wallet/crossbill](https://github.com/crossbill-wallet/crossbill). Old links to the previous address forward there.
- Builders: the generic bundle ID in the repository is now `io.github.crossbill-wallet.app`. Your own bundle ID is unchanged.
- Code that only the app sees keeps some old names, such as `ShrikeNative` and the `ShrikeWidgets` target, so nothing on your phone has to move. [NOTICE](NOTICE) lists them.

New:

- **Paperclip's Krux hardware wallet.** Crossbill now works with the K210 Krux Hardware Wallet, Paperclip's air-gapped signer for Bitcoin (XBT). The seed words stay on the Krux. Crossbill builds each send, the Krux shows where it goes and signs it, and Crossbill sends it through your node. Only Paperclip's firmware works: standard Krux refuses unified signatures.
- **Three ways to set it up.**
  - **On first launch:** after connecting your node, choose **Use my Krux** and scan the key the Krux shows (Extended Public Key, ZPUB or XPUB QR code), or open the .pub file it saves to microSD.
  - **For a wallet already on the phone:** Settings, Wallets, the wallet, **Sign with a Krux**. You type its seed words on the Krux; Crossbill checks the Krux's key is the wallet's, then asks whether to take the seed words off this iPhone (suggested) or keep them so either can sign.
  - **As a new wallet beside your others:** Add a wallet, **Use my Krux**. The phone keeps the public key only.
- **Signing on the Krux.** Review has **Sign on your Krux**. Crossbill shows the transaction as BBQr codes for the Krux's camera, or saves it for a microSD card. Once the Krux signs, scan its codes or open its signed file. Crossbill checks each signature against the wallet's own keys, and that each is a unified (replay-protected) signature, before offering **Send**. No Face ID or two-factor code is asked: approving on the Krux is the check. Fee raises and cancels work the same way.
- **The screen stays awake** while the Krux reads codes off it. If the app locks partway through, it opens back on the waiting send.
- **Settings, Hardware wallet**: setting up, sending, checking a receive address on the Krux, what its warnings mean, and links to the Paperclip store, the product page, the firmware and its update guide, Krux, and Connor's Lab, who makes Paperclip's firmware.
- **Receive** says how to check an address on the Krux (Address, Scan Address) for wallets it signs.
- **Backups** keep how each wallet is signed. A wallet that signs only on the Krux comes back by scanning its key, with no seed words.

Changed:

- A wallet that signs only on the Krux has no seed words to show or open with a passphrase. Typing its seed words in Add a wallet puts them back on this iPhone.
- Adds `pako` for BBQr's compression. After updating, run `npm install` before `npm run ios:sync`.
- The QR scanner can stay open for the Krux's animated codes, showing how many it has read.
- **GitHub Actions.** Every push runs the type check and tests, the tests against Paperclip's Krux signing code, and an unsigned build of the whole iOS app, so Swift that doesn't compile is caught on GitHub. The regtest suites run weekly against Bitcoin Knots built from source.
- **Test builds.** Publishing a release builds an unsigned `.ipa` from its tag on GitHub and attaches it with its SHA-256 and a build provenance attestation. Testers sign it with their own Apple Account; see [TESTERS.md](TESTERS.md). It holds no certificate, team or name.
- The Xcode project now shares its **App** scheme, which builds on GitHub need.

## 0.3.0

New:

- **App PIN.** Six digits for Shrike alone, in Settings, App PIN. With it on, Shrike opens with Face ID only: when Face ID doesn't work, it asks for the PIN instead of the iPhone passcode, both to open the app and before reading seed words to sign. Someone who has seen your passcode still can't open your wallets. Wrong PINs make the next try wait longer each time.
- **Face ID changes are caught.** Anyone who knows the passcode can add a face to Face ID. If the faces Face ID accepts change after the PIN is set, Shrike stops opening with Face ID alone and asks for the PIN until you confirm in Settings, App PIN that the change was yours.
- **Duress PIN.** Optional, beside the app PIN. If someone forces you to open Shrike, cancel Face ID and type the duress PIN: Shrike opens showing one wallet you choose and nothing that says others exist. The App PIN screen looks and acts as usual in that session, and nothing about it is saved. Setting one moves the Balance widget to that wallet, so the Home Screen matches.
- **Backup file.** Settings, Backup saves one file with everything but secrets: wallet names and details, labels, frozen coins, contacts, settings and your node's address, encrypted with a password you choose (scrypt and XChaCha20-Poly1305). Restore it on a new iPhone from the welcome screen, or in Settings to add what's missing. Wallets come back with their labels once you enter their seed words. Seed words, the node's password, the two-factor key and the app PIN are never in it.
- **Address-poisoning checks.** When you pay an address that matches one you know at the start and the end without being the same (a saved contact, an address you've paid, one of your own), Send says so under the address, and Review shows both side by side with the differences marked and won't send until you confirm you've checked every character. Review also says when you haven't paid an address before. A tiny payment from someone else is marked on its transaction screen, with a button to freeze the coin.

Changed:

- Adds `@noble/ciphers` for the backup file's encryption. After updating, run `npm install` before `npm run ios:sync`.

## 0.2.2

New:

- **Widgets for the Home Screen and the Lock Screen.** Two of them:
  - **XBT price:** the last price from Neoxa Exchange, the 24-hour change, and on the Home Screen the day's chart.
  - **Balance:** a wallet's balance in BTC or sats, whichever the app is set to, with its worth in US dollars on mainnet.
- Each comes as a small square or a wide rectangle on the Home Screen, and as a round or a rectangular widget on the Lock Screen. The price widget looks like the Market tab's price card, in light or dark. The balance widget looks like the Wallet tab's band, in the skin you picked.
- Widgets can't run Tor, so they never go online themselves. They show what Shrike last got through Tor, with the time it got it, and change whenever Shrike is open: it fetches the price for a price widget when it opens and every five minutes while it stays open. A price over an hour old is shown dimmed.
- **Settings, Widgets** shows what the widgets have now and which ones are on your screens. Choose which wallet the Balance widget shows, or keep the balance out of the widgets altogether.
- Tapping a widget opens Shrike on the Market or Wallet tab.

Changed:

- `npm run ios:sync` also runs `scripts/ios-widgets.mjs`, which adds the widget extension to the Xcode project the first time and keeps its bundle ID, team and version matched to the app's. The app and the widgets share an App Group named after the app's bundle ID. Nothing else in the project file changes.
- The app registers the `shrike://` link scheme, for widget taps. It opens the Market or Wallet tab and nothing else.

After updating from 0.2.1, run `npm install` and `npm run ios:sync`, then in Xcode check that the new **ShrikeWidgets** target has your team under Signing & Capabilities.

## 0.2.1

Fixed:

- **Reconnecting after time in the background.** After about ten minutes in the background, iOS takes back the local port the app's Tor client listens on (Apple Technote 2277), and connections to it are then refused. Tor didn't notice, and the app's recovery step kept the dead port, so the price on the Market tab, and sometimes the wallet's node connection, stayed broken until the app was closed. The app now checks that port whenever it comes back and, if iOS took it, has Tor open a fresh one on another port. A send that the dead port refused never left the phone, so it's now sent again by itself.

Changed:

- **The Market tab shows its progress while reconnecting:** checking Tor on the phone, reopening its connection, opening a route through Tor, and asking Neoxa Exchange, each ticking off as it happens. A failed request is tried twice more, on new routes through Tor.
- **When it still can't get the price,** the Market tab says what went wrong and what to do, keeps the last price on screen dimmed, and tries again by itself after 15 seconds, then 30, 60 and every two minutes, with a countdown. **Try again now** shows the steps running again. **Get it once without Tor** fetches the price directly, once, when Tor is the problem.
- If Tor on the phone can't be reattached at all, the app says so plainly: close Shrike and open it again.
- The chart reloads by itself once the price comes back.

## 0.2.0

New:

- **Tab bar.** Wallet, Market, Contacts and Settings along the bottom of the main screens. Settings moved here from the gear on the Wallet tab, and opens to a shorter list with Appearance, Two-factor, Block explorer and Replay protection on their own screens.
- **Two-factor.** A 6-digit code from any authenticator app before every send, fee raise and cancel, before showing seed words, and to turn two-factor off. Offered once after setup, with Skip, and any time in Settings. Eight one-time recovery codes. Five wrong codes in a row make the next try wait, longer each time.
- **Market tab.** The XBT/USDC price from Neoxa Exchange's public API, fetched through Tor, with the 24-hour change, range and volume, a chart over a day, week, month or year, a short explainer on XBT, and links to the Knots Discord and Telegram, the code, and guides.
- **Balance in US dollars.** Tap the balance on the Wallet tab to switch between coins and dollars.
- **Contacts.** Saved addresses, such as exchange deposit addresses. Pick one from Saved on the Send screen. After a send to a new address, the app offers to save it.
- **Ice-blue frozen coins** in the Coins list, with a Frozen pill and a note in the coin's sheet.
- **Appearance.** Light, dark, or match the iPhone. Four skins named for shrikes: Shrike, and Red-backed, Northern and Gilded, which open as the phone's wallets hold 0.1, 1 and 10 confirmed coins on mainnet and then stay open. Three fonts: Atkinson Hyperlegible, San Francisco and IBM Plex.
- **Lock screen.** The bird stays on screen a moment longer before Face ID, carrying on from the launch screen.
- **Donate** in Settings, when the build has a donation address.

Changed:

- The Wallet tab remembers whether Activity, Coins or Addresses was open.
- The app version shown in iOS matches the release (0.2.0).

Scoped, not built: choosing between several servers after Face ID. See [docs/multi-server.md](docs/multi-server.md).

After updating from 0.1.0, run `npm install` before `npm run ios:sync`: this version adds the IBM Plex fonts.

## 0.1.0

First release.
