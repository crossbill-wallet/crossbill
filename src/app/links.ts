// Links shown on the Market tab, and the address donations go to. Every link opens in Safari, outside the app's
// Tor connection.

import { PRICE_PAGE } from '../core/price';

/**
 * Where the Support section sends donations: a mainnet receive address of the app author's donation wallet.
 * Empty hides the section, so a build never shows a placeholder.
 */
export const DONATION_ADDRESS = 'bc1q3zvy2gwhyt6g2hyrlqle2e7qjt5fcsys2tnraz';

export const APP_REPO = 'https://github.com/crossbill-wallet/crossbill';

export interface LinkGroup {
  title: string;
  links: { name: string; url: string; detail: string }[];
}

export const LINK_GROUPS: LinkGroup[] = [
  {
    title: 'Talk to people',
    links: [
      { name: 'Bitcoin Knots Discord', url: 'https://discord.gg/3Ccegp9YrU', detail: 'The official Knots server, linked from bitcoinknots.org.' },
      { name: 'Bitcoin Knots Telegram', url: 'https://t.me/Bitcoin_Knots', detail: 'Official chat. Direct messages offering help are almost always scams.' },
      { name: 'Knots on StartOS and Umbrel', url: 'https://paulscode.com/t/knots-29-4-8-05-2026-bip-110-blocks/1240', detail: 'Support thread on the PaulsCode forum for the node packages.' },
    ],
  },
  {
    title: 'Software',
    links: [
      { name: 'Crossbill on GitHub', url: APP_REPO, detail: 'This app’s code, issues and releases.' },
      { name: 'Shrike', url: 'https://github.com/privkeyio/shrike', detail: 'The desktop wallet that parts of this app are ported from. Crossbill isn’t part of that project.' },
      { name: 'Bitcoin Knots', url: 'https://bitcoinknots.org/', detail: 'The node software that follows the BLAKE2b chain.' },
      { name: 'Awesome Bitcoin BLAKE', url: 'https://github.com/bitcoin-blake/awesome-bitcoin-blake', detail: 'A list of wallets, explorers, pools and guides for the chain.' },
    ],
  },
  {
    title: 'Learn more',
    links: [
      { name: 'bitcoin-blake2b.org', url: 'https://bitcoin-blake2b.org/', detail: 'The fork’s own site, with guides for people, nodes and miners.' },
      { name: 'What is the BLAKE2b hard fork?', url: 'https://thebitcoinmanual.com/articles/blake2b-hard-fork/', detail: 'A plain-language explainer from The Bitcoin Manual.' },
      { name: 'Beware of BLAKE2b scams', url: 'https://thebitcoinmanual.com/articles/beware-of-bip110-blake-btc-scams/', detail: 'What the common scams around the fork look like.' },
    ],
  },
  {
    title: 'Explore and trade',
    links: [
      { name: 'mempool.guide', url: 'https://mempool.guide/', detail: 'Block explorer for the BLAKE2b chain.' },
      { name: 'Neoxa Exchange, XBT/USDC', url: PRICE_PAGE, detail: 'Where this app’s price comes from.' },
    ],
  },
];

/** Paperclip's Krux hardware wallet: where to buy it, its firmware, and who makes it. Shown in Settings, Hardware wallet. */
export const KRUX_LINKS: LinkGroup[] = [
  {
    title: 'Paperclip',
    links: [
      { name: 'Paperclip store', url: 'https://shop.paperclip-xbt.xyz/', detail: 'Where the K210 Krux Hardware Wallet is sold.' },
      {
        name: 'K210 Krux Hardware Wallet',
        url: 'https://shop.paperclip-xbt.xyz/product/k210-krux-hardware-wallet/',
        detail: 'The product page: what’s in the box, the hardware, and how signing works.',
      },
    ],
  },
  {
    title: 'Firmware',
    links: [
      { name: 'Paperclip’s Krux firmware', url: 'https://github.com/connorslab/krux-blake2b', detail: 'Source code, releases and compatibility notes for Bitcoin (XBT).' },
      {
        name: 'Installing and updating firmware',
        url: 'https://github.com/connorslab/krux-blake2b/blob/main/docs/FIRMWARE-UPDATES.md',
        detail: 'The first USB install, and signed updates from a microSD card after that.',
      },
      { name: 'Krux', url: 'https://github.com/selfcustody/krux', detail: 'The open-source signer it’s built on. Paperclip’s version isn’t an official Krux product.' },
    ],
  },
  {
    title: 'The maker',
    links: [{ name: 'Connor’s Lab', url: 'https://discord.com/users/538209415468417034', detail: 'The developer behind Paperclip’s Krux release, on Discord.' }],
  },
];
