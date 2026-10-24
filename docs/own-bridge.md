# Your own bridge, for paying SHA256 invoices

Most shops that take Lightning take it on the SHA256 chain, the chain Bitcoin Core follows. A Lightning Fork node can't pay those invoices by itself: it lives on the BLAKE2b chain. A bridge pays them for it.

- **Your own bridge** is a second Lightning node on the same server, on the SHA256 chain, that Lightning Fork runs for you. It pays SHA256 invoices with its own BTC: no swap, no fee, and no XBT spent. You fund it with BTC and open one channel.
- **A service** is someone else's bridge. You pay them in XBT and they pay the invoice; they never hold your money, because their payment and yours share one payment hash. You need a code from the operator.

This page sets up your own, on StartOS. Lightning Fork's own instructions (**Running a bridge**, in its Instructions tab in StartOS) are the reference; this follows them.

Crossbill shows which one pays before you pay: **Paid from your bridge** with the BTC amount, or the service's price in XBT. With both set up, your own bridge pays first whenever its channel has enough, and the service pays the rest.

## What you need

- **Lightning Fork** running on StartOS, on the BLAKE2b chain.
- **A node on the SHA256 chain on the same server.** Lightning Fork's node runs on Bitcoin Knots 29.4.1 or later, or the Bitcoin Knots (BLAKE2b) Companion, and both follow the BLAKE2b chain, so neither can be this one. **Bitcoin Knots (SHA256) Companion** is made for it: it installs beside your main node, under its own name, and keeps only about 5 GB of blocks. Bitcoin Core, or a Knots build for the SHA256 chain, in the main Bitcoin package works too, if that's what your main node already is.
- **Disk space:** about 20 to 30 GB for the companion's blocks and chain state, and 1 to 3 GB for the bridge's Lightning node.
- **BTC to fund it:** at least 215,000 sats, for the 200,000-sat channel the dashboard recommends and about 15,000 to open it.

## 1. Install the SHA256 node

1. In StartOS, open the Marketplace and install **Bitcoin Knots (SHA256) Companion**, from the registry you installed Lightning Fork's packages from.
2. Start it. Leave **Pruning** as it is: the companion keeps only the recent blocks, so it doesn't hold a second full copy of the chain.
3. Wait for **Blockchain Sync** on its Dashboard to say it's synced. It downloads the whole chain once to check it (several hundred GB of traffic), so this takes hours to a few days.

You don't need to turn on ZMQ or make an RPC user: the bridge reads the node by itself.

## 2. Turn the bridge on

1. Wait until channel opens and resizes on your Lightning Fork node have confirmed: turning the bridge on restarts Lightning Fork.
2. In Lightning Fork, **Actions**, **Bridge**. Choose **Lightning Fork runs one**, and pick **Bitcoin Knots (SHA256) Companion** as the node on the SHA256 chain. The form shows which chain each of your nodes is on.
3. The **Fee** (1.5% by default) is charged only to people you give bridge codes to. Your own payments pay none.
4. Save. Lightning Fork restarts in about a minute, then creates the bridge's node, which takes a few minutes more. It's a stock LND whose seed comes from your Lightning Fork seed, so there's nothing new to write down; **SHA256 Node Recovery Phrase** shows its words if you ever need them in another LND.

## 3. Fund it

1. In the Lightning Fork dashboard, open the **Run a bridge** window (it's **Your bridge** once the bridge is on) and choose **Fund the bridge node**. Or use **Actions**, **Fund the SHA256 Node**.
2. Send BTC **on the SHA256 chain** to the address it shows. Coins sent on the BLAKE2b chain don't arrive there.

**Replay caution:** coins that existed before the fork (block 961640, 30 August 2026) exist on both chains. A transaction spending them on the SHA256 chain could be copied to the BLAKE2b chain and move the same coins there too. The simplest way around it is to send BTC you got after the fork, such as a withdrawal from an exchange. If the BTC you want to use is from before the fork, first move that wallet's XBT to a new address of your own with Crossbill, then send the BTC.

## 4. Open the channel

1. In the same window, choose **Open a channel**.
2. **Use CoinGate** (the recommended peer: well connected, with short time locks) or another well-connected node on the SHA256 chain.
3. Choose 200,000 sats, or **Use the maximum**.
4. The channel is usable once its funding transaction confirms; the window says when.

## 5. Check it

- The dashboard's **Paying SHA256 invoices** window says **Paid from your bridge** and how much it can send.
- **Bridge Status**, in Lightning Fork's Actions, says whether the bridge is serving and why not.
- In Crossbill, the Lightning tab says "SHA256 invoices are paid from your bridge", with what it can send.

Then pay a small SHA256 invoice: make one for about 1,000 sats in any ordinary Lightning wallet and pay it, from the dashboard's Send or from Crossbill.

## 6. Back up

Make a StartOS backup of Lightning Fork after opening the channel, and download the bridge node's channel backup from the dashboard. A StartOS backup keeps the bridge node's channel backup but not its wallet: after a restore, turning the bridge on again recreates the node from your recovery phrase and recovers its channels.

## Good to know

- **Paying from your own bridge spends BTC, not XBT.** To pay a SHA256 invoice with XBT instead, add a service's code in Paying SHA256 invoices; a node can't swap through its own bridge.
- **Keep the channel topped up.** When it can't send enough, the payment goes to the service if you have one, or Crossbill says how much the bridge can send.
- **The bridge node keeps running** once created, bridge on or off, because a node must watch its channels.
- **Letting others pay through it:** **Add Bridge Participant** makes a code for one person (it needs an onion address on Lightning Fork's REST LND Connect interface). A code is a credential: send it privately. **Remove Bridge Participant** revokes it.
- **Inbound channels:** to let other nodes on the SHA256 chain open channels to your bridge's node, add an onion address to its **SHA256 Lightning Peer** interface. Paying doesn't need it.
- Keep amounts modest. The BLAKE2b chain is new, and Lightning Fork and Crossbill are young software.
