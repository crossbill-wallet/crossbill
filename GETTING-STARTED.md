# Getting started with Shrike for iPhone

This folder holds everything needed to put Shrike for iPhone on your own iPhone: a Bitcoin wallet for the BLAKE2b chain that talks only to your own Bitcoin Knots node, over Tor, and keeps seed words in the iPhone Keychain behind Face ID. It works alongside [Shrike](https://shrikewallet.com/) on a computer and finds wallets you already use there.

**It hasn't been audited.** Use small amounts until you trust it, and keep your seed words on paper.

Plan on about an hour the first time, most of it waiting for downloads.

## What you need

- **A Mac** with enough free space for Xcode (it's a large download).
- **An iPhone** with a passcode and Face ID or Touch ID, and a cable to connect it to the Mac.
- **An Apple ID.** A free one works, but the app stops opening after 7 days until you install it again from the Mac (see [Keeping it running](#keeping-it-running)). A paid Apple Developer account, 99 USD a year, makes that a year.
- **A Bitcoin Knots node that follows the BLAKE2b chain,** reachable over Tor, with an RPC user and password. Step 5 shows how on StartOS.
- **Seed words** for a wallet you already use in Shrike, or nothing, and the app makes a new wallet.

## Step 1: Install Xcode

1. Open the **App Store** on the Mac, search for **Xcode**, and install it.
2. Open Xcode once. Accept the license, and if it asks which platforms to install, include **iOS**. You don't need to wait for the simulators to finish downloading.
3. Quit Xcode.

## Step 2: Run the setup script

If you're reading this on GitHub, get the folder first: click the green **Code** button, then **Download ZIP**, and double-click the zip in your Downloads folder.

1. Open **Terminal** (in Applications, Utilities).
2. Type `cd ` (with a space after it), drag this folder from Finder onto the Terminal window, and press Return.
3. Type `./setup.sh` and press Return. If Terminal says permission denied, type `bash setup.sh` instead.

The script checks Xcode, installs Node.js and CocoaPods if they're missing (through Homebrew, which asks for your Mac password once), builds the app, downloads the Tor library and opens the project in Xcode.

Partway through it asks for a **bundle ID**: the name Apple knows the app by. Type something that's yours, such as `com.yourname.shrike`, using only letters, numbers, dots and dashes.

If the script stops with a message, it says what to do. Follow it and run `./setup.sh` again.

## Step 3: Sign the app in Xcode

1. If Xcode offers to **Update to recommended settings**, choose **Cancel**.
2. Open **Xcode, Settings, Accounts**, click **+**, and sign in with your Apple ID.
3. In the left sidebar, click **App** (the blue icon at the top). Under Targets, click **App**, then the **Signing & Capabilities** tab.
4. Tick **Automatically manage signing** and choose your Apple ID under **Team** (it says Personal Team for a free account).

Red errors such as "Your team has no devices" or "No profiles for ..." are normal at this point. They clear once your iPhone is connected in step 4.

## Step 4: Put it on your iPhone

1. Connect the iPhone and unlock it. If it asks **Trust This Computer?**, tap Trust.
2. At the top of the Xcode window, click the device name (it may say Any iOS Device) and choose your iPhone. The first time, Xcode spends a minute or two preparing it.
3. Back in Signing & Capabilities, click **Try Again** if errors are still showing.
4. Turn on **Developer Mode** on the iPhone: Settings, Privacy & Security, Developer Mode (at the bottom). The iPhone restarts; unlock it and tap Turn On. If Developer Mode isn't listed, press Run in Xcode once and it appears.
5. Press **Run** (the play button at the top left).
6. If the iPhone says **Untrusted Developer**, go to Settings, General, VPN & Device Management, tap your Apple ID, and tap Trust. Then press Run again.

Yellow warnings in Xcode come from the libraries the app uses and can be ignored. A red error stops the build: copy its text when asking for help.

## Step 5: Connect your node

The app needs four things from your node: its RPC address, a port, a user and a password. A phone can't read the node's cookie file, so it needs a user of its own.

### On StartOS

1. Open the **Bitcoin Knots** service, then **Actions & Config**, and run **Generate RPC User Credentials**. Give it a name such as `myiphone`. StartOS shows the password once: copy it. If Knots doesn't restart by itself, restart it.
2. Open **Interfaces**, then **RPC**. In the **Tor** section, copy the address. It looks like `https://abcd…xyz.onion`. If there isn't one, click **Add Onion Service** first.
3. In the app, tap **Connect your node**, choose **Mainnet**, and paste the whole address into **RPC address**. The app fills in port 443 and turns on **Use HTTPS** by itself.
4. Enter the user and password and tap **Connect**. Tor starts inside the app; the first connection can take a minute or two.

Copying the password from the Mac to the iPhone works with Universal Clipboard when both are signed in to the same Apple ID. Don't send it in a message or email.

### On other nodes

Add an `rpcauth` line to `bitcoin.conf` (the `rpcauth.py` script that comes with Bitcoin Core and Knots makes one) and publish the RPC port as a Tor onion service, for example with `HiddenServicePort 8332 127.0.0.1:8332` in `torrc`. In the app, enter the onion address, port 8332, and leave **Use HTTPS** off.

The node must be Bitcoin Knots following the BLAKE2b fork, with its wallet feature turned on. The app keeps watch-only copies of your wallets in a node wallet called `cormorant`, the same one desktop Shrike uses.

## Step 6: Add a wallet

- **A wallet you already use in Shrike:** choose **Use my seed words**, pick the number of words, and type them in order. Add the passphrase if it has one. If desktop Shrike already uses this node, the app finds the wallet there and needs no scan. Otherwise pick the address type and a date before the wallet's first payment, and your node scans from there.
- **A new wallet:** choose **Create a new wallet**, write the 24 words on paper, and type back the three the app asks for.

Never take a screenshot of seed words. Screenshots go to Photos, and often to iCloud. If you do take one, the app reminds you to delete it.

### Two-factor (optional)

Right after the first wallet, the app offers two-factor: a 6-digit code from an authenticator app before every send and before showing seed words. Tap **Skip for now** to leave it for later (Settings, Security, Two-factor).

1. Tap **Set up two-factor**.
2. In your authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS, Ente Auth or the iPhone's Passwords app), add an account by scanning the QR code. It's strongest on another device, such as a second phone or a tablet.
3. Type the 6-digit code it shows and tap **Turn on two-factor**.
4. Write the eight recovery codes on the paper with your seed words. Each works once in place of a code if you lose the authenticator.

## Step 7: Check it with a small amount

1. Compare the balance and the first receive address with Shrike on your computer.
2. Send a small amount to an address of your own, and check it arrives.
3. On the review screen, check it says **Replay protected**.

## Keeping it running

- **Free Apple ID:** the app stops opening 7 days after you install it. Connect the iPhone, open the project (`npm run ios:open` in this folder) and press Run. Don't delete the app first; installing over it keeps your wallets and settings.
- **Paid Apple Developer account:** choose your paid team instead of Personal Team in Signing & Capabilities and press Run. That install lasts a year.
- **Developer Mode** has to stay on for an app installed from Xcode. Turning it off doesn't delete anything, but the app won't open until it's back on.
- **After changing the code, or downloading a new version:** run `npm install`, then `npm run ios:sync`, then press Run. Installing over the app keeps your wallets, settings and two-factor.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| Signing errors: "Your team has no devices", "No profiles for ..." | Connect the iPhone, choose it at the top of Xcode, wait for Xcode to prepare it, then click Try Again. |
| "Failed to register bundle identifier" or "isn't available" | The bundle ID is taken. Run `./setup.sh` again with a different one. |
| Developer Mode isn't in Settings | Press Run in Xcode once with the iPhone connected; then it appears. |
| "Untrusted Developer" on the iPhone | Settings, General, VPN & Device Management, your Apple ID, Trust. |
| The app opened before but won't now | The 7 days are up, or Developer Mode is off. See [Keeping it running](#keeping-it-running). |
| "A TLS error caused the secure connection to fail" | Check **Use HTTPS** matches the address: on for StartOS's `https://` onion address on port 443, off for a plain RPC port such as 8332. |
| "The node refused the RPC user name or password" | Make a new RPC user and enter it again. StartOS only shows a password once. |
| "Couldn't reach your node" after a while | Tap the red banner, then Try Again. Check the node is running and the phone has a connection. |
| "That code doesn't match" when turning on two-factor or sending | Set the iPhone's clock automatically (Settings, General, Date & Time), and the authenticator's device too. Codes change every 30 seconds; wait for a fresh one. |
| The price says "Couldn't reach Neoxa Exchange through Tor" | Try again in a minute. If it keeps failing, turn off **Get the price through Tor** in Settings, which asks the exchange directly. |
| The wallet isn't found on the node | This version supports the standard account 0 paths only: m/84'/0'/0', m/86'/0'/0', m/49'/0'/0' and m/44'/0'/0'. Check the derivation in desktop Shrike (the wallet's Settings, Keystore). |

## Making it your own

[README.md](README.md) explains how the app is put together, which file does what and how to run the tests. `npm run dev` runs the screens in a browser against a local test node, which is quicker than installing on the phone for every change.

To give it a name of your own, change `appName` in `capacitor.config.ts` and `CFBundleDisplayName` in `ios/App/App/Info.plist`, and replace the icons in `resources/` and `public/bird.png`. The bird is Shrike's own artwork. If you publish anything, read [NOTICE](NOTICE) first: the code is Apache 2.0, but the Shrike and Sparrow names and logos aren't licensed for use as another product's brand.
