# Scope: more than one server

Status: proposal only. Nothing here is built yet.

## What it would do

After Face ID, the app asks which server to open, and shows only that server's wallets. There's no limit on how many servers are set up. Each server is a Bitcoin Knots node with its own wallets, such as a home StartOS node, a node at a relative's house, and a regtest node for trying things.

1. Open the app and pass Face ID.
2. Pick a server from a list showing each one's name, network and wallet count. A "Remember my choice" switch skips this screen next time and opens the last server straight away.
3. The Wallet tab opens on that server's first wallet. Switching servers is in Settings, and from a server name at the top of the wallet switcher sheet.

## What changes underneath

### Data

Today the app stores one node (`settings.node`, and `rpc-password` in the Keychain) and a flat list of wallets.

| Now | With servers |
| --- | --- |
| `settings.node`, `settings.network` | `servers.json`: a list of `{ id, name, network, host, port, user, useTor, tls, createdAt, lastOpened }` |
| Keychain `rpc-password` | Keychain `rpc-password:<serverId>`, one per server |
| `wallets.json` with every wallet | Each `WalletConfig` gets a `serverId`. A wallet belongs to exactly one server |
| `wallet-<id>.json` history cache | Unchanged: wallet IDs are already unique |
| `contacts.json` | Unchanged: contacts are per network, not per server, so an exchange address saved once works on every mainnet server |
| `settings.json` | Keeps app-wide choices: appearance, font, two-factor, prices. Gains `lastServerId` and `rememberServer` |

The seed words stay where they are (`seed:<walletId>`, behind Face ID). The same seed words can be added on two servers as two separate wallets, and each server's node watches its own copy.

### Migration

On first launch of the version that adds servers, the existing node becomes server 1, named after its host ("Home node" if it's a StartOS onion), and every existing wallet gets that server's ID. The old `rpc-password` item is copied to `rpc-password:<id>` and then deleted. Nothing changes on the node.

### The model

`AppModel` today holds one `KnotsRpc` and one `NodeStatus`. With servers it holds the open server's:

- `openServer(id)`: drops the current RPC client and the polling timer, sets the server, loads its wallets into view, and connects.
- `networkWallets()` becomes "this server's wallets", filtered by `serverId` as well as network.
- Sync, sending, replay decision and fees stay per open server, exactly as now. Only one server is connected at a time, which keeps battery use and Tor traffic where they are today.

### Tor

One embedded Tor client already reaches any number of onion services, so nothing changes in `TorService.swift`. Switching servers reuses the running Tor client; only the HTTPS session's destination changes.

### Skins and prices

Skins open by counting confirmed mainnet coins across every server's wallets, so holdings split across nodes still count. That needs a cached balance per wallet, which the history cache already has.

## Screens

- **Server picker** (new): after the lock screen, when there's more than one server and "remember" is off.
- **Settings, Servers** (new): list, add, rename, remove, reorder. Removing a server removes its wallets from the phone, after the same confirmation as removing a wallet, and never touches the node.
- **Add a server**: today's node form, plus a name field.
- **Wallet switcher sheet**: shows the open server's name at the top, with Switch server.

## Effort and risk

| Part | Rough size |
| --- | --- |
| Data model, migration, tests | Medium. Most of the risk is in migration, so it gets its own tests with saved files from this version |
| Model: open and switch servers | Medium |
| Server picker, Settings screens, node form changes | Medium |
| Testing against two regtest nodes at once in the e2e suite | Small |

Risks:

- **Migration bugs** could hide wallets. Mitigation: migrate by copying, keep the old files until the first successful sync on the new layout, and test with files saved from 0.2.0.
- **The same seed on two servers** is two wallets that share coins. A send from one shows on the other only after that node sees it. The wallet switcher says which server a wallet is on to make this clear.
- **Two-factor** stays app-wide: one authenticator entry covers every server.

## Questions before building

1. Should "Remember my choice" be on by default, so most people never see the picker?
2. Should a server's wallets ever be visible from another server, for example to send between servers with My wallets? That needs both nodes connected at once, which this proposal avoids.
3. Should each server have its own name in the authenticator, or keep one entry for the whole app (proposed)?
