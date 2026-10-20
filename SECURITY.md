# Security

Shrike for iPhone holds seed words and signs Bitcoin transactions, and it hasn't been audited. If you find a way to read a seed, sign something the user didn't approve, send or show seed words without the two-factor code when it's on, send to the wrong address or the wrong chain, or make a transaction replayable when the app says it's protected, please report it privately so it can be fixed before it's public:

- On GitHub, open the repository's **Security** tab and choose **Report a vulnerability**.

Please include the app version (Settings, at the bottom), the iPhone and iOS version, and the steps to reproduce it. Don't include real seed words, passwords or node addresses.

Ordinary bugs can go in the issue tracker.

## What two-factor does and doesn't cover

Two-factor codes are checked on the iPhone, against a key kept in the Keychain on that device. They stop someone who has the unlocked phone and its passcode from sending or reading the seed words through the app, as long as the authenticator is somewhere else. They don't protect the seed words themselves: anyone who has them can spend with another wallet. A phone that's been jailbroken can be made to skip any check the app makes.

## What the widgets can show

The Home Screen and Lock Screen widgets show what the app hands them: the last XBT price and, unless it's turned off in Settings, Widgets, one wallet's balance and its worth in dollars. The app saves that in a file the widgets can read, in an App Group shared only with its own widget extension. The file holds no seed words, keys or addresses. It's kept out of iCloud backups, and after a restart iOS lets the widgets read it once the passcode has been entered, so the Lock Screen widgets work. Anyone who can see the iPhone can read a widget, Lock Screen included; with **Lock Screen Widgets** turned off under Settings, Face ID & Passcode, Allow Access When Locked, iOS hides the balance until Face ID recognizes you. The widgets never go online.
