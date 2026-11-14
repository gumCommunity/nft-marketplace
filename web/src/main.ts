import './polyfills';
import './style.css';
import { Address } from '@ton/core';
import { CHAIN, THEME, TonConnectUI, UserRejectsError, type ConnectedWallet } from '@tonconnect/ui';
import { EXPLORER, MANIFEST_URL, MARKET, NETWORK, TEST_COLLECTION, TONAPI_KEY } from './config';
import {
    AMOUNTS,
    AUCTION_MAX_DURATION,
    bidJettonMessage,
    bidTonMessage,
    buildAuctionListing,
    buildSaleListing,
    buyJettonMessage,
    buyTonMessage,
    cancelAuctionMessage,
    cancelSaleMessage,
    finishAuctionMessage,
    mintMessage,
    nextMinBid,
    PERCENT_BASE,
    testItemContent,
    type MarketConfig,
    type Royalty,
    type TcMessage,
} from './market';
import {
    collectionData,
    jettonBalance,
    jettonWalletOf,
    lastLt,
    loadListing,
    nftsOf,
    registeredListings,
    royaltyOf,
    type CheckedListing,
    type Nft,
} from './tonapi';

// =====================================================================================================
// helpers
// =====================================================================================================
const chain = NETWORK === 'mainnet' ? CHAIN.MAINNET : CHAIN.TESTNET;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function $<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
}

const view = (a: Address) => a.toString({ bounceable: true, urlSafe: true, testOnly: NETWORK === 'testnet' });
const short = (a: Address) => {
    const s = view(a);
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
function link(a: Address, text = short(a)) {
    const el = $('a', 'addr', text);
    el.href = `${EXPLORER}/${view(a)}`;
    el.target = '_blank';
    el.rel = 'noopener';
    return el;
}

function fmtUnits(units: bigint, decimals = 9): string {
    const base = 10n ** BigInt(decimals);
    const int = new Intl.NumberFormat('en-US').format(units / base);
    const frac = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${int}.${frac.slice(0, 4)}` : int;
}

/** "1.5" -> 1500000000n (decimals 9). Throws on bad input. */
function parseUnits(text: string, decimals = 9): bigint {
    const t = text.trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Not a number: "${text}"`);
    const [i, f = ''] = t.split('.');
    if (f.length > decimals) throw new Error(`Too many decimals in "${text}"`);
    return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}

const jettonOf = (m: MarketConfig, master: Address) => m.jettons.find((j) => j.master.equals(master));
const currencyOf = (m: MarketConfig, master: Address | null) =>
    master ? (jettonOf(m, master)?.symbol ?? 'jetton') : 'TON';

function timeLeft(end: number): string {
    const s = end - Math.floor(Date.now() / 1000);
    if (s <= 0) return 'ended';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

// =====================================================================================================
// layout
// =====================================================================================================
const app = document.getElementById('app')!;

const header = $('header');
const brand = $('div');
brand.append(
    $('h1', '', 'NFT Marketplace'),
    $('p', 'muted', 'Test stand: list NFTs for a fixed price or an auction, buy, bid, cancel.'),
);
const right = $('div', 'right');
const nets = $('div', 'nets');
for (const n of ['testnet', 'mainnet'] as const) {
    const a = $('a', n === NETWORK ? 'net active' : 'net', n);
    a.href = n === 'testnet' ? '?' : '?net=mainnet';
    nets.append(a);
}
const connectRoot = $('div');
connectRoot.id = 'connect';
right.append(nets, connectRoot);
header.append(brand, right);

const info = $('div', 'info');
const tabs = $('nav', 'tabs');
const notice = $('div', 'notice hidden');
const content = $('section');
app.append(header, info, tabs, notice, content);

function showNotice(text: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info', href?: string) {
    notice.className = `notice ${kind}`;
    notice.replaceChildren(document.createTextNode(text));
    if (href) {
        const a = $('a', '', ' Open in explorer');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        notice.append(a);
    }
}
const hideNotice = () => (notice.className = 'notice hidden');

if (MARKET) {
    const fee = (MARKET.fee / PERCENT_BASE) * 100;
    info.append(
        $('span', 'muted', 'Marketplace '),
        link(MARKET.marketplace),
        $('span', 'muted', ` · fee ${fee}% → `),
        link(MARKET.feeAddress),
        $('span', 'muted', ` · currencies: TON, ${MARKET.jettons.map((j) => j.symbol).join(', ')}`),
    );
    if (!TONAPI_KEY) info.append($('span', 'muted small', ' · no tonapi key: loading is slow (1 request/s)'));
} else {
    info.append(
        $(
            'span',
            'err-text',
            `The marketplace is not deployed on ${NETWORK}: run "npx blueprint run deployMarketplace --${NETWORK}" and rebuild the page.`,
        ),
    );
}

type Tab = 'market' | 'mine' | 'test';
let tab: Tab = 'market';
const tabButtons = new Map<Tab, HTMLButtonElement>();
for (const [id, label] of [
    ['market', 'Listings'],
    ['mine', 'My NFTs'],
    ['test', 'Test collection'],
] as [Tab, string][]) {
    const b = $('button', 'tab', label);
    b.onclick = () => {
        tab = id;
        render();
    };
    tabButtons.set(id, b);
    tabs.append(b);
}

// =====================================================================================================
// wallet & transactions
// =====================================================================================================
const tonConnect = new TonConnectUI({
    manifestUrl: MANIFEST_URL,
    buttonRootId: 'connect',
    language: 'en',
    uiPreferences: { theme: THEME.LIGHT },
});

function me(): Address | null {
    const w = tonConnect.wallet as ConnectedWallet | null;
    if (!w || w.account.chain !== chain) return null;
    return Address.parse(w.account.address);
}
const wrongChain = () => {
    const w = tonConnect.wallet as ConnectedWallet | null;
    return !!w && w.account.chain !== chain;
};

let busy = false;

/**
 * Asks the wallet to send `messages` (one transaction), then waits until `watch` processes something
 * (its last transaction changes) or `until` returns true.
 */
async function send(messages: TcMessage[], opts: { watch: Address; until?: () => Promise<boolean>; done: string }) {
    if (busy) return;
    busy = true;
    const href = `${EXPLORER}/${view(opts.watch)}`;
    try {
        const before = await lastLt(opts.watch);
        showNotice('Confirm the transaction in your wallet…');
        await tonConnect.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 300, network: chain, messages });
        showNotice('Sent. Waiting for the blockchain…');
        for (let i = 0; i < 45; i++) {
            await sleep(4000);
            try {
                if ((await lastLt(opts.watch)) !== before && (!opts.until || (await opts.until()))) {
                    showNotice(opts.done, 'ok', href);
                    render();
                    return;
                }
            } catch {
                /* indexer hiccup, retry */
            }
        }
        showNotice('No confirmation yet. Check the wallet history and reload the page.', 'warn', href);
    } catch (e) {
        if (e instanceof UserRejectsError) showNotice('Transaction cancelled.', 'warn');
        else showNotice(`Error: ${(e as Error).message}`, 'err');
    } finally {
        busy = false;
    }
}

// =====================================================================================================
// Listings tab
// =====================================================================================================
let onlyMine = false;
let showFinished = false;
let renderId = 0;

async function renderMarket(m: MarketConfig) {
    const id = ++renderId;
    const bar = $('div', 'bar');
    const mine = $('label', 'check');
    const mineBox = $('input');
    mineBox.type = 'checkbox';
    mineBox.checked = onlyMine;
    mineBox.onchange = () => {
        onlyMine = mineBox.checked;
        render();
    };
    mine.append(mineBox, document.createTextNode(' only mine'));
    const fin = $('label', 'check');
    const finBox = $('input');
    finBox.type = 'checkbox';
    finBox.checked = showFinished;
    finBox.onchange = () => {
        showFinished = finBox.checked;
        render();
    };
    fin.append(finBox, document.createTextNode(' show sold / canceled'));
    const reload = $('button', 'btn small ghost', 'Reload');
    reload.onclick = () => render();
    bar.append(mine, fin, reload);
    const list = $('div', 'list');
    const status = $('p', 'empty', 'Loading listings…');
    list.append(status);
    content.replaceChildren(bar, list);

    const addresses = await registeredListings(m.marketplace);
    if (id !== renderId) return;
    let shown = 0;
    for (const [i, a] of addresses.entries()) {
        status.textContent = `Checking listings… ${i + 1}/${addresses.length}`;
        let c: CheckedListing | null = null;
        try {
            c = await loadListing(a);
        } catch {
            continue;
        }
        if (id !== renderId) return;
        if (!c) continue;
        const finished = ['sold', 'canceled', 'waiting-nft', 'broken'].includes(c.listing.status);
        if (finished && !showFinished) continue;
        const user = me();
        if (onlyMine && !(user && c.listing.data.owner?.equals(user))) continue;
        list.insertBefore(listingCard(m, c), status);
        shown++;
    }
    status.textContent = shown
        ? ''
        : addresses.length
          ? 'No listings match the filter.'
          : 'No listings yet. List an NFT on the "My NFTs" tab.';
    if (shown) status.remove();
}

const STATUS_TEXT: Record<string, string> = {
    'waiting-nft': 'waiting for the NFT',
    active: 'on sale',
    ended: 'ended — needs finishing',
    sold: 'sold',
    canceled: 'canceled',
    broken: 'broken',
};

function listingCard(m: MarketConfig, c: CheckedListing): HTMLElement {
    const { listing: l, nft } = c;
    const el = $('div', 'card');
    const img = $('img');
    img.alt = '';
    img.loading = 'lazy';
    if (nft?.image) img.src = nft.image;
    const body = $('div', 'card-body');
    const badges = $('div', 'badges');
    badges.append($('span', `badge ${l.kind}`, l.kind === 'sale' ? 'fixed price' : 'auction'));
    badges.append(
        $(
            'span',
            `badge st-${l.status}`,
            l.kind === 'auction' && l.status === 'active' && l.data.lastBid > 0n ? 'bidding' : STATUS_TEXT[l.status],
        ),
    );
    body.append(badges, $('div', 'card-title', nft?.name ?? short(l.data.nft)));
    if (nft?.collectionName) body.append($('div', 'muted small', nft.collectionName));

    const rows = $('div', 'rows');
    const row = (k: string, v: string | HTMLElement) => {
        const r = $('div', 'row');
        r.append($('span', 'muted', k), typeof v === 'string' ? $('span', '', v) : v);
        rows.append(r);
    };
    const user = me();
    const isSeller = !!user && !!l.data.owner?.equals(user);

    if (l.kind === 'sale') {
        const d = l.data;
        if (d.tonPrice > 0n) row('Price', `${fmtUnits(d.tonPrice)} TON`);
        for (const [, p] of d.jettonPrices)
            row('Price', `${fmtUnits(p.price, jettonOf(m, p.master)?.decimals)} ${currencyOf(m, p.master)}`);
        row('Royalty', `${(d.royalty / PERCENT_BASE) * 100}%`);
    } else {
        const d = l.data;
        const cur = currencyOf(m, d.jettonMaster);
        const dec = d.jettonMaster ? (jettonOf(m, d.jettonMaster)?.decimals ?? 9) : 9;
        row('Current bid', d.lastBid ? `${fmtUnits(d.lastBid, dec)} ${cur}` : 'no bids');
        if (d.lastMember) row('Leader', link(d.lastMember));
        if (l.status === 'active') row('Next bid from', `${fmtUnits(nextMinBid(d), dec)} ${cur}`);
        if (d.maxBid) row('Buyout', `${fmtUnits(d.maxBid, dec)} ${cur}`);
        const left = $('span', 'countdown', timeLeft(d.endTime));
        left.dataset.end = String(d.endTime);
        row(
            l.status === 'active' ? 'Ends in' : 'Ended',
            l.status === 'active' ? left : new Date(d.endTime * 1000).toLocaleString(),
        );
    }
    if (l.data.owner) row('Seller', isSeller ? 'you' : link(l.data.owner));
    row('Contract', link(l.address));
    body.append(rows);

    if (c.problem) {
        body.append($('div', 'small err-text', `Do not buy: ${c.problem}.`));
    } else if (!user) {
        if (l.status === 'active' || l.status === 'ended')
            body.append($('div', 'small muted', 'Connect a wallet to act.'));
    } else {
        body.append(actions(m, c, user, isSeller));
    }
    el.append(img, body);
    return el;
}

function actions(m: MarketConfig, c: CheckedListing, user: Address, isSeller: boolean): HTMLElement {
    const box = $('div', 'actions');
    const { listing: l } = c;
    const done = (t: string) => ({ watch: l.address, done: t });
    const btn = (text: string, onclick: () => void, cls = 'btn') => {
        const b = $('button', cls, text);
        b.onclick = onclick;
        box.append(b);
        return b;
    };

    if (l.kind === 'sale' && l.status === 'active') {
        const d = l.data;
        if (isSeller) {
            btn(
                'Cancel sale',
                () => send([cancelSaleMessage(l.address)], done('Sale canceled, the NFT is back in your wallet.')),
                'btn ghost',
            );
            return box;
        }
        if (d.tonPrice > 0n)
            btn(`Buy for ${fmtUnits(d.tonPrice)} TON`, () =>
                send([buyTonMessage(l.address, d.tonPrice)], done('Bought! The NFT is on its way to your wallet.')),
            );
        for (const [, p] of d.jettonPrices) {
            const j = jettonOf(m, p.master)!;
            btn(`Buy for ${fmtUnits(p.price, j.decimals)} ${j.symbol}`, async () => {
                try {
                    if ((await jettonBalance(user, p.master)) < p.price)
                        return showNotice(`Not enough ${j.symbol} in your wallet.`, 'warn');
                    const wallet = await jettonWalletOf(p.master, user);
                    await send(
                        [buyJettonMessage({ buyer: user, buyerJettonWallet: wallet, sale: l.address, price: p.price })],
                        done('Bought! The NFT is on its way to your wallet.'),
                    );
                } catch (e) {
                    showNotice(`Error: ${(e as Error).message}`, 'err');
                }
            });
        }
        box.append(
            $(
                'div',
                'small muted',
                `+${fmtUnits(d.tonPrice > 0n ? AMOUNTS.buyGas : AMOUNTS.jettonBuyTotal)} TON for fees, the unused part comes back.`,
            ),
        );
    }

    if (l.kind === 'auction') {
        const d = l.data;
        const jetton = d.jettonMaster ? jettonOf(m, d.jettonMaster)! : null;
        const dec = jetton?.decimals ?? 9;
        const cur = jetton?.symbol ?? 'TON';
        const isLeader = !!d.lastMember?.equals(user);

        if (l.status === 'ended') {
            if (isSeller || isLeader) {
                btn('Finish auction', () =>
                    send([finishAuctionMessage(l.address, !!jetton)], done('Auction finished.')),
                );
            } else {
                box.append($('div', 'small muted', 'Waiting for the seller or the winner to finish it.'));
            }
            return box;
        }
        if (l.status !== 'active') return box;

        if (isSeller) {
            if (d.lastBid === 0n)
                btn(
                    'Cancel auction',
                    () =>
                        send(
                            [cancelAuctionMessage(l.address)],
                            done('Auction canceled, the NFT is back in your wallet.'),
                        ),
                    'btn ghost',
                );
            else box.append($('div', 'small muted', 'There are bids: the auction can only be finished after its end.'));
            return box;
        }

        const min = nextMinBid(d);
        const form = $('div', 'inline');
        const input = $('input', 'input');
        input.inputMode = 'decimal';
        input.value = fmtUnits(min, dec).replace(/,/g, '');
        const unit = $('span', 'muted', cur);
        form.append(input, unit);
        box.append(form);

        const placeBid = async (amount: bigint, buyout: boolean) => {
            try {
                if (!buyout && amount < min)
                    return showNotice(`The bid must be at least ${fmtUnits(min, dec)} ${cur}.`, 'warn');
                if (jetton) {
                    if ((await jettonBalance(user, jetton.master)) < amount)
                        return showNotice(`Not enough ${cur} in your wallet.`, 'warn');
                    const wallet = await jettonWalletOf(jetton.master, user);
                    await send(
                        [
                            bidJettonMessage({
                                bidder: user,
                                bidderJettonWallet: wallet,
                                auction: l.address,
                                amount,
                                buyout,
                            }),
                        ],
                        done(buyout ? 'Bought out! The NFT is on its way.' : 'Bid placed.'),
                    );
                } else {
                    const value = buyout ? d.maxBid + AMOUNTS.tonBuyoutGas : amount;
                    await send(
                        [bidTonMessage(l.address, value)],
                        done(buyout ? 'Bought out! The NFT is on its way.' : 'Bid placed.'),
                    );
                }
            } catch (e) {
                showNotice(`Error: ${(e as Error).message}`, 'err');
            }
        };
        btn(isLeader ? 'Raise bid' : 'Place bid', () => {
            let amount: bigint;
            try {
                amount = parseUnits(input.value, dec);
            } catch (e) {
                return showNotice((e as Error).message, 'warn');
            }
            placeBid(amount, d.maxBid > 0n && amount >= d.maxBid);
        });
        if (d.maxBid > 0n)
            btn(`Buy out for ${fmtUnits(d.maxBid, dec)} ${cur}`, () => placeBid(d.maxBid, true), 'btn ghost');
        box.append(
            $(
                'div',
                'small muted',
                jetton
                    ? `+${fmtUnits(AMOUNTS.jettonBidForward + AMOUNTS.jettonBidExtra)} TON for fees (~0.1 is spent). If outbid, your ${cur} come back.`
                    : 'The whole amount is your bid. If outbid, it comes back minus ~0.001 TON gas.',
            ),
        );
    }
    return box;
}

// =====================================================================================================
// My NFTs tab
// =====================================================================================================
async function renderMine(m: MarketConfig, user: Address) {
    const id = ++renderId;
    const list = $('div', 'list');
    list.append($('p', 'empty', 'Loading your NFTs…'));
    content.replaceChildren(list);
    const items = await nftsOf(user);
    if (id !== renderId) return;
    list.replaceChildren();
    if (!items.length) {
        list.append(
            $(
                'p',
                'empty',
                TEST_COLLECTION
                    ? 'No NFTs in this wallet. Mint one on the "Test collection" tab.'
                    : 'No NFTs in this wallet.',
            ),
        );
        return;
    }
    for (const n of items) list.append(nftCard(m, user, n));
}

function nftCard(m: MarketConfig, user: Address, n: Nft): HTMLElement {
    const el = $('div', 'card');
    const img = $('img');
    img.alt = '';
    img.loading = 'lazy';
    if (n.image) img.src = n.image;
    const body = $('div', 'card-body');
    body.append($('div', 'card-title', n.name));
    if (n.collectionName) body.append($('div', 'muted small', n.collectionName));
    body.append(link(n.address));
    const open = $('button', 'btn', 'Sell…');
    body.append(open);
    open.onclick = () => {
        open.remove();
        body.append(sellForm(m, user, n));
    };
    el.append(img, body);
    return el;
}

function field(label: string, input: HTMLElement, hint?: string) {
    const f = $('label', 'field');
    f.append($('span', 'muted small', label), input);
    if (hint) f.append($('span', 'muted small', hint));
    return f;
}
function select(options: [string, string][]) {
    const s = $('select', 'input');
    for (const [v, t] of options) {
        const o = $('option', '', t);
        o.value = v;
        s.append(o);
    }
    return s;
}
function textInput(value = '', placeholder = '') {
    const i = $('input', 'input');
    i.value = value;
    i.placeholder = placeholder;
    i.inputMode = 'decimal';
    return i;
}

function sellForm(m: MarketConfig, user: Address, n: Nft): HTMLElement {
    const form = $('div', 'form');
    const kind = select([
        ['sale', 'Fixed price'],
        ['auction', 'Auction'],
    ]);
    const currency = select([
        ['TON', 'TON'],
        ...m.jettons.map((j) => [j.master.toRawString(), j.symbol] as [string, string]),
    ]);
    const price = textInput('', 'e.g. 1.5');
    const minBid = textInput('', 'e.g. 1');
    const maxBid = textInput('', 'optional');
    const step = textInput('5');
    const hours = textInput('24');
    const saleFields = $('div', 'fields');
    saleFields.append(field('Price', price));
    const aucFields = $('div', 'fields hidden');
    aucFields.append(
        field('Minimal bid', minBid),
        field('Buyout price', maxBid, 'empty = no buyout'),
        field('Bid step, %', step),
        field('Duration, hours', hours, 'up to 480 (20 days)'),
    );
    kind.onchange = () => {
        saleFields.classList.toggle('hidden', kind.value !== 'sale');
        aucFields.classList.toggle('hidden', kind.value !== 'auction');
    };
    const submit = $('button', 'btn', 'List');
    const note = $(
        'div',
        'small muted',
        `One transaction: deploy the listing contract (${fmtUnits(AMOUNTS.deploy)} TON), send the NFT to it (${fmtUnits(AMOUNTS.nftTransfer)} TON, most comes back), register it (${fmtUnits(AMOUNTS.register)} TON).`,
    );
    form.append(field('Type', kind), field('Currency', currency), saleFields, aucFields, submit, note);

    submit.onclick = async () => {
        try {
            const jetton =
                currency.value === 'TON' ? null : m.jettons.find((j) => j.master.toRawString() === currency.value)!;
            const dec = jetton?.decimals ?? 9;
            const royalty: Royalty = (await royaltyOf(n.collection ?? n.address)) ?? {
                factor: 0,
                base: 1,
                address: user,
            };
            if (kind.value === 'sale') {
                const p = parseUnits(price.value, dec);
                if (p <= 0n) throw new Error('Price must be positive');
                const l = await buildSaleListing(
                    {
                        seller: user,
                        nft: n.address,
                        market: m,
                        royalty,
                        tonPrice: jetton ? 0n : p,
                        jetton: jetton ? { master: jetton.master, price: p } : undefined,
                    },
                    jettonWalletOf,
                );
                await send(l.messages, {
                    watch: l.address,
                    until: () => isLive(l.address),
                    done: 'Listed! It is on the "Listings" tab.',
                });
            } else {
                const h = Number(hours.value);
                if (!(h > 0) || h * 3600 > AUCTION_MAX_DURATION) throw new Error('Duration must be 1..480 hours');
                const s = Number(step.value);
                if (!(Number.isInteger(s) && s >= 1 && s <= 100))
                    throw new Error('Bid step must be a whole number 1..100');
                const l = await buildAuctionListing(
                    {
                        seller: user,
                        nft: n.address,
                        market: m,
                        royalty,
                        minBid: parseUnits(minBid.value, dec),
                        maxBid: maxBid.value.trim() ? parseUnits(maxBid.value, dec) : 0n,
                        stepPercent: s,
                        endTime: Math.floor(Date.now() / 1000 + h * 3600),
                        jettonMaster: jetton?.master,
                    },
                    jettonWalletOf,
                );
                await send(l.messages, {
                    watch: l.address,
                    until: () => isLive(l.address),
                    done: 'Auction started! It is on the "Listings" tab.',
                });
            }
        } catch (e) {
            showNotice(`Error: ${(e as Error).message}`, 'err');
        }
    };
    return form;
}

async function isLive(address: Address) {
    const c = await loadListing(address);
    return !!c && (c.listing.status === 'active' || c.listing.status === 'ended');
}

// =====================================================================================================
// Test collection tab
// =====================================================================================================
async function renderTest(user: Address | null) {
    const id = ++renderId;
    const box = $('div', 'panel');
    content.replaceChildren(box);
    if (!TEST_COLLECTION) {
        box.append(
            $(
                'p',
                'muted',
                `No test collection on ${NETWORK}. Deploy one with "npx blueprint run deployTestCollection --${NETWORK}" and rebuild the page.`,
            ),
        );
        return;
    }
    box.append($('p', 'muted', 'Loading…'));
    const c = await collectionData(TEST_COLLECTION);
    if (id !== renderId) return;
    box.replaceChildren();
    const p = $('p');
    p.append(
        document.createTextNode('Collection '),
        link(TEST_COLLECTION),
        document.createTextNode(` · minted: ${c.nextItemIndex} · owner `),
        link(c.owner),
    );
    box.append(p);
    if (!user) {
        box.append($('p', 'muted', 'Connect the owner wallet to mint test NFTs.'));
        return;
    }
    if (!c.owner.equals(user)) {
        box.append(
            $(
                'p',
                'muted',
                'Only the collection owner (the wallet that deployed it) can mint. Mint to yourself from that wallet, then transfer, or use "npx blueprint run mintTestNft".',
            ),
        );
        return;
    }
    const b = $('button', 'btn', 'Mint a test NFT to my wallet');
    b.onclick = () =>
        send([mintMessage(TEST_COLLECTION!, c.nextItemIndex, user, testItemContent(c.nextItemIndex))], {
            watch: TEST_COLLECTION!,
            done: `Minted #${c.nextItemIndex}. It appears on the "My NFTs" tab in a minute.`,
        });
    box.append(
        b,
        $(
            'p',
            'small muted',
            `${fmtUnits(AMOUNTS.mint)} TON: ${fmtUnits(AMOUNTS.mintItem)} stays in the NFT, the rest pays fees.`,
        ),
    );
}

// =====================================================================================================
// render
// =====================================================================================================
function render() {
    for (const [id, b] of tabButtons) b.classList.toggle('active', id === tab);
    if (!busy) hideNotice();
    const user = me();
    const fail = (e: unknown) => content.replaceChildren($('p', 'empty err-text', `Error: ${(e as Error).message}`));
    if (wrongChain())
        showNotice(
            `Your wallet is on another network. Switch it to ${NETWORK} or open the ${NETWORK === 'testnet' ? 'mainnet' : 'testnet'} stand.`,
            'warn',
        );
    if (tab === 'test') return void renderTest(user).catch(fail);
    if (!MARKET) return void content.replaceChildren($('p', 'empty', 'Not configured.'));
    if (tab === 'market') return void renderMarket(MARKET).catch(fail);
    if (!user) return void content.replaceChildren($('p', 'empty', 'Connect your wallet to see your NFTs.'));
    renderMine(MARKET, user).catch(fail);
}

setInterval(() => {
    for (const el of document.querySelectorAll<HTMLElement>('.countdown'))
        el.textContent = timeLeft(Number(el.dataset.end));
}, 1000);

let lastWallet: string | null | undefined;
tonConnect.onStatusChange((w) => {
    const key = w ? `${w.account.address}/${w.account.chain}` : null;
    if (key === lastWallet) return;
    lastWallet = key;
    render();
});
tonConnect.connectionRestored.then(() => {
    if (lastWallet === undefined) {
        lastWallet = null;
        render();
    }
});
