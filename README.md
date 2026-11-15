# NFT Marketplace on TON

The base of an NFT marketplace: the **Getgems sale and auction contracts (unmodified)**, deploy and admin scripts, and a
**test stand**: a web page where you connect a wallet, list an NFT for a fixed price or an auction, buy, bid, cancel and
finish. Prices and bids are in TON or GUM.

**Stand:** https://gumcommunity.github.io/nft-marketplace/ (testnet) ·
https://gumcommunity.github.io/nft-marketplace/?net=mainnet (mainnet)

Deployment step by step (in Russian): [DEPLOY.ru.md](DEPLOY.ru.md).

## Contracts

| Contract | What it does |
|---|---|
| `nft-fixprice-sale-v4r1` | One contract per listing. Holds the NFT; sells it for a TON price and/or a jetton price; splits the payment between seller, marketplace fee and collection royalty; the seller (or the marketplace) can cancel. |
| `nft-auction-v4r1` | One contract per auction, in TON or in one jetton. Minimal bid, step %, optional buyout price, anti-sniping extension; outbid bidders are refunded; after the end the seller, the winner or the marketplace finishes it. |
| `nft-marketplace-v2` | The marketplace itself: a wallet (v3r2) controlled by the **admin key**. Every listing names it as `marketplace_address`, which lets the admin cancel listings and rescue stuck NFTs. Can also deploy listings signed by the admin key (for a future backend). |
| `nft-collection-editable` + `nft-item` | Test collection for the stand (anyone can deploy their own). |

The code is pinned from [getgems-io/nft-contracts](https://github.com/getgems-io/nft-contracts) at `68cfc0c`: the same
compiled cells Getgems uses, so the code hashes match Getgems' contracts on mainnet. Sources and hashes:
[contracts/getgems/](contracts/getgems/README.md). `tests/Code.spec.ts` proves the sources compile to these cells.

The marketplace fee and the fee address are not stored in the marketplace contract: they are written into every listing
(`fee_address`, `fee_percent`) when it is created. The stand only shows listings whose code hash is ours and whose
marketplace, fee address and fee match `deployments.json`.

## How listing works (no backend)

The seller's wallet signs **one transaction with three messages** (built in [`web/src/market.ts`](web/src/market.ts)):

```
seller ── deploy (state_init + deploy_blank / deploy_jetton / deploy_auction / set_jetton_wallet) ──> listing
seller ── NFT transfer(new_owner = listing, forward 0.01 TON) ──> NFT ── ownership_assigned ──> listing   (activates it)
seller ── comment "listing:<address>" (0.002 TON) ──> marketplace                                         (the stand reads these)
```

- **Jetton price / jetton auction.** The listing's own jetton wallet depends on the listing address, so it cannot be in
  the initial data. The listing starts with a one-time key generated in the browser (and, for a sale, with the seller
  as `marketplace_address`); the deploy message, signed by that key, sets the jetton wallet and hands the
  marketplace role to our marketplace contract. This is exactly how Getgems' own TypeScript builds deploy messages; the
  key cannot do anything else and is discarded.
- **Several currencies.** A fixed price sale can have a TON price and a price in every accepted jetton at once (e.g.
  12 TON or 1000 GUM); the first buyer to pay any of them gets the NFT, the other prices stop working. There is no
  exchange rate: the seller sets each price. Auctions use one currency (bids must be comparable).
- **Price change.** The seller changes the prices of an active sale in place (`change_price`, op `0xfd135f7b`): new TON
  price and the whole jetton price list (a currency can be added or removed). No re-listing, no new deposit.
- **Getgems' backend flow** (op 1 on the marketplace: the server checks and signs every listing) is supported by the
  contract and covered by tests (`signedDeployBody`), but the stand does not need it: listings are validated when read.
- **Finding listings.** The stand reads the latest registration comments sent to the marketplace (tonapi), then checks
  each address: code hash, data (our marketplace, fee address, fee), the NFT is really held by the listing, and for jettons
  that the listing uses its own jetton wallet. Fake or foreign listings are ignored.

Measured in the sandbox (`tests/`, marketplace fee 0%). Network fees actually burned are 0.001–0.006 TON per action;
the rest of the attached TON comes back or moves between the parties:

| Action | Attached | User pays in the end |
|---|---|---|
| List (sale or auction) | 0.122 TON | ≈0.026 TON: 0.004 network fees + 0.002 registration + 0.02 deposit kept on the listing |
| Change a sale's prices | 0.005 TON | ≈0.003 TON network fees; the rest stays on the listing (back to the seller on cancel) |
| Cancel a sale | 0.1 TON | the deposit comes back: net **+0.018** TON to the seller |
| Buy for TON | price + 0.1 TON | price only; the excess and the listing deposit come back with the NFT (net +0.017) |
| Buy for GUM | price in GUM + 0.4 TON | price only (net +0.009 TON) |
| Bid in TON | the bid (buyout: max bid + 0.1) | ≈0.0003 TON; an outbid bid comes back minus ≈0.001 TON |
| Bid in GUM | bid + 0.11 TON (buyout 0.35) | ≈0.063 TON stays on the auction (pays the refund to the next outbid bidder); GUM come back if outbid |
| Finish an auction | 0.1 TON (GUM auction 0.25) | the auction's leftover TON goes to whoever finishes (GUM auction: net +0.07) |

The contracts require some of these minimums (0.1 TON to buy/cancel/finish, 0.26 for a GUM purchase, 0.05 per GUM bid);
the listing deposit and registration are set in `AMOUNTS` (`web/src/market.ts`). Storage of a listing costs
~0.0017 TON/year (sale) / ~0.0025 (auction), so the 0.02 TON deposit lasts for years.

## Repository

```
contracts/getgems/   Getgems FunC sources (unmodified) + LICENSE
web/src/codes.ts     pinned compiled code (shared by the page, tests and scripts)
web/src/market.ts    transaction builders + data parsers + listing validation (no browser APIs)
web/src/             the stand: config.ts (network, deployments.json), tonapi.ts, main.ts
web/public/          TON Connect manifest, icon, test collection metadata (test-nft/)
wrappers/            Marketplace (admin key actions), get-method wrappers, jetton wrappers
scripts/             deployMarketplace, deployTestCollection, mintTestNft, marketplaceAdmin
tests/               sandbox tests: every flow with the page's own transactions and the real GUM wallet code
deployments.json     addresses and fee per network (written by the scripts, read by the page at build time)
```

## Develop

```bash
npm ci
npm test            # 38 tests: pinned code == sources, sale TON/GUM/both, price change, auction TON/GUM, cancel, buyout, admin, checks
npm run dev         # stand at http://localhost:5173 (?net=mainnet for mainnet)
npm run build:web   # static files in web/dist
```

Optional `web/.env.local` with `VITE_TONAPI_KEY=...` (a tonapi.io key meant for browsers — it ends up in public
JavaScript). Without it tonapi allows ~1 request/s and the stand loads listings slowly.

## Deploy (short)

1. `.env`: deployer wallet for blueprint (`WALLET_MNEMONIC`, `WALLET_VERSION`) or use TON Connect when asked.
2. `npx blueprint run deployMarketplace --testnet` — creates the admin key (saved to `.env` as
   `MARKETPLACE_ADMIN_MNEMONIC_TESTNET`), asks for the fee address and fee %, deploys, writes `deployments.json`.
3. `npx blueprint run deployTestCollection --testnet` — optional test collection (owner = your wallet).
4. `npm run deploy:web` — builds the stand with `deployments.json` and publishes it to the `gh-pages` branch.
5. Same with `--mainnet` when testnet works. Commit `deployments.json` (it has only public data).

Admin: `npx blueprint run marketplaceAdmin --testnet info | withdraw <to> <ton> | cancel <listing> | rescue <listing> [to]`.

## Security notes

- **The admin key** (`MARKETPLACE_ADMIN_MNEMONIC_*` in `.env`) controls the marketplace contract. It can cancel any
  active listing (the NFT goes back to its seller) and, through op 555, make a listing that is **finished or never
  activated** send any message (rescue of stuck NFTs) — not within 10 minutes of a sale/bid. It cannot take an active
  listing's NFT or a bid. Keep it offline; losing it means a new marketplace address (old listings keep working but can
  no longer be cancelled by the admin).
- Fee and royalty are fixed in each listing at creation. Changing the fee later only affects new listings, and the stand
  shows only listings with the current fee: change it only together with a new stand build.
- Listings must be checked by code hash and data, never by get-methods alone (Getgems' advice) — `checkListing` does that.
- If a seller sends the NFT to a listing in a separate transaction without `forward_amount`, the listing never
  activates; the admin returns the NFT with `marketplaceAdmin rescue`.

## Not included (next steps for a full marketplace)

An indexer and database (the stand scans the last 50 registrations), offers (`nft-offer`), collection pages, search,
a backend that signs listings, an auto-finisher for auctions (`finish_auction` also works as an external message).
