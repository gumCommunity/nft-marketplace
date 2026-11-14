import '@ton/test-utils';
import { Address, beginCell, contractAddress, Dictionary, internal, toNano, Transaction } from '@ton/core';
import { setup, FEE } from './helpers/setup';
import { GUM, GUM_MASTER, giveJettons, jettonWalletAddress } from './helpers/gum';
import { JettonWallet } from '../wrappers/Jetton';
import { Auction, FixPriceSale } from '../wrappers/Listings';
import { signedDeployBody } from '../wrappers/Marketplace';
import {
    AMOUNTS,
    bidJettonMessage,
    bidTonMessage,
    buildAuctionListing,
    buildSaleData,
    buildSaleListing,
    buyJettonMessage,
    buyTonMessage,
    cancelAuctionMessage,
    cancelSaleMessage,
    checkListing,
    finishAuctionMessage,
    JettonPriceValue,
    nextMinBid,
    OP,
    parseRegisterComment,
    SALE_CODE,
    type AuctionData,
    type Listing,
    type MarketConfig,
    type SaleData,
} from '../web/src/market';

type Env = Awaited<ReturnType<typeof setup>>;

/** TON that arrived at `to` in these transactions (internal messages only). */
function received(txs: Transaction[], to: Address): bigint {
    let sum = 0n;
    for (const t of txs) {
        const m = t.inMessage;
        if (m?.info.type === 'internal' && m.info.dest.equals(to)) sum += m.info.value.coins;
    }
    return sum;
}

async function listingOf(env: Env, address: Address, market: MarketConfig = env.market): Promise<Listing> {
    const acc = (await env.blockchain.getContract(address)).accountState;
    if (acc?.type !== 'active') throw new Error('not active');
    const r = checkListing(address, acc.state.code!, acc.state.data!, market, env.blockchain.now);
    if (!r.ok) throw new Error(r.reason);
    return r.listing;
}
const saleOf = async (env: Env, a: Address) => (await listingOf(env, a)) as Listing & { kind: 'sale'; data: SaleData };
const auctionOf = async (env: Env, a: Address) =>
    (await listingOf(env, a)) as Listing & { kind: 'auction'; data: AuctionData };

const royaltyOf = (env: Env) => ({ address: env.royaltyWallet.address, factor: 10, base: 100 });
const gumBalance = (env: Env, owner: Address) =>
    env.blockchain.openContract(JettonWallet.createFromAddress(jettonWalletAddress(owner))).getBalance();

describe('fixed price sale for TON', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    async function list(price = toNano('10')) {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                tonPrice: price,
            },
            env.resolveJettonWallet,
        );
        const res = await env.send(env.seller, l.messages);
        return { nft, sale: l.address, res };
    }

    it('lists: deploys the sale, moves the NFT, registers with the marketplace', async () => {
        const { nft, sale, res } = await list();
        expect(res.transactions).toHaveTransaction({ to: sale, deploy: true, success: true });
        expect((await nft.getNftData()).owner?.equals(sale)).toBe(true);

        const l = await saleOf(env, sale);
        expect(l.status).toBe('active');
        expect(l.data.owner?.equals(env.seller.address)).toBe(true);
        expect(l.data.fee).toBe(FEE);
        expect(l.data.royalty).toBe(10_000);

        // parser == get-method
        const g = await env.blockchain.openContract(FixPriceSale.createFromAddress(sale)).getSaleData();
        expect(g.marketplace.equals(env.marketplace.address)).toBe(true);
        expect(g.fullPrice).toBe(toNano('10'));
        expect(g.owner?.equals(env.seller.address)).toBe(true);

        // the registration comment reached the marketplace and points to the sale
        const reg = res.transactions.find(
            (t) => t.inMessage?.info.dest?.toString() === env.marketplace.address.toString(),
        );
        expect(
            reg?.description.type === 'generic' &&
                reg.description.computePhase.type === 'vm' &&
                reg.description.computePhase.success,
        ).toBe(true);
        const s = reg!.inMessage!.body.beginParse();
        expect(s.loadUint(32)).toBe(0);
        expect(parseRegisterComment(s.loadStringTail())?.equals(sale)).toBe(true);
    });

    it('buy: NFT to buyer, price split between seller, fee and royalty', async () => {
        const { nft, sale } = await list(toNano('10'));
        const res = await env.send(env.buyer, [buyTonMessage(sale, toNano('10'))]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect(received(res.transactions, env.seller.address)).toBe(toNano('8.5'));
        expect(received(res.transactions, env.feeWallet.address)).toBe(toNano('0.5'));
        expect(received(res.transactions, env.royaltyWallet.address)).toBe(toNano('1'));
        expect((await saleOf(env, sale)).status).toBe('sold');
    });

    it('rejects a payment below the price; the NFT stays on sale', async () => {
        const { nft, sale } = await list(toNano('10'));
        const res = await env.send(env.buyer, [buyTonMessage(sale, toNano('9.9'))]);
        expect(res.transactions).toHaveTransaction({ to: sale, success: false, exitCode: 450 });
        expect((await nft.getNftData()).owner?.equals(sale)).toBe(true);
    });

    it('cancel by the seller returns the NFT; others cannot cancel', async () => {
        const { nft, sale } = await list();
        const bad = await env.send(env.buyer, [cancelSaleMessage(sale)]);
        expect(bad.transactions).toHaveTransaction({ to: sale, success: false, exitCode: 458 });

        await env.send(env.seller, [cancelSaleMessage(sale)]);
        expect((await nft.getNftData()).owner?.equals(env.seller.address)).toBe(true);
        expect((await saleOf(env, sale)).status).toBe('canceled');
    });

    it('marketplace admin can cancel a sale (external message signed by the admin key)', async () => {
        const { nft, sale } = await list();
        await env.marketplace.sendCancelListing(
            env.adminKey.secretKey,
            sale,
            beginCell().storeUint(OP.saleCancel, 32).storeUint(0, 64).endCell(),
            toNano('0.1'),
        );
        expect((await nft.getNftData()).owner?.equals(env.seller.address)).toBe(true);
    });
});

describe('fixed price sale for GUM', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    async function list(gumPrice = GUM(100)) {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                tonPrice: 0n,
                jetton: { master: GUM_MASTER, price: gumPrice },
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        return { nft, sale: l.address };
    }

    it('lists: the deploy message hands the sale to our marketplace and sets the GUM price', async () => {
        const { sale } = await list();
        const l = await saleOf(env, sale);
        expect(l.status).toBe('active');
        expect(l.data.marketplace.equals(env.marketplace.address)).toBe(true);
        expect(l.data.publicKey).toBeNull(); // the one-time key is gone after deploy_jetton
        const saleGumWallet = jettonWalletAddress(sale);
        const p = l.data.jettonPrices.get(BigInt('0x' + saleGumWallet.hash.toString('hex')));
        expect(p?.price).toBe(GUM(100));
        expect(p?.master.equals(GUM_MASTER)).toBe(true);
    });

    it('buy with GUM: NFT to buyer, GUM split between seller, fee and royalty', async () => {
        const { nft, sale } = await list(GUM(100));
        await giveJettons(env.blockchain, env.buyer.address, GUM(150));
        await env.send(env.buyer, [
            buyJettonMessage({
                buyer: env.buyer.address,
                buyerJettonWallet: jettonWalletAddress(env.buyer.address),
                sale,
                price: GUM(100),
            }),
        ]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect(await gumBalance(env, env.buyer.address)).toBe(GUM(50));
        expect(await gumBalance(env, env.seller.address)).toBe(GUM(85));
        expect(await gumBalance(env, env.feeWallet.address)).toBe(GUM(5));
        expect(await gumBalance(env, env.royaltyWallet.address)).toBe(GUM(10));
        expect((await saleOf(env, sale)).status).toBe('sold');
    });

    it('too little GUM is refunded and the NFT stays on sale', async () => {
        const { nft, sale } = await list(GUM(100));
        await giveJettons(env.blockchain, env.buyer.address, GUM(150));
        await env.send(env.buyer, [
            buyJettonMessage({
                buyer: env.buyer.address,
                buyerJettonWallet: jettonWalletAddress(env.buyer.address),
                sale,
                price: GUM(99),
            }),
        ]);
        expect((await nft.getNftData()).owner?.equals(sale)).toBe(true);
        expect(await gumBalance(env, env.buyer.address)).toBe(GUM(150));
    });

    it('cannot be bought for TON when there is no TON price', async () => {
        const { sale } = await list();
        const res = await env.send(env.buyer, [buyTonMessage(sale, toNano('10'))]);
        expect(res.transactions).toHaveTransaction({ to: sale, success: false, exitCode: 459 });
    });
});

describe('auction for TON', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    async function list(opts: { minBid?: bigint; maxBid?: bigint } = {}) {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildAuctionListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                minBid: opts.minBid ?? toNano('1'),
                maxBid: opts.maxBid ?? 0n,
                stepPercent: 10,
                endTime: env.blockchain.now! + 3600,
                createdAt: env.blockchain.now,
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        return { nft, auction: l.address };
    }

    it('lists and accepts bids; an outbid bidder gets the TON back', async () => {
        const { nft, auction } = await list();
        expect((await nft.getNftData()).owner?.equals(auction)).toBe(true);
        let a = await auctionOf(env, auction);
        expect(a.status).toBe('active');

        const low = await env.send(env.buyer, [bidTonMessage(auction, toNano('0.5'))]);
        expect(low.transactions).toHaveTransaction({ to: auction, success: false, exitCode: 1000 });

        await env.send(env.buyer, [bidTonMessage(auction, toNano('1'))]);
        a = await auctionOf(env, auction);
        expect(a.data.lastBid).toBe(toNano('1'));
        expect(nextMinBid(a.data)).toBe(toNano('1.1'));

        // parser == get-method
        const g = await env.blockchain.openContract(Auction.createFromAddress(auction)).getAuctionData();
        expect(g.minBid).toBe(nextMinBid(a.data));
        expect(g.isBrokenState).toBe(false);

        const res = await env.send(env.buyer2, [bidTonMessage(auction, toNano('1.1'))]);
        expect(received(res.transactions, env.buyer.address)).toBeGreaterThan(toNano('0.99'));
        a = await auctionOf(env, auction);
        expect(a.data.lastMember?.equals(env.buyer2.address)).toBe(true);
    });

    it('finish after the end: NFT to the winner, the bid split between seller, fee and royalty', async () => {
        const { nft, auction } = await list();
        await env.send(env.buyer, [bidTonMessage(auction, toNano('10'))]);

        const early = await env.send(env.seller, [finishAuctionMessage(auction, false)]);
        expect(early.transactions).toHaveTransaction({ to: auction, success: false, exitCode: 1010 });

        env.blockchain.now! += 3601;
        expect((await auctionOf(env, auction)).status).toBe('ended');
        const res = await env.send(env.seller, [finishAuctionMessage(auction, false)]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        const fee = received(res.transactions, env.feeWallet.address);
        const royalty = received(res.transactions, env.royaltyWallet.address);
        expect(fee).toBeGreaterThan(toNano('0.49'));
        expect(fee).toBeLessThanOrEqual(toNano('0.5'));
        expect(royalty).toBeGreaterThan(toNano('0.99'));
        expect(royalty).toBeLessThanOrEqual(toNano('1'));
        expect(received(res.transactions, env.seller.address)).toBeGreaterThan(toNano('8.4'));
        expect((await auctionOf(env, auction)).status).toBe('sold');
    });

    it('buyout: a bid of max_bid + 0.1 TON ends the auction at once', async () => {
        const { nft, auction } = await list({ maxBid: toNano('5') });
        await env.send(env.buyer, [bidTonMessage(auction, toNano('5') + AMOUNTS.tonBuyoutGas)]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect((await auctionOf(env, auction)).status).toBe('sold');
    });

    it('cancel without bids returns the NFT; not possible after a bid', async () => {
        const { nft, auction } = await list();
        await env.send(env.seller, [cancelAuctionMessage(auction)]);
        expect((await nft.getNftData()).owner?.equals(env.seller.address)).toBe(true);
        expect((await auctionOf(env, auction)).status).toBe('canceled');

        const second = await list();
        await env.send(env.buyer, [bidTonMessage(second.auction, toNano('1'))]);
        const res = await env.send(env.seller, [cancelAuctionMessage(second.auction)]);
        expect(res.transactions).toHaveTransaction({ to: second.auction, success: false, exitCode: 1009 });
    });

    it('an auction that ended without bids returns the NFT on finish', async () => {
        const { nft, auction } = await list();
        env.blockchain.now! += 3601;
        await env.send(env.seller, [finishAuctionMessage(auction, false)]);
        expect((await nft.getNftData()).owner?.equals(env.seller.address)).toBe(true);
    });
});

describe('auction for GUM', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    async function list() {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildAuctionListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                minBid: GUM(50),
                maxBid: GUM(1000),
                stepPercent: 10,
                endTime: env.blockchain.now! + 3600,
                createdAt: env.blockchain.now,
                jettonMaster: GUM_MASTER,
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        return { nft, auction: l.address };
    }
    const bid = (env: Env, who: 'buyer' | 'buyer2', auction: Address, amount: bigint, buyout = false) =>
        env.send(env[who], [
            bidJettonMessage({
                bidder: env[who].address,
                bidderJettonWallet: jettonWalletAddress(env[who].address),
                auction,
                amount,
                buyout,
            }),
        ]);

    it('lists in jetton mode: the auction knows its own GUM wallet, the one-time key is gone', async () => {
        const { auction } = await list();
        const a = await auctionOf(env, auction);
        expect(a.status).toBe('active');
        expect(a.data.jettonWallet?.equals(jettonWalletAddress(auction))).toBe(true);
        expect(a.data.publicKey).toBeNull();
    });

    it('bids, outbid refund in GUM, finish pays out GUM', async () => {
        const { nft, auction } = await list();
        await giveJettons(env.blockchain, env.buyer.address, GUM(500));
        await giveJettons(env.blockchain, env.buyer2.address, GUM(500));

        await bid(env, 'buyer', auction, GUM(40)); // below min: refunded
        expect(await gumBalance(env, env.buyer.address)).toBe(GUM(500));

        await bid(env, 'buyer', auction, GUM(100));
        expect((await auctionOf(env, auction)).data.lastBid).toBe(GUM(100));
        await bid(env, 'buyer2', auction, GUM(200));
        expect(await gumBalance(env, env.buyer.address)).toBe(GUM(500)); // outbid: GUM back

        env.blockchain.now! += 3601;
        await env.send(env.buyer2, [finishAuctionMessage(auction, true)]);
        expect((await nft.getNftData()).owner?.equals(env.buyer2.address)).toBe(true);
        expect(await gumBalance(env, env.seller.address)).toBe(GUM(170));
        expect(await gumBalance(env, env.feeWallet.address)).toBe(GUM(10));
        expect(await gumBalance(env, env.royaltyWallet.address)).toBe(GUM(20));
        expect(await gumBalance(env, env.buyer2.address)).toBe(GUM(300));
    });

    it('GUM buyout ends the auction at once', async () => {
        const { nft, auction } = await list();
        await giveJettons(env.blockchain, env.buyer.address, GUM(1000));
        await bid(env, 'buyer', auction, GUM(1000), true);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect(await gumBalance(env, env.seller.address)).toBe(GUM(850));
    });
});

describe('zero marketplace fee (royalty only)', () => {
    let env: Env;
    let market: MarketConfig;
    beforeEach(async () => {
        env = await setup();
        market = { ...env.market, fee: 0 };
    });
    const received0 = (txs: Transaction[]) => received(txs, env.feeWallet.address);

    it('TON sale: seller gets price - royalty, nothing goes to the fee address', async () => {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            { seller: env.seller.address, nft: nft.address, market, royalty: royaltyOf(env), tonPrice: toNano('10') },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        expect(checkListing(l.address, SALE_CODE, (await getData(env, l.address))!, market).ok).toBe(true);
        const res = await env.send(env.buyer, [buyTonMessage(l.address, toNano('10'))]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect(received(res.transactions, env.seller.address)).toBe(toNano('9'));
        expect(received(res.transactions, env.royaltyWallet.address)).toBe(toNano('1'));
        expect(received0(res.transactions)).toBe(0n);
    });

    it('GUM sale: no GUM to the fee address', async () => {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market,
                royalty: royaltyOf(env),
                tonPrice: 0n,
                jetton: { master: GUM_MASTER, price: GUM(100) },
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        await giveJettons(env.blockchain, env.buyer.address, GUM(100));
        await env.send(env.buyer, [
            buyJettonMessage({
                buyer: env.buyer.address,
                buyerJettonWallet: jettonWalletAddress(env.buyer.address),
                sale: l.address,
                price: GUM(100),
            }),
        ]);
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
        expect(await gumBalance(env, env.seller.address)).toBe(GUM(90));
        expect(await gumBalance(env, env.royaltyWallet.address)).toBe(GUM(10));
        expect(await gumBalance(env, env.feeWallet.address)).toBe(0n);
    });

    it('TON and GUM auctions: payout without fee', async () => {
        for (const jetton of [false, true]) {
            const nft = await env.mintTo(env.seller.address);
            const l = await buildAuctionListing(
                {
                    seller: env.seller.address,
                    nft: nft.address,
                    market,
                    royalty: royaltyOf(env),
                    minBid: jetton ? GUM(10) : toNano('1'),
                    maxBid: 0n,
                    stepPercent: 10,
                    endTime: env.blockchain.now! + 3600,
                    createdAt: env.blockchain.now,
                    jettonMaster: jetton ? GUM_MASTER : undefined,
                },
                env.resolveJettonWallet,
            );
            await env.send(env.seller, l.messages);
            const a = await listingOf(env, l.address, market);
            expect(a.status).toBe('active');
            if (jetton) {
                await giveJettons(env.blockchain, env.buyer.address, GUM(100));
                await env.send(env.buyer, [
                    bidJettonMessage({
                        bidder: env.buyer.address,
                        bidderJettonWallet: jettonWalletAddress(env.buyer.address),
                        auction: l.address,
                        amount: GUM(100),
                        buyout: false,
                    }),
                ]);
            } else {
                await env.send(env.buyer, [bidTonMessage(l.address, toNano('10'))]);
            }
            env.blockchain.now! += 3601;
            const res = await env.send(env.seller, [finishAuctionMessage(l.address, jetton)]);
            expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
            if (jetton) {
                expect(await gumBalance(env, env.seller.address)).toBe(GUM(90));
                expect(await gumBalance(env, env.royaltyWallet.address)).toBe(GUM(10));
                expect(await gumBalance(env, env.feeWallet.address)).toBe(0n);
            } else {
                expect(received0(res.transactions)).toBe(0n);
                expect(received(res.transactions, env.royaltyWallet.address)).toBeGreaterThan(toNano('0.99'));
                expect(received(res.transactions, env.seller.address)).toBeGreaterThan(toNano('8.9'));
            }
        }
    });
});

async function getData(env: Env, a: Address) {
    const acc = (await env.blockchain.getContract(a)).accountState;
    return acc?.type === 'active' ? acc.state.data : null;
}

describe('minimal amounts hold up', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    it('GUM auction with many outbids: every outbid bidder is refunded, finish pays out', async () => {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildAuctionListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                minBid: GUM(10),
                maxBid: 0n,
                stepPercent: 10,
                endTime: env.blockchain.now! + 3600,
                createdAt: env.blockchain.now,
                jettonMaster: GUM_MASTER,
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        await giveJettons(env.blockchain, env.buyer.address, GUM(1000));
        await giveJettons(env.blockchain, env.buyer2.address, GUM(1000));
        let bid = GUM(10);
        for (let i = 0; i < 8; i++) {
            const who = i % 2 ? env.buyer2 : env.buyer;
            await env.send(who, [
                bidJettonMessage({
                    bidder: who.address,
                    bidderJettonWallet: jettonWalletAddress(who.address),
                    auction: l.address,
                    amount: bid,
                    buyout: false,
                }),
            ]);
            expect((await auctionOf(env, l.address)).data.lastBid).toBe(bid);
            bid = (bid * 12n) / 10n;
        }
        const last = (await auctionOf(env, l.address)).data.lastBid;
        // the loser (buyer, bid #7) got everything back
        expect(await gumBalance(env, env.buyer.address)).toBe(GUM(1000));
        env.blockchain.now! += 3601;
        await env.send(env.seller, [finishAuctionMessage(l.address, true)]);
        expect((await nft.getNftData()).owner?.equals(env.buyer2.address)).toBe(true);
        expect(await gumBalance(env, env.buyer2.address)).toBe(GUM(1000) - last);
        expect(await gumBalance(env, env.seller.address)).toBe(last - (last * 5n) / 100n - (last * 10n) / 100n);
    });

    it('a sale listed 5 years ago still works (storage paid from the 0.02 TON deposit)', async () => {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                tonPrice: toNano('1'),
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, l.messages);
        env.blockchain.now! += 5 * 365 * 24 * 3600;
        const res = await env.send(env.buyer, [buyTonMessage(l.address, toNano('1'))]);
        expect(res.transactions).toHaveTransaction({ to: l.address, success: true });
        expect((await nft.getNftData()).owner?.equals(env.buyer.address)).toBe(true);
    });
});

describe('marketplace contract and listing checks', () => {
    let env: Env;
    beforeEach(async () => {
        env = await setup();
    });

    it('rejects listings with another marketplace, fee address or fee', async () => {
        const nft = await env.mintTo(env.seller.address);
        const variants: [string, Partial<MarketConfig>][] = [
            ['another marketplace', { marketplace: env.buyer.address }],
            ['wrong fee address', { feeAddress: env.buyer.address }],
            ['wrong fee', { fee: 1000 }],
        ];
        for (const [reason, change] of variants) {
            const l = await buildSaleListing(
                {
                    seller: env.seller.address,
                    nft: nft.address,
                    market: { ...env.market, ...change },
                    royalty: royaltyOf(env),
                    tonPrice: toNano('1'),
                },
                env.resolveJettonWallet,
            );
            // judge the would-be data against the real config
            const data = buildSaleData({
                marketplace: change.marketplace ?? env.market.marketplace,
                owner: env.seller.address,
                tonPrice: toNano('1'),
                feeAddress: change.feeAddress ?? env.market.feeAddress,
                royaltyAddress: env.royaltyWallet.address,
                fee: change.fee ?? env.market.fee,
                royalty: 10_000,
                nft: nft.address,
                createdAt: 1,
                jettonPrices: Dictionary.empty(Dictionary.Keys.BigUint(256), JettonPriceValue),
                publicKey: null,
            });
            const r = checkListing(l.address, SALE_CODE, data, env.market);
            expect(r).toEqual({ ok: false, reason });
        }
        const other = checkListing(
            env.seller.address,
            beginCell().storeUint(1, 8).endCell(),
            beginCell().endCell(),
            env.market,
        );
        expect(other).toEqual({ ok: false, reason: 'unknown code' });
    });

    it('signed deploy through the marketplace (op 1) works — the flow for a future backend', async () => {
        const nft = await env.mintTo(env.seller.address);
        const data = buildSaleData({
            marketplace: env.marketplace.address,
            owner: null,
            tonPrice: toNano('3'),
            feeAddress: env.feeWallet.address,
            royaltyAddress: env.royaltyWallet.address,
            fee: FEE,
            royalty: 10_000,
            nft: nft.address,
            createdAt: env.blockchain.now!,
            jettonPrices: Dictionary.empty(Dictionary.Keys.BigUint(256), JettonPriceValue),
            publicKey: null,
        });
        const init = { code: SALE_CODE, data };
        const blank = beginCell().storeUint(OP.saleDeployBlank, 32).storeUint(0, 64).endCell();
        const body = signedDeployBody(env.adminKey.secretKey, init, blank);
        const res = await env.seller.send({ to: env.marketplace.address, value: toNano('0.1'), body });
        const sale = contractAddress(0, init);
        expect(res.transactions).toHaveTransaction({
            from: env.marketplace.address,
            to: sale,
            deploy: true,
            success: true,
        });

        // a wrong signature is rejected
        const forged = signedDeployBody(Buffer.alloc(64, 1), init, blank);
        const bad = await env.seller.send({ to: env.marketplace.address, value: toNano('0.1'), body: forged });
        expect(bad.transactions).toHaveTransaction({ to: env.marketplace.address, success: false, exitCode: 35 });
    });

    it('admin rescue (op 555): an NFT sent to a sale without notification goes back', async () => {
        const nft = await env.mintTo(env.seller.address);
        const l = await buildSaleListing(
            {
                seller: env.seller.address,
                nft: nft.address,
                market: env.market,
                royalty: royaltyOf(env),
                tonPrice: toNano('1'),
            },
            env.resolveJettonWallet,
        );
        await env.send(env.seller, [l.messages[0]]); // deploy only
        // NFT transfer with forward_amount 0: the sale never learns it owns the NFT
        const plain = beginCell()
            .storeUint(OP.nftTransfer, 32)
            .storeUint(0, 64)
            .storeAddress(l.address)
            .storeAddress(env.seller.address)
            .storeBit(false)
            .storeCoins(0)
            .storeBit(false)
            .endCell();
        await env.seller.send({ to: nft.address, value: toNano('0.1'), body: plain });
        expect((await nft.getNftData()).owner?.equals(l.address)).toBe(true);
        expect((await saleOf(env, l.address)).status).toBe('waiting-nft');

        const back = beginCell()
            .storeUint(OP.nftTransfer, 32)
            .storeUint(0, 64)
            .storeAddress(env.seller.address)
            .storeAddress(env.seller.address)
            .storeBit(false)
            .storeCoins(0)
            .storeBit(false)
            .endCell();
        // admin actions are paid from the marketplace balance
        await env.admin.send({
            to: env.marketplace.address,
            value: toNano('1'),
            body: beginCell().storeUint(0, 32).storeStringTail('top up').endCell(),
        });
        await env.marketplace.sendRescue(
            env.adminKey.secretKey,
            l.address,
            internal({ to: nft.address, value: 0n, bounce: true, body: back }),
            toNano('0.1'),
        );
        expect((await nft.getNftData()).owner?.equals(env.seller.address)).toBe(true);
    });

    it('admin withdraws TON from the marketplace; a wrong key cannot', async () => {
        await env.admin.send({
            to: env.marketplace.address,
            value: toNano('1'),
            body: beginCell().storeUint(0, 32).storeStringTail('x').endCell(),
        });
        const res = await env.marketplace.sendWithdraw(env.adminKey.secretKey, env.admin.address, toNano('0.5'));
        expect(res.transactions).toHaveTransaction({
            from: env.marketplace.address,
            to: env.admin.address,
            value: toNano('0.5'),
        });
        await expect(
            env.marketplace.sendWithdraw(Buffer.alloc(64, 7), env.admin.address, toNano('0.1')),
        ).rejects.toThrow();
    });
});
