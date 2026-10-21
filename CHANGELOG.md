# Changes

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
