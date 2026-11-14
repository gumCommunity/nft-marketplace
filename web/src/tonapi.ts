// tonapi.io access for the stand: NFTs, raw contract state, get-methods, the marketplace's incoming registrations.
import { Address, Cell } from '@ton/core';
import { LISTINGS_LIMIT, MARKET, TONAPI_BASE, TONAPI_KEY } from './config';
import { checkListing, parseRegisterComment, type Listing, type Royalty } from './market';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Free tier: ~1 request per second. Requests are queued with a minimal gap; 429 is retried.
const GAP = TONAPI_KEY ? 120 : 1100;
let queue: Promise<unknown> = Promise.resolve();
let last = 0;

function api<T>(path: string, init?: RequestInit): Promise<T> {
    const run = async (): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
            const wait = last + GAP - Date.now();
            if (wait > 0) await sleep(wait);
            last = Date.now();
            const res = await fetch(TONAPI_BASE + path, {
                ...init,
                headers: { ...(TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {}), ...(init?.headers ?? {}) },
            });
            if (res.status === 429 && attempt < 6) {
                await sleep(1200 * (attempt + 1));
                continue;
            }
            if (res.status === 404) throw new NotFound(path);
            if (!res.ok) throw new Error(`tonapi ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return res.json() as Promise<T>;
        }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
}

export class NotFound extends Error {}

const enc = encodeURIComponent;

// ---------- get-methods ----------
type StackItem = { type: string; num?: string; cell?: string; slice?: string };

async function runGet(address: Address, method: string, args: string[] = []): Promise<StackItem[]> {
    const q = args.map((a) => `args=${enc(a)}`).join('&');
    const r = await api<{ success: boolean; exit_code: number; stack: StackItem[] }>(
        `/v2/blockchain/accounts/${enc(address.toRawString())}/methods/${method}${q ? '?' + q : ''}`,
    );
    if (!r.success) throw new Error(`${method} failed with exit code ${r.exit_code}`);
    return r.stack;
}

// tonapi returns numbers as hex strings, negative ones as "-0x1"
const num = (s: StackItem) => (s.num ? (s.num.startsWith('-') ? -BigInt(s.num.slice(1)) : BigInt(s.num)) : 0n);
const cellOf = (s: StackItem) => Cell.fromBoc(Buffer.from((s.cell ?? s.slice)!, 'hex'))[0];
const addrOf = (s: StackItem) => cellOf(s).beginParse().loadAddress();

/** get_wallet_address on a jetton master: the jetton wallet of `owner` (it does not need to exist yet). */
export async function jettonWalletOf(master: Address, owner: Address): Promise<Address> {
    // tonapi takes a slice argument as an address string
    return addrOf((await runGet(master, 'get_wallet_address', [owner.toRawString()]))[0]);
}

/** Collection royalty (royalty_params); null if the contract has none. */
export async function royaltyOf(contract: Address): Promise<Royalty | null> {
    try {
        const s = await runGet(contract, 'royalty_params');
        return { factor: Number(num(s[0])), base: Number(num(s[1])), address: addrOf(s[2]) };
    } catch {
        return null;
    }
}

export async function collectionData(collection: Address) {
    const s = await runGet(collection, 'get_collection_data');
    return { nextItemIndex: num(s[0]), owner: addrOf(s[2]) };
}

// ---------- accounts / NFTs / jettons ----------
export async function tonBalance(address: Address): Promise<bigint> {
    const r = await api<{ balance: number | string }>(`/v2/accounts/${enc(address.toRawString())}`);
    return BigInt(r.balance);
}

export type RawAccount = { status: string; code: Cell | null; data: Cell | null; lastLt: bigint };

export async function rawAccount(address: Address): Promise<RawAccount> {
    try {
        const r = await api<{ status: string; code?: string; data?: string; last_transaction_lt?: number | string }>(
            `/v2/blockchain/accounts/${enc(address.toRawString())}`,
        );
        const cell = (hex?: string) => (hex ? Cell.fromBoc(Buffer.from(hex, 'hex'))[0] : null);
        return { status: r.status, code: cell(r.code), data: cell(r.data), lastLt: BigInt(r.last_transaction_lt ?? 0) };
    } catch (e) {
        if (e instanceof NotFound) return { status: 'nonexist', code: null, data: null, lastLt: 0n };
        throw e;
    }
}

export type Nft = {
    address: Address;
    index: bigint;
    name: string;
    image?: string;
    owner: Address | null;
    collection: Address | null;
    collectionName?: string;
};

function toNft(i: any): Nft {
    return {
        address: Address.parse(i.address),
        index: BigInt(i.index ?? 0),
        name: i.metadata?.name ?? `NFT #${i.index ?? '?'}`,
        image: i.previews?.find((p: any) => p.resolution === '500x500')?.url ?? i.metadata?.image,
        owner: i.owner?.address ? Address.parse(i.owner.address) : null,
        collection: i.collection?.address ? Address.parse(i.collection.address) : null,
        collectionName: i.collection?.name,
    };
}

export async function nftsOf(owner: Address): Promise<Nft[]> {
    const r = await api<{ nft_items: any[] }>(
        `/v2/accounts/${enc(owner.toRawString())}/nfts?limit=200&indirect_ownership=false`,
    );
    return r.nft_items.map(toNft);
}

export async function nftInfo(nft: Address): Promise<Nft> {
    return toNft(await api<any>(`/v2/nfts/${enc(nft.toRawString())}`));
}

/** Jetton balance of `owner` (0 if no wallet). */
export async function jettonBalance(owner: Address, master: Address): Promise<bigint> {
    try {
        const r = await api<{ balance: string }>(
            `/v2/accounts/${enc(owner.toRawString())}/jettons/${enc(master.toRawString())}`,
        );
        return BigInt(r.balance);
    } catch (e) {
        if (e instanceof NotFound) return 0n;
        throw e;
    }
}

// ---------- listings ----------
/** Listing addresses from the latest registration comments sent to the marketplace (newest first, unique). */
export async function registeredListings(marketplace: Address): Promise<Address[]> {
    const r = await api<{ transactions: any[] }>(
        `/v2/blockchain/accounts/${enc(marketplace.toRawString())}/transactions?limit=100`,
    );
    const out: Address[] = [];
    const seen = new Set<string>();
    for (const t of r.transactions) {
        const m = t.in_msg;
        if (!m?.raw_body) continue;
        let text = '';
        try {
            const s = Cell.fromBoc(Buffer.from(m.raw_body, 'hex'))[0].beginParse();
            if (s.remainingBits < 32 || s.loadUint(32) !== 0) continue;
            text = s.loadStringTail();
        } catch {
            continue;
        }
        const a = parseRegisterComment(text);
        if (!a || seen.has(a.toRawString())) continue;
        seen.add(a.toRawString());
        out.push(a);
        if (out.length >= LISTINGS_LIMIT) break;
    }
    return out;
}

export type CheckedListing = { listing: Listing; nft: Nft | null; problem?: string; lastLt: bigint };

/**
 * Full check of one listing: code hash + data (checkListing), then on-chain facts get-methods cannot prove:
 * the NFT really belongs to the listing, and a jetton price/auction uses the listing's own jetton wallet.
 */
export async function loadListing(address: Address): Promise<CheckedListing | null> {
    if (!MARKET) return null;
    const acc = await rawAccount(address);
    if (acc.status !== 'active' || !acc.code || !acc.data) return null;
    const r = checkListing(address, acc.code, acc.data, MARKET);
    if (!r.ok) return null; // not ours: ignore silently
    const l = r.listing;
    const live = l.status === 'active' || l.status === 'ended';
    let nft: Nft | null = null;
    let problem: string | undefined;
    try {
        nft = await nftInfo(l.data.nft);
    } catch {
        /* metadata is optional */
    }
    if (live) {
        if (!nft?.owner || !nft.owner.equals(address)) problem = 'the NFT is not held by this listing';
        else if (l.kind === 'sale') {
            for (const [key, p] of l.data.jettonPrices) {
                const w = await jettonWalletOf(p.master, address);
                if (BigInt('0x' + w.hash.toString('hex')) !== key)
                    problem = 'jetton price is bound to a wrong jetton wallet';
            }
        } else if (l.data.jettonMaster && l.data.jettonWallet) {
            const w = await jettonWalletOf(l.data.jettonMaster, address);
            if (!w.equals(l.data.jettonWallet)) problem = 'auction uses a wrong jetton wallet';
        }
    }
    return { listing: l, nft, problem, lastLt: acc.lastLt };
}

/** Logical time of the account's last transaction: changes when the contract processes a message. */
export async function lastLt(address: Address): Promise<bigint> {
    return (await rawAccount(address)).lastLt;
}
