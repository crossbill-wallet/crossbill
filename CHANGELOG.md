# Changes

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
