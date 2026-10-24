# Security

Crossbill holds seed words and signs Bitcoin transactions, and it hasn't been audited. If you find a way to read a seed, sign something the user didn't approve, send or show seed words without the two-factor code when it's on, send to the wrong address or the wrong chain, or make a transaction replayable when the app says it's protected, please report it privately so it can be fixed before it's public:

- On GitHub, open the repository's **Security** tab and choose **Report a vulnerability**.

Please include the app version (Settings, at the bottom), the iPhone and iOS version, and the steps to reproduce it. Don't include real seed words, passwords or node addresses.

Ordinary bugs can go in the issue tracker.

## What two-factor does and doesn't cover

Two-factor codes are checked on the iPhone, against a key kept in the Keychain on that device. They stop someone who has the unlocked phone and its passcode from sending or reading the seed words through the app, as long as the authenticator is somewhere else. They don't protect the seed words themselves: anyone who has them can spend with another wallet. A phone that's been jailbroken can be made to skip any check the app makes.

## What the widgets can show

The Home Screen and Lock Screen widgets show what the app hands them: the last XBT price and, unless it's turned off in Settings, Widgets, one wallet's balance and its worth in dollars. The app saves that in a file the widgets can read, in an App Group shared only with its own widget extension. The file holds no seed words, keys or addresses. It's kept out of iCloud backups, and after a restart iOS lets the widgets read it once the passcode has been entered, so the Lock Screen widgets work. Anyone who can see the iPhone can read a widget, Lock Screen included; with **Lock Screen Widgets** turned off under Settings, Face ID & Passcode, Allow Access When Locked, iOS hides the balance until Face ID recognizes you. The widgets never go online.

## What the app PIN and duress PIN do and don't cover

With the app PIN on, Crossbill asks for Face ID alone; anything else leads to the PIN, never the iPhone passcode. That stops someone who has watched you type your passcode, the usual way phones are stolen with their data. iOS lets anyone with the passcode add a face to Face ID, so Crossbill remembers the faces Face ID accepted when the PIN was set and stops trusting Face ID if they change, until the PIN confirms it. After a correct PIN, reading seed words still goes through iOS, which asks for Face ID or the passcode. The PIN is checked by the app, against a salted hash in the Keychain; a jailbroken phone can be made to skip it.

The duress PIN opens a session that shows one wallet. It hides the other wallets, their labels and contacts from the screens, and saves nothing about itself. It can't hide what's outside the app: your node still watches every wallet, the Lock Screen and Home Screen show the skin and widgets before any PIN is typed, and backups made outside that session hold everything. Choose the Crossbill skin and keep the Balance widget on the decoy (setting a duress PIN does that) if you rely on it. Adding a hidden wallet again in a duress session, by its seed words or its Krux's key, shows it as it is, under its own name: whoever can do that can spend from it anyway.

## The backup file

The backup holds wallet details (extended public keys, names, labels, frozen coins), contacts, settings and your node's address, encrypted with your password using scrypt (64 MiB) and XChaCha20-Poly1305. Anyone with the file and the password can see your balances and history, but can't spend: that takes the seed words, which are never in it, nor are the node's RPC password, the two-factor key or the app PIN. A long password matters, since the file can be attacked offline.

## Address checks

Crossbill compares each recipient with your saved contacts, addresses you've paid and your own, and flags one that matches at the start and the end without being the same. That catches the usual address-poisoning trick, but not an address that's entirely different, such as one swapped in your clipboard. Check every address against where it came from.


## Signing on a Krux

For a wallet linked to Paperclip's Krux, Crossbill hands the Krux an unsigned transaction (a PSBT) and takes back only its signatures. Before sending, Crossbill checks the returned transaction is the one it built, that every signature verifies against the wallet's own key for that input, and that each is a unified ALL signature (`0x21`). A reply that fails any of these is refused. The Krux shows each destination, amount, change and fee before it signs, so a compromised phone can't get it to sign a different payment without that showing on the Krux's screen: check what the Krux shows, not only what the phone shows.

Crossbill asks for no Face ID or two-factor code for these sends, since nothing on the phone can sign them. A wallet whose seed words you chose to keep on the iPhone can still be signed there, with Face ID and the code as before. Taking the seed words off the iPhone deletes its Keychain copy; the Krux and your paper copy are then the only places they are. Crossbill only does that after reading the wallet's key off the Krux's screen, which shows the Krux holds those seed words at that moment, and after you confirm they're on paper. The Krux's encrypted storage isn't a secure chip, so keep the paper copy apart from it.

The Krux can't tell which chain a transaction is for. Replay protection comes from the unified signature, which the original chain rejects. A send signed on the Krux is only offered while Crossbill's replay check passes.
