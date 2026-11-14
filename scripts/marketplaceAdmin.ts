// Marketplace admin actions, signed with the admin key from .env (MARKETPLACE_ADMIN_MNEMONIC_<NET>).
// The wallet you connect to blueprint is not used for signing — it only picks the network/API.
//   npx blueprint run marketplaceAdmin --testnet info
//   npx blueprint run marketplaceAdmin --testnet withdraw <to> <amountTON>
//   npx blueprint run marketplaceAdmin --testnet cancel <sale-or-auction>
//   npx blueprint run marketplaceAdmin --testnet rescue <sale-or-auction> [to]   (NFT stuck in a listing that never activated)
import { Address, beginCell, Cell, fromNano, internal, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Marketplace } from '../wrappers/Marketplace';
import { checkListing, OP, type MarketConfig } from '../web/src/market';
import { JETTONS } from '../web/src/networks';
import { deploymentOf, loadAdminKey, netOf } from './config';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const net = netOf(provider);
    const d = deploymentOf(provider);
    if (!d.marketplace || !d.feeAddress || d.fee === undefined)
        throw new Error('No marketplace in deployments.json for ' + net);
    const key = await loadAdminKey(net);
    const marketplace = provider.open(Marketplace.createFromAddress(Address.parse(d.marketplace)));
    if (d.adminPublicKey && d.adminPublicKey !== key.publicKey.toString('hex'))
        throw new Error('The admin key in .env does not match deployments.json');
    const market: MarketConfig = {
        marketplace: marketplace.address,
        feeAddress: Address.parse(d.feeAddress),
        fee: d.fee,
        jettons: JETTONS[net],
    };

    const [action, a1, a2] = args;
    const seqno = await marketplace.getSeqno();
    const wait = async () => {
        ui.write('Sent. Waiting for the marketplace to process it…');
        for (let i = 0; i < 30 && (await marketplace.getSeqno()) === seqno; i++)
            await new Promise((r) => setTimeout(r, 2000));
    };

    if (!action || action === 'info') {
        const state = await provider.provider(marketplace.address).getState();
        ui.write(
            `Marketplace ${marketplace.address.toString()} (${net})\nbalance ${fromNano(state.balance)} TON, seqno ${seqno}`,
        );
        ui.write(`fee ${d.fee / 1000}% -> ${d.feeAddress}`);
        return;
    }

    if (action === 'withdraw') {
        const to = Address.parse(a1);
        const amount = toNano(a2);
        const balance = (await provider.provider(marketplace.address).getState()).balance;
        if (amount + toNano('0.05') > balance)
            throw new Error(`Balance is ${fromNano(balance)} TON: leave at least 0.05 TON`);
        await marketplace.sendWithdraw(key.secretKey, to, amount);
        await wait();
        ui.write(`Withdrew ${a2} TON to ${to.toString()}`);
        return;
    }

    const balance = (await provider.provider(marketplace.address).getState()).balance;
    if (balance < toNano('0.15'))
        throw new Error(
            `Marketplace balance is ${fromNano(balance)} TON: send it some TON first (admin actions are paid from it)`,
        );

    // listing actions
    const listing = Address.parse(a1);
    const st = await provider.provider(listing).getState();
    if (st.state.type !== 'active' || !st.state.code || !st.state.data)
        throw new Error('Listing contract is not active');
    const r = checkListing(listing, Cell.fromBoc(st.state.code)[0], Cell.fromBoc(st.state.data)[0], market);
    if (!r.ok) throw new Error(`Not our listing: ${r.reason}`);
    const l = r.listing;
    ui.write(`${l.kind} ${listing.toString()}, status: ${l.status}`);

    if (action === 'cancel') {
        const op = l.kind === 'sale' ? OP.saleCancel : OP.auctionCancel;
        await marketplace.sendCancelListing(
            key.secretKey,
            listing,
            beginCell().storeUint(op, 32).storeUint(0, 64).endCell(),
            toNano('0.1'),
        );
        await wait();
        ui.write('Cancel sent: the NFT returns to the seller (check the listing in the explorer).');
        return;
    }

    if (action === 'rescue') {
        if (!['waiting-nft', 'sold', 'canceled', 'broken'].includes(l.status))
            throw new Error(
                'Rescue works only for listings that never activated or are finished; use cancel for active ones',
            );
        const to = a2 ? Address.parse(a2) : await ui.inputAddress('Send the NFT to');
        const transfer = beginCell()
            .storeUint(OP.nftTransfer, 32)
            .storeUint(0, 64)
            .storeAddress(to)
            .storeAddress(to)
            .storeBit(false)
            .storeCoins(0)
            .storeBit(false)
            .endCell();
        await marketplace.sendRescue(
            key.secretKey,
            listing,
            internal({ to: l.data.nft, value: 0n, bounce: true, body: transfer }),
            toNano('0.1'),
        );
        await wait();
        ui.write(`Rescue sent: the listing transfers the NFT ${l.data.nft.toString()} to ${to.toString()}.`);
        return;
    }

    throw new Error(`Unknown action "${action}": info | withdraw | cancel | rescue`);
}
