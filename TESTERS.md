# Testing Crossbill

Thanks for trying it. Crossbill is an iPhone wallet for Bitcoin (XBT), the BLAKE2b chain. It talks only to your own Bitcoin Knots node, over Tor, and works alongside the desktop wallet Shrike, though it isn't part of that project. Before 0.4.0 it was called Shrike for iPhone.

**It isn't audited.** Use a small amount, keep your seed words on paper, and don't put anything on it you can't afford to lose.

## What you need

- An iPhone with iOS 16 or later.
- Your own Bitcoin Knots node that follows the BLAKE2b chain, with its RPC address, user and password. [GETTING-STARTED.md](GETTING-STARTED.md#step-5-connect-your-node) shows where to find them on StartOS and other nodes.
- A computer for the sideloading tool (Mac or Windows).

## Get a test build

Each [release](https://github.com/crossbill-wallet/crossbill/releases) has an unsigned `Crossbill-<version>-unsigned.ipa`, built by GitHub from that release's public commit. It isn't signed by anyone, so you sign it yourself in the next step.

Check the file before installing it. In Terminal, in the folder you saved both files to:

```sh
shasum -a 256 -c Crossbill-0.4.0-unsigned.ipa.sha256
gh attestation verify Crossbill-0.4.0-unsigned.ipa --repo crossbill-wallet/crossbill
```

The first says the file arrived intact. The second, with the [GitHub CLI](https://cli.github.com/) signed in, says GitHub's own build of this repository made it, rather than someone's computer. If either fails, don't install it.

## Install it

Use a sideloading tool, which signs the app with your own Apple Account and installs it:

- [AltStore](https://altstore.io/) or [SideStore](https://sidestore.io/), or
- [Sideloadly](https://sideloadly.io/).

Follow the tool's own guide. You can use a separate Apple Account for this if you'd rather not sign in with your main one. Then turn on **Developer Mode** on the iPhone (Settings, Privacy & Security, Developer Mode) and restart when asked.

Things to know:

- **With a free Apple Account, the app stops opening after 7 days** until the tool refreshes it. Refreshing or installing a newer build over it keeps your wallets and settings.
- **Always use the same Apple Account to refresh it.** The app keeps your seed words in the iPhone Keychain, which belongs to whoever signed it. Signed by another account, it can't read them, and you'd add your wallets again from your seed words.
- **The widgets may not work** in sideloaded builds: they share data with the app through an App Group, which some tools can't set up.

## Report what you find

Problems and ideas go in the [issue tracker](https://github.com/crossbill-wallet/crossbill/issues), with the app version (Settings, at the bottom), your iPhone and iOS version, and the steps that cause it. Don't post seed words, passwords, node addresses or screenshots that show them.

Security problems shouldn't be public: see [SECURITY.md](SECURITY.md).

## Building it yourself

If you'd rather not trust any binary, [GETTING-STARTED.md](GETTING-STARTED.md) builds the app on your own Mac from this repository.
