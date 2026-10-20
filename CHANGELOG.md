# Changes

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
