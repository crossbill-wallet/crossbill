# Crossbill on StartOS: the server

The same Crossbill screens, served from your own server to any browser, for StartOS node runners who'd rather not install an iPhone app, or who want their wallet on a computer too. The StartOS package, [crossbill-startos](https://github.com/crossbill-wallet/crossbill-startos), runs it as a service on your server, beside Bitcoin Knots and Lightning Fork: its Instructions tab in StartOS walks through setting it up. This page covers the server itself, and trying it from a Mac against your own node.

## How it differs from the iPhone app

- **Watch-only.** The server never holds seed words: it refuses to store them, and there's no screen to enter them. Wallets are added from a Krux's key and every send is signed on the Krux, by its QR codes or by microSD file.
- **Signing in.** One password opens Crossbill on the server. At first start the server makes one at random, prints it in its log and leaves it in `initial-password.txt` in its data folder; on StartOS, the package's **Set Password** action makes it instead, before the first start. `npm run server -- set-password` changes it and signs out every session. There's no Face ID, app PIN or duress PIN.
- **Two-factor asks for its code as on the iPhone, but the page checks it,** and the server hands the page its key once signed in. So it guards against a slip, not against someone who has the password: on the server, the password is what keeps others out.
- **The node is set on the server,** not in the page: the server reaches Bitcoin Knots with an RPC password the page never sees, and passes on only the RPC calls the app makes, to the node and its `cormorant` wallet.
- **Lightning payments are off until you turn them on** for the server (`npm run server -- lightning-payments on`, or `CROSSBILL_LIGHTNING_PAYMENTS=on`). Off, Crossbill still pairs with Lightning Fork, shows balances and activity, and makes invoices, offers and addresses; a payment is refused by the server before it reaches the node, and the page says why. Lightning Fork's pairing key can pay, so this is how the server keeps a signed-in page from paying until you've decided it may.
- **The server reaches Lightning Fork through StartOS** (or the dashboard's onion through Tor), never through its home address.
- **Scanning a QR code** uses the camera of the device the page is open on, a phone or a computer. Browsers allow the camera only on a secure address: the `https://` one StartOS gives the interface, an onion in Tor Browser, or `127.0.0.1` on a Mac. The scanner also opens a picture of a code (a screenshot, when the code is on the same screen) and takes a code's text pasted in.
- **No widgets, no notifications, no Tor in the page.** The price comes through the server, and through Tor only when the server has a Tor proxy.

## Settings

The server reads these environment variables:

| Variable | What it is |
| --- | --- |
| `CROSSBILL_RPC_URL` | Bitcoin Knots' RPC address, such as `http://10.0.3.1:8332`, or its onion: `https://….onion` (needs `CROSSBILL_TOR_SOCKS`). Required |
| `CROSSBILL_RPC_USER`, `CROSSBILL_RPC_PASSWORD` | The RPC user and password. `CROSSBILL_RPC_PASSWORD_FILE` reads the password from a file instead |
| `CROSSBILL_RPC_COOKIE_FILE` | Bitcoin's RPC cookie file, read again for every call since the node writes a new one each time it starts. Set, it takes the place of the user and password. On StartOS the package mounts the node's data read-only and points this at its `.cookie` |
| `CROSSBILL_RPC_CA_FILE` | For an `https` RPC address that isn't an onion: the root certificate to trust, and no other (a StartOS server's root) |
| `CROSSBILL_NETWORK` | `mainnet` (the default), `testnet4` or `regtest` |
| `CROSSBILL_LF_URL` | Lightning Fork's dashboard, as the server reaches it. Unset: only the onion in the pairing code, through Tor |
| `CROSSBILL_LF_CA_FILE` | As `CROSSBILL_RPC_CA_FILE`, for an `https` dashboard address |
| `CROSSBILL_LIGHTNING_PAYMENTS` | `on` or `off`. Set, it overrides the setting `lightning-payments` keeps |
| `CROSSBILL_TOR_SOCKS` | A Tor SOCKS proxy, `host:port`, for onion addresses and the price through Tor |
| `CROSSBILL_HOST`, `CROSSBILL_PORT` | Where the page is served: `0.0.0.0` and `8080` by default |
| `CROSSBILL_DATA_DIR` | The data folder: `./data` by default |
| `CROSSBILL_STATIC_DIR` | The built screens: `dist-server` by default |
| `CROSSBILL_RPC_EXTRA_METHODS` | RPC methods to allow besides the app's own, comma separated. Normally unset |

The data folder holds the app's files (`app/`), the vault (two-factor and the Lightning key, never seed words), the password's hash, and the server's own settings. Back it up as you would the iPhone's backup file.

## Trying it from your Mac against your own node

This reaches your node the way the iPhone app does: Bitcoin Knots' RPC onion, through Tor on the Mac.

1. **Node.js 22.18 or later.** `node -v` says which you have; `brew upgrade node` if it's older.
2. **Tor on the Mac:** `brew install tor`, then `brew services start tor`. Its proxy listens on `127.0.0.1:9050`.
3. **Build the screens,** from this folder: `npm install`, then `npm run build:server`.
4. **The node's details,** the same ones the iPhone app uses: on StartOS, Bitcoin Knots, **Interfaces**, **RPC**, the onion address in the Tor section, and the user and password from the **Generate RPC User Credentials** action.
5. **Start the server,** with your own values in place of the examples:

   ```sh
   CROSSBILL_RPC_URL=https://youronionaddress.onion \
   CROSSBILL_RPC_USER=crossbill \
   CROSSBILL_RPC_PASSWORD='the RPC password' \
   CROSSBILL_TOR_SOCKS=127.0.0.1:9050 \
   CROSSBILL_HOST=127.0.0.1 \
   npm run server
   ```

   It prints the password to sign in with. `CROSSBILL_HOST=127.0.0.1` keeps the page on this Mac only.
6. **Open** http://127.0.0.1:8080 in a browser and sign in. Crossbill connects to your node through Tor; the first time takes up to a minute.
7. **Add your Krux wallet:** on the Krux, save its key to microSD (or show its QR code), then choose **Open the key file from microSD** (or **Scan the Krux's key** and hold its code up to the camera). Check the balance and the first receive address match the iPhone app.
8. **A small send:** build it, choose **Save for microSD**, sign it on the Krux (**Load from SD card**, **Sign to SD card**), and open the signed file back in Crossbill. The Krux's QR codes work too, through the camera, both ways. Check it in the iPhone app, or Shrike on your computer.
9. **Lightning, if you want to try it:** in the Lightning Fork dashboard, **Mobile app**, **Pair a phone**, then in Crossbill's Settings, **Lightning**, choose **Scan**. With the dashboard on this same screen, take a screenshot of the code and open it with **Open a picture of the code**; or open Crossbill on your phone's browser and scan it there. The dashboard lists the pairing as **Crossbill on StartOS**: remove it there when you're done. Payments stay off unless you also run `npm run server -- lightning-payments on` from this folder, in another Terminal window; it takes effect straight away.

When you're done, stop the server with Control-C. Everything it kept is in `./data`; delete that folder to start over.

## Trying it without a node

The tests run the server against a pretend node and the pretend Lightning Fork dashboard: `npx vitest run tests/server.test.ts tests/server-model.test.ts`. For the screens against the pretend dashboard, run `node tools/lf-mock/server.ts`, start the server with `CROSSBILL_LF_URL=http://127.0.0.1:18480` (and any RPC address: without a node the page says it can't connect), then pair with the code the pretend dashboard prints.

## Developing the screens

`npm run dev -- --mode server` serves the StartOS build with live reloading on http://127.0.0.1:5173, and forwards the API and the sign-in page to a server started with `npm run server` (or the one in `DEV_SERVER_TARGET`). Sign in at http://127.0.0.1:5173/login.

## The image

`docker build -f server/Dockerfile -t crossbill-server .` builds an image with the server and its screens and nothing else at run time: the server uses Node.js alone. It serves on port 8080 and keeps its data in `/data`.

## Not done yet

- A way to sign out from the page.
