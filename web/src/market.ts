// Marketplace logic shared by the page and the sandbox tests: no browser APIs, no network.
// - builds the exact TON Connect messages the page asks the wallet to sign (list, buy, bid, cancel, finish, mint);
// - parses sale/auction contract data and decides whether a contract is a valid listing of OUR marketplace.
//
// Contracts are the unmodified Getgems ones (see codes.ts). Layouts follow getgems-io/nft-contracts:
// nft-fixprice-sale-v4/NftFixPriceSaleV4.data.ts and nft-auction-v2/NftAuctionV4R1.data.ts.
import {
    Address,
    beginCell,
    Cell,
    contractAddress,
    Dictionary,
    type DictionaryValue,
    type StateInit,
    storeStateInit,
} from '@ton/core';
import nacl from 'tweetnacl';
import { AUCTION_CODE_BOC, COLLECTION_CODE_BOC, ITEM_CODE_BOC, MARKETPLACE_CODE_BOC, SALE_CODE_BOC } from './codes';

export const SALE_CODE = Cell.fromBase64(SALE_CODE_BOC);
export const AUCTION_CODE = Cell.fromBase64(AUCTION_CODE_BOC);
export const MARKETPLACE_CODE = Cell.fromBase64(MARKETPLACE_CODE_BOC);
export const COLLECTION_CODE = Cell.fromBase64(COLLECTION_CODE_BOC);
export const ITEM_CODE = Cell.fromBase64(ITEM_CODE_BOC);

export const SALE_CODE_HASH = SALE_CODE.hash().toString('hex');
export const AUCTION_CODE_HASH = AUCTION_CODE.hash().toString('hex');

/** Percents in contracts are integers over this base: 5000 = 5%. */
export const PERCENT_BASE = 100_000;

const TON = 1_000_000_000n;
const ton = (x: string) => {
    const [i, f = ''] = x.split('.');
    return BigInt(i) * TON + BigInt((f + '000000000').slice(0, 9));
};

// ---------- amounts (TON attached to each transaction; unused TON comes back as excess where noted) ----------
export const AMOUNTS = {
    /** stays on the sale/auction contract as its balance (storage, later returned with the NFT or to the buyer) */
    deploy: ton('0.05'),
    /** NFT transfer to the sale/auction; excess returns to the seller */
    nftTransfer: ton('0.1'),
    /** TON forwarded to the sale/auction with ownership_assigned (activates it) */
    nftForward: ton('0.03'),
    /** registration note to the marketplace contract (how the stand finds listings) */
    register: ton('0.01'),
    /** fixed price sale: TON on top of the price; the contract requires >= 0.1, the rest returns with the NFT */
    buyGas: ton('0.1'),
    /** jetton purchase: forward_ton_amount (contract requires >= 0.26) and the total attached to the jetton transfer */
    jettonBuyForward: ton('0.3'),
    jettonBuyTotal: ton('0.4'),
    /** jetton bid: forward_ton_amount for a normal bid (>= 0.05) / a buyout bid (>= 0.25), and the total */
    jettonBidForward: ton('0.1'),
    jettonBuyoutForward: ton('0.3'),
    jettonBidExtra: ton('0.1'),
    /** TON auction buyout needs max_bid + 0.1 */
    tonBuyoutGas: ton('0.1'),
    /** cancel sale / cancel auction (>= 0.1; for a sale the unused part returns) */
    cancel: ton('0.1'),
    /** finish auction: 0.1 for TON, 0.25 for jetton auctions (contract minimum) */
    finishTon: ton('0.1'),
    finishJetton: ton('0.25'),
    /** test collection mint: TON to the collection / TON passed to the new item */
    mint: ton('0.1'),
    mintItem: ton('0.05'),
};

// ---------- op codes ----------
export const OP = {
    nftTransfer: 0x5fcc3d14,
    ownershipAssigned: 0x05138d91,
    jettonTransfer: 0x0f8a7ea5,
    saleDeployBlank: 0x664c0905,
    saleDeployJetton: 0xfb5dbf47,
    saleBuy: 2,
    saleCancel: 3,
    saleChangePrice: 0xfd135f7b,
    auctionDeploy: crc32('deploy_auction'),
    auctionSetJettonWallet: crc32('set_jetton_wallet'),
    auctionBid: crc32('process_ton_bid'),
    auctionFinish: crc32('finish_auction'),
    auctionCancel: crc32('cancel_auction'),
    marketplaceDeploySale: 1,
};

/** FunC "string"c constants are CRC-32 (IEEE) of the string. */
export function crc32(s: string): number {
    let crc = 0xffffffff;
    for (const b of new TextEncoder().encode(s)) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ---------- types ----------
/** Marketplace settings for one network (deployments.json). */
export type MarketConfig = {
    marketplace: Address;
    feeAddress: Address;
    /** marketplace fee over PERCENT_BASE (5000 = 5%) */
    fee: number;
    /** jettons the stand accepts (by master) */
    jettons: { symbol: string; master: Address; decimals: number }[];
};

/** Collection royalty as returned by royalty_params(): factor/base. */
export type Royalty = { address: Address; factor: number; base: number };

/** A message for TonConnectUI.sendTransaction (amount in nanoTON as string, cells as base64 BOC). */
export type TcMessage = { address: string; amount: string; payload?: string; stateInit?: string };

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

/** Resolves the jetton wallet of `owner` for jetton `master` (get_wallet_address on the master). */
export type JettonWalletResolver = (master: Address, owner: Address) => Promise<Address>;

const b64 = (c: Cell) => c.toBoc().toString('base64');
const friendly = (a: Address) => a.toString({ bounceable: true, urlSafe: true });
const msg = (to: Address, amount: bigint, payload?: Cell, init?: StateInit): TcMessage => ({
    address: friendly(to),
    amount: amount.toString(),
    ...(payload ? { payload: b64(payload) } : {}),
    ...(init ? { stateInit: b64(beginCell().store(storeStateInit(init)).endCell()) } : {}),
});
const sign = (data: Cell, kp: KeyPair) => Buffer.from(nacl.sign.detached(data.hash(), kp.secretKey));
export const newKeyPair = (): KeyPair => nacl.sign.keyPair();

/** Royalty in PERCENT_BASE units (fixed price sale stores it this way). Rounded down. */
export function royaltyPercent(r: Royalty): number {
    return r.base > 0 ? Math.floor((r.factor * PERCENT_BASE) / r.base) : 0;
}

// ---------- common messages ----------
/** TEP-62 NFT transfer to a sale/auction; ownership_assigned (with nftForward TON) activates the contract. */
export function nftTransferMessage(nft: Address, to: Address, responseTo: Address, queryId = 0n): TcMessage {
    const body = beginCell()
        .storeUint(OP.nftTransfer, 32)
        .storeUint(queryId, 64)
        .storeAddress(to)
        .storeAddress(responseTo)
        .storeBit(false)
        .storeCoins(AMOUNTS.nftForward)
        .storeBit(false)
        .endCell();
    return msg(nft, AMOUNTS.nftTransfer, body);
}

/** Text comment to the marketplace contract: the stand reads these to find listings (it ignores them otherwise). */
export function registerMessage(marketplace: Address, listing: Address): TcMessage {
    return msg(marketplace, AMOUNTS.register, comment(`listing:${listing.toRawString()}`));
}

export function comment(text: string): Cell {
    return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

/** Extracts the listing address from a registration comment, or null. */
export function parseRegisterComment(text: string): Address | null {
    const m = /^listing:(-?\d+:[0-9a-fA-F]{64})$/.exec(text.trim());
    if (!m) return null;
    try {
        return Address.parseRaw(m[1]);
    } catch {
        return null;
    }
}

/** TEP-74 jetton transfer from the user's jetton wallet. */
export function jettonTransferMessage(opts: {
    userJettonWallet: Address;
    to: Address;
    amount: bigint;
    responseTo: Address;
    forwardTon: bigint;
    total: bigint;
    queryId?: bigint;
}): TcMessage {
    const body = beginCell()
        .storeUint(OP.jettonTransfer, 32)
        .storeUint(opts.queryId ?? 0n, 64)
        .storeCoins(opts.amount)
        .storeAddress(opts.to)
        .storeAddress(opts.responseTo)
        .storeBit(false)
        .storeCoins(opts.forwardTon)
        .storeBit(false)
        .endCell();
    return msg(opts.userJettonWallet, opts.total, body);
}

// =====================================================================================================
// Fixed price sale (nft-fixprice-sale-v4r1)
// =====================================================================================================

export type JettonPrice = { price: bigint; master: Address };

export const JettonPriceValue: DictionaryValue<JettonPrice> = {
    serialize(src, builder) {
        builder.storeCoins(src.price).storeAddress(src.master);
    },
    parse(slice) {
        return { price: slice.loadCoins(), master: slice.loadAddress() };
    },
};

export type SaleData = {
    complete: boolean;
    marketplace: Address;
    owner: Address | null;
    tonPrice: bigint;
    soldAt: number;
    soldQueryId: bigint;
    feeAddress: Address;
    royaltyAddress: Address;
    fee: number;
    royalty: number;
    nft: Address;
    createdAt: number;
    /** key: hash of the sale's jetton wallet address */
    jettonPrices: Dictionary<bigint, JettonPrice>;
    publicKey: Buffer | null;
};

export function buildSaleData(d: Omit<SaleData, 'soldAt' | 'soldQueryId' | 'complete'>): Cell {
    return beginCell()
        .storeBit(false) // is_complete
        .storeAddress(d.marketplace)
        .storeAddress(d.owner)
        .storeCoins(d.tonPrice)
        .storeUint(0, 32) // sold_at
        .storeUint(0, 64) // sold_query_id
        .storeRef(
            beginCell()
                .storeAddress(d.feeAddress)
                .storeAddress(d.royaltyAddress)
                .storeUint(d.fee, 17)
                .storeUint(d.royalty, 17)
                .storeAddress(d.nft)
                .storeUint(d.createdAt, 32)
                .endCell(),
        )
        .storeDict(d.jettonPrices.size ? d.jettonPrices : null)
        .storeMaybeBuffer(d.publicKey, 32)
        .endCell();
}

export function parseSaleData(data: Cell): SaleData {
    const s = data.beginParse();
    const complete = s.loadBit();
    const marketplace = s.loadAddress();
    const owner = s.loadMaybeAddress();
    const tonPrice = s.loadCoins();
    const soldAt = s.loadUint(32);
    const soldQueryId = s.loadUintBig(64);
    const st = s.loadRef().beginParse();
    const feeAddress = st.loadAddress();
    const royaltyAddress = st.loadAddress();
    const fee = st.loadUint(17);
    const royalty = st.loadUint(17);
    const nft = st.loadAddress();
    const createdAt = st.loadUint(32);
    const jettonPrices = s.loadDict(Dictionary.Keys.BigUint(256), JettonPriceValue);
    const publicKey = s.remainingBits > 0 && s.loadBit() ? s.loadBuffer(32) : null;
    return {
        complete,
        marketplace,
        owner,
        tonPrice,
        soldAt,
        soldQueryId,
        feeAddress,
        royaltyAddress,
        fee,
        royalty,
        nft,
        createdAt,
        jettonPrices,
        publicKey,
    };
}

export type SaleListingInput = {
    seller: Address;
    nft: Address;
    market: MarketConfig;
    royalty: Royalty;
    /** price in TON (nanoTON); 0 = cannot be bought for TON */
    tonPrice: bigint;
    /** optional price in a jetton (units) */
    jetton?: JettonPrice;
    createdAt?: number;
    keyPair?: KeyPair;
};

/**
 * Listing for a fixed price, without a backend: one wallet transaction with 3 messages.
 * 1. deploys the sale. For a jetton price the sale starts with marketplace = seller and a one-time key, and the same message
 *    (deploy_jetton, signed by that key) sets the jetton price and hands the marketplace role to our marketplace contract —
 *    the sale's jetton wallet depends on the sale address, so the price cannot be in the initial data.
 *    This is how Getgems builds it (buildNftFixPriceSaleV4R1DeployData), with the seller as the deployer.
 * 2. transfers the NFT to the sale (ownership_assigned activates it).
 * 3. registers the sale with the marketplace contract (a comment the stand reads).
 */
export async function buildSaleListing(input: SaleListingInput, resolveJettonWallet: JettonWalletResolver) {
    const { seller, nft, market, royalty } = input;
    if (input.tonPrice <= 0n && !input.jetton) throw new Error('Set a TON price or a jetton price');
    if (input.jetton && input.jetton.price <= 0n) throw new Error('Jetton price must be positive');
    const rp = royaltyPercent(royalty);
    if (market.fee + rp >= PERCENT_BASE) throw new Error('Fee + royalty must be below 100%');

    const kp = input.jetton ? (input.keyPair ?? newKeyPair()) : null;
    const data = buildSaleData({
        marketplace: kp ? seller : market.marketplace,
        owner: null,
        tonPrice: input.tonPrice,
        feeAddress: market.feeAddress,
        royaltyAddress: royalty.address,
        fee: market.fee,
        royalty: rp,
        nft,
        createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
        jettonPrices: Dictionary.empty(Dictionary.Keys.BigUint(256), JettonPriceValue),
        publicKey: kp ? Buffer.from(kp.publicKey) : null,
    });
    const init: StateInit = { code: SALE_CODE, data };
    const address = contractAddress(0, init);

    let body: Cell;
    if (kp && input.jetton) {
        const saleJettonWallet = await resolveJettonWallet(input.jetton.master, address);
        const prices = Dictionary.empty(Dictionary.Keys.BigUint(256), JettonPriceValue);
        prices.set(BigInt('0x' + saleJettonWallet.hash.toString('hex')), input.jetton);
        const signed = beginCell().storeAddress(market.marketplace).storeDict(prices).endCell();
        body = beginCell()
            .storeUint(OP.saleDeployJetton, 32)
            .storeUint(0, 64)
            .storeBuffer(sign(signed, kp), 64)
            .storeAddress(market.marketplace)
            .storeDict(prices)
            .endCell();
    } else {
        body = beginCell().storeUint(OP.saleDeployBlank, 32).storeUint(0, 64).endCell();
    }

    return {
        address,
        messages: [
            msg(address, AMOUNTS.deploy, body, init),
            nftTransferMessage(nft, address, seller),
            registerMessage(market.marketplace, address),
        ],
    };
}

/** Buy for TON: price + 0.1 TON (the contract minimum); the unused TON comes back with the NFT. */
export function buyTonMessage(sale: Address, tonPrice: bigint, queryId = 0n): TcMessage {
    return msg(sale, tonPrice + AMOUNTS.buyGas, beginCell().storeUint(OP.saleBuy, 32).storeUint(queryId, 64).endCell());
}

/** Buy for a jetton: transfer the price from the buyer's jetton wallet to the sale. Wrong amount/jetton is refunded. */
export function buyJettonMessage(opts: {
    buyer: Address;
    buyerJettonWallet: Address;
    sale: Address;
    price: bigint;
}): TcMessage {
    return jettonTransferMessage({
        userJettonWallet: opts.buyerJettonWallet,
        to: opts.sale,
        amount: opts.price,
        responseTo: opts.buyer,
        forwardTon: AMOUNTS.jettonBuyForward,
        total: AMOUNTS.jettonBuyTotal,
    });
}

/** Cancel a sale (seller or marketplace): the NFT goes back to the seller. */
export function cancelSaleMessage(sale: Address, queryId = 0n): TcMessage {
    return msg(sale, AMOUNTS.cancel, beginCell().storeUint(OP.saleCancel, 32).storeUint(queryId, 64).endCell());
}

// =====================================================================================================
// Auction (nft-auction-v4r1)
// =====================================================================================================

export type AuctionData = {
    end: boolean;
    canceled: boolean;
    lastMember: Address | null;
    lastBid: bigint;
    lastBidAt: number;
    endTime: number;
    owner: Address | null;
    lastQueryId: bigint;
    feeAddress: Address;
    royaltyAddress: Address;
    feeFactor: number;
    feeBase: number;
    royaltyFactor: number;
    royaltyBase: number;
    marketplace: Address;
    minBid: bigint;
    maxBid: bigint;
    stepPercent: number;
    stepTime: number;
    nft: Address;
    createdAt: number;
    jettonWallet: Address | null;
    jettonMaster: Address | null;
    publicKey: Buffer | null;
};

export function buildAuctionData(
    d: Omit<AuctionData, 'end' | 'canceled' | 'lastMember' | 'lastBid' | 'lastBidAt' | 'lastQueryId' | 'owner'>,
): Cell {
    if (d.stepPercent < 1 || d.stepPercent > 100) throw new Error('Bid step must be 1..100%');
    const constants = beginCell()
        .storeAddress(d.marketplace)
        .storeCoins(d.minBid)
        .storeCoins(d.maxBid)
        .storeUint(d.stepPercent, 7)
        .storeUint(d.stepTime, 17)
        .storeAddress(d.nft)
        .storeUint(d.createdAt, 32)
        .endCell();
    const fees = beginCell()
        .storeAddress(d.feeAddress)
        .storeAddress(d.royaltyAddress)
        .storeUint(d.feeFactor, 32)
        .storeUint(d.feeBase, 32)
        .storeUint(d.royaltyFactor, 32)
        .storeUint(d.royaltyBase, 32)
        .endCell();
    const b = beginCell()
        .storeBit(false) // end?
        .storeBit(false) // is_canceled?
        .storeAddress(null) // last_member
        .storeCoins(0) // last_bid
        .storeUint(0, 32) // last_bid_at
        .storeUint(d.endTime, 32)
        .storeAddress(null) // nft_owner: set by ownership_assigned
        .storeUint(0, 64) // last_query_id
        .storeRef(fees)
        .storeRef(constants);
    if (d.jettonWallet || d.jettonMaster || d.publicKey) {
        const jt = beginCell().storeAddress(d.jettonWallet).storeAddress(d.jettonMaster).storeBit(!!d.publicKey);
        if (d.publicKey) jt.storeBuffer(d.publicKey, 32);
        b.storeBit(true).storeRef(jt.endCell());
    } else {
        b.storeBit(false);
    }
    return b.endCell();
}

export function parseAuctionData(data: Cell): AuctionData {
    const s = data.beginParse();
    const end = s.loadBit();
    const canceled = s.loadBit();
    const lastMember = s.loadMaybeAddress();
    const lastBid = s.loadCoins();
    const lastBidAt = s.loadUint(32);
    const endTime = s.loadUint(32);
    const owner = s.loadMaybeAddress();
    const lastQueryId = s.loadUintBig(64);
    const f = s.loadRef().beginParse();
    const feeAddress = f.loadAddress();
    const royaltyAddress = f.loadAddress();
    const feeFactor = f.loadUint(32);
    const feeBase = f.loadUint(32);
    const royaltyFactor = f.loadUint(32);
    const royaltyBase = f.loadUint(32);
    const c = s.loadRef().beginParse();
    const marketplace = c.loadAddress();
    const minBid = c.loadCoins();
    const maxBid = c.loadCoins();
    const stepPercent = c.loadUint(7);
    const stepTime = c.loadUint(17);
    const nft = c.loadAddress();
    const createdAt = c.loadUint(32);
    let jettonWallet: Address | null = null;
    let jettonMaster: Address | null = null;
    let publicKey: Buffer | null = null;
    if (s.loadBit()) {
        const j = s.loadRef().beginParse();
        jettonWallet = j.loadMaybeAddress();
        jettonMaster = j.loadMaybeAddress();
        if (j.loadBit()) publicKey = j.loadBuffer(32);
    }
    return {
        end,
        canceled,
        lastMember,
        lastBid,
        lastBidAt,
        endTime,
        owner,
        lastQueryId,
        feeAddress,
        royaltyAddress,
        feeFactor,
        feeBase,
        royaltyFactor,
        royaltyBase,
        marketplace,
        minBid,
        maxBid,
        stepPercent,
        stepTime,
        nft,
        createdAt,
        jettonWallet,
        jettonMaster,
        publicKey,
    };
}

/** math::check_profitable in the auction: from 10 TON something must be left for the seller (base 0 = no fee). */
export function auctionProfitable(
    feeFactor: number,
    feeBase: number,
    royaltyFactor: number,
    royaltyBase: number,
): boolean {
    const amount = 10_000_000_000n;
    const part = (f: number, b: number) => (b === 0 ? 0n : (amount * BigInt(f)) / BigInt(b));
    return amount - part(feeFactor, feeBase) - part(royaltyFactor, royaltyBase) >= 1n;
}

/** The contract rejects bids while the auction is longer than this (counted from the bid). */
export const AUCTION_MAX_DURATION = 20 * 24 * 3600;

export type AuctionListingInput = {
    seller: Address;
    nft: Address;
    market: MarketConfig;
    royalty: Royalty;
    /** in TON or in the jetton's units */
    minBid: bigint;
    /** buyout price; 0 = no buyout */
    maxBid: bigint;
    /** each next bid is at least +stepPercent% (TON auctions: and at least +0.1 TON) */
    stepPercent: number;
    endTime: number;
    /** a bid in the last stepTime seconds extends the auction by stepTime */
    stepTime?: number;
    /** jetton auction: bids only in this jetton */
    jettonMaster?: Address;
    createdAt?: number;
    keyPair?: KeyPair;
};

/**
 * Auction listing without a backend: one wallet transaction with 3 messages (deploy, NFT transfer, register).
 * Jetton auctions start with jetton_wallet = seller and a one-time key; the deploy message (set_jetton_wallet, signed by
 * that key and sent by the seller) sets the auction's own jetton wallet. Same as Getgems' buildNftAuctionV4R1DeployData.
 */
export async function buildAuctionListing(input: AuctionListingInput, resolveJettonWallet: JettonWalletResolver) {
    const { seller, nft, market, royalty } = input;
    if (input.minBid <= 0n) throw new Error('Minimal bid must be positive');
    if (input.maxBid !== 0n && input.maxBid < input.minBid)
        throw new Error('Buyout price must be at least the minimal bid');
    const now = Math.floor(Date.now() / 1000);
    const createdAt = input.createdAt ?? now;
    if (input.endTime <= createdAt) throw new Error('End time must be in the future');
    if (input.endTime - createdAt > AUCTION_MAX_DURATION) throw new Error('Auction cannot be longer than 20 days');
    if (!auctionProfitable(market.fee, PERCENT_BASE, royalty.factor, royalty.base))
        throw new Error('Fee + royalty must be below 100%');

    const kp = input.jettonMaster ? (input.keyPair ?? newKeyPair()) : null;
    const data = buildAuctionData({
        feeAddress: market.feeAddress,
        feeFactor: market.fee,
        feeBase: PERCENT_BASE,
        royaltyAddress: royalty.address,
        royaltyFactor: royalty.factor,
        royaltyBase: royalty.base,
        marketplace: market.marketplace,
        minBid: input.minBid,
        maxBid: input.maxBid,
        stepPercent: input.stepPercent,
        stepTime: input.stepTime ?? 300,
        endTime: input.endTime,
        nft,
        createdAt,
        jettonWallet: kp ? seller : null,
        jettonMaster: input.jettonMaster ?? null,
        publicKey: kp ? Buffer.from(kp.publicKey) : null,
    });
    const init: StateInit = { code: AUCTION_CODE, data };
    const address = contractAddress(0, init);

    let body: Cell;
    if (kp && input.jettonMaster) {
        const auctionJettonWallet = await resolveJettonWallet(input.jettonMaster, address);
        const signed = beginCell().storeAddress(auctionJettonWallet).endCell();
        body = beginCell()
            .storeUint(OP.auctionSetJettonWallet, 32)
            .storeUint(0, 64)
            .storeBuffer(sign(signed, kp), 64)
            .storeAddress(auctionJettonWallet)
            .endCell();
    } else {
        body = beginCell().storeUint(OP.auctionDeploy, 32).storeUint(0, 64).endCell();
    }

    return {
        address,
        messages: [
            msg(address, AMOUNTS.deploy, body, init),
            nftTransferMessage(nft, address, seller),
            registerMessage(market.marketplace, address),
        ],
    };
}

/** Same rule as get_next_min_bid() in the contract. */
export function nextMinBid(a: Pick<AuctionData, 'lastBid' | 'minBid' | 'stepPercent' | 'jettonWallet'>): bigint {
    if (a.lastBid === 0n) return a.minBid;
    const byPercent = (a.lastBid * BigInt(100 + a.stepPercent)) / 100n;
    if (a.jettonWallet) return byPercent;
    const byTon = a.lastBid + 100_000_000n;
    return byTon > byPercent ? byTon : byPercent;
}

/**
 * TON bid. The whole attached value is the bid (the contract counts msg_value), so `amount` is exactly what is sent.
 * For a buyout (amount >= max_bid) the contract wants max_bid + 0.1 TON; the bid recorded is max_bid.
 */
export function bidTonMessage(auction: Address, amount: bigint, queryId = 0n): TcMessage {
    return msg(auction, amount, beginCell().storeUint(OP.auctionBid, 32).storeUint(queryId, 64).endCell());
}

/** Jetton bid: a jetton transfer to the auction. A rejected bid is refunded in the same jetton. */
export function bidJettonMessage(opts: {
    bidder: Address;
    bidderJettonWallet: Address;
    auction: Address;
    amount: bigint;
    buyout: boolean;
}): TcMessage {
    const forwardTon = opts.buyout ? AMOUNTS.jettonBuyoutForward : AMOUNTS.jettonBidForward;
    return jettonTransferMessage({
        userJettonWallet: opts.bidderJettonWallet,
        to: opts.auction,
        amount: opts.amount,
        responseTo: opts.bidder,
        forwardTon,
        total: forwardTon + AMOUNTS.jettonBidExtra,
    });
}

/** Cancel an auction without bids before its end (seller or marketplace). */
export function cancelAuctionMessage(auction: Address, queryId = 0n): TcMessage {
    return msg(auction, AMOUNTS.cancel, beginCell().storeUint(OP.auctionCancel, 32).storeUint(queryId, 64).endCell());
}

/** Finish after end_time (seller, marketplace or the last bidder): NFT to the winner, payouts to seller/fee/royalty. */
export function finishAuctionMessage(auction: Address, jettonMode: boolean, queryId = 0n): TcMessage {
    return msg(
        auction,
        jettonMode ? AMOUNTS.finishJetton : AMOUNTS.finishTon,
        beginCell().storeUint(OP.auctionFinish, 32).storeUint(queryId, 64).endCell(),
    );
}

/** External finish (anyone, no wallet): the auction pays the gas from its balance. */
export function finishAuctionExternal(queryId = 0n): Cell {
    return beginCell().storeUint(OP.auctionFinish, 32).storeUint(queryId, 64).endCell();
}

// =====================================================================================================
// Validation: is this contract a listing of OUR marketplace?
// =====================================================================================================

export type SaleStatus = 'waiting-nft' | 'active' | 'sold' | 'canceled';
export type AuctionStatus = 'waiting-nft' | 'active' | 'ended' | 'sold' | 'canceled' | 'broken';

export type Listing =
    | { kind: 'sale'; address: Address; data: SaleData; status: SaleStatus }
    | { kind: 'auction'; address: Address; data: AuctionData; status: AuctionStatus };

export type CheckResult = { ok: true; listing: Listing } | { ok: false; reason: string };

/**
 * Checks code hash and data of a contract claimed to be a listing. Never trust get-methods alone (Getgems' advice):
 * the code must be the pinned one, and the marketplace, fee address and fee must be ours.
 * Async checks (NFT owner, jetton wallet address) are done by the caller: see checkListingOnChain in tonapi.ts.
 */
export function checkListing(
    address: Address,
    code: Cell,
    data: Cell,
    market: MarketConfig,
    now = Math.floor(Date.now() / 1000),
): CheckResult {
    const hash = code.hash().toString('hex');
    try {
        if (hash === SALE_CODE_HASH) {
            const d = parseSaleData(data);
            if (!d.marketplace.equals(market.marketplace)) return { ok: false, reason: 'another marketplace' };
            if (!d.feeAddress.equals(market.feeAddress)) return { ok: false, reason: 'wrong fee address' };
            if (d.fee !== market.fee) return { ok: false, reason: 'wrong fee' };
            if (d.fee + d.royalty >= PERCENT_BASE) return { ok: false, reason: 'fee + royalty >= 100%' };
            if (d.nft.workChain !== 0) return { ok: false, reason: 'NFT not in basechain' };
            for (const [, p] of d.jettonPrices) {
                if (!market.jettons.some((j) => j.master.equals(p.master)))
                    return { ok: false, reason: 'unknown jetton' };
            }
            const status: SaleStatus = d.complete
                ? d.soldAt
                    ? 'sold'
                    : 'canceled'
                : d.owner
                  ? 'active'
                  : 'waiting-nft';
            return { ok: true, listing: { kind: 'sale', address, data: d, status } };
        }
        if (hash === AUCTION_CODE_HASH) {
            const d = parseAuctionData(data);
            if (!d.marketplace.equals(market.marketplace)) return { ok: false, reason: 'another marketplace' };
            if (!d.feeAddress.equals(market.feeAddress)) return { ok: false, reason: 'wrong fee address' };
            if (
                d.feeBase === 0 ||
                BigInt(d.feeFactor) * BigInt(PERCENT_BASE) !== BigInt(market.fee) * BigInt(d.feeBase)
            )
                return { ok: false, reason: 'wrong fee' };
            if (!auctionProfitable(d.feeFactor, d.feeBase, d.royaltyFactor, d.royaltyBase))
                return { ok: false, reason: 'fee + royalty >= 100%' };
            if (d.jettonMaster && !market.jettons.some((j) => j.master.equals(d.jettonMaster!)))
                return { ok: false, reason: 'unknown jetton' };
            let status: AuctionStatus;
            if (d.publicKey || (d.jettonMaster && !d.jettonWallet)) status = 'broken';
            else if (!d.owner) status = 'waiting-nft';
            else if (d.end) status = d.canceled ? 'canceled' : 'sold';
            else status = now >= d.endTime ? 'ended' : 'active';
            return { ok: true, listing: { kind: 'auction', address, data: d, status } };
        }
    } catch (e) {
        return { ok: false, reason: `bad data: ${(e as Error).message}` };
    }
    return { ok: false, reason: 'unknown code' };
}

// =====================================================================================================
// Test collection (nft-collection-editable + nft-item), used by the stand and deploy scripts
// =====================================================================================================

export type TestCollectionConfig = {
    owner: Address;
    /** URL of collection.json */
    collectionContent: string;
    /** prefix for item content (item content = prefix + suffix) */
    commonContent: string;
    royalty: Royalty;
};

export function buildCollectionData(c: TestCollectionConfig): Cell {
    const collectionContent = beginCell().storeUint(0x01, 8).storeStringTail(c.collectionContent).endCell(); // off-chain
    const commonContent = beginCell().storeStringTail(c.commonContent).endCell();
    return beginCell()
        .storeAddress(c.owner)
        .storeUint(0, 64) // next_item_index
        .storeRef(beginCell().storeRef(collectionContent).storeRef(commonContent).endCell())
        .storeRef(ITEM_CODE)
        .storeRef(
            beginCell()
                .storeUint(c.royalty.factor, 16)
                .storeUint(c.royalty.base, 16)
                .storeAddress(c.royalty.address)
                .endCell(),
        )
        .endCell();
}

export function testCollectionInit(c: TestCollectionConfig): StateInit {
    return { code: COLLECTION_CODE, data: buildCollectionData(c) };
}

/** Item content of the test collection: 4 designs (web/public/test-nft/0..3.json) in turn. */
export const testItemContent = (index: bigint) => `${index % 4n}.json`;

/** Mint (op 1) from the collection owner: item `index` (must be <= next_item_index) owned by `to`. */
export function mintMessage(
    collection: Address,
    index: bigint,
    to: Address,
    contentSuffix: string,
    queryId = 0n,
): TcMessage {
    const body = beginCell()
        .storeUint(1, 32)
        .storeUint(queryId, 64)
        .storeUint(index, 64)
        .storeCoins(AMOUNTS.mintItem)
        .storeRef(beginCell().storeAddress(to).storeRef(beginCell().storeStringTail(contentSuffix).endCell()).endCell())
        .endCell();
    return msg(collection, AMOUNTS.mint, body);
}
