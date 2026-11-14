// nft-marketplace-v2 (Getgems): wallet v3r2 + op 1 "deploy a sale signed by the marketplace key".
// The key that signs external messages is the marketplace admin key: it can send anything from the marketplace
// (withdraw TON, cancel listings — the sale/auction contracts accept cancel from the marketplace address).
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    internal,
    MessageRelaxed,
    Sender,
    SendMode,
    StateInit,
    storeMessageRelaxed,
    storeStateInit,
} from '@ton/core';
import { sign } from '@ton/crypto';
import { MARKETPLACE_CODE } from '../web/src/market';

export type MarketplaceConfig = { publicKey: Buffer; subwallet?: number };

export function marketplaceData(c: MarketplaceConfig): Cell {
    return beginCell()
        .storeUint(0, 32) // seqno
        .storeUint(c.subwallet ?? 0, 32)
        .storeBuffer(c.publicKey, 32)
        .endCell();
}

export class Marketplace implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: StateInit,
        readonly subwallet = 0,
    ) {}

    static createFromAddress(address: Address, subwallet = 0) {
        return new Marketplace(address, undefined, subwallet);
    }

    static createFromConfig(c: MarketplaceConfig, workchain = 0) {
        const init = { code: MARKETPLACE_CODE, data: marketplaceData(c) };
        return new Marketplace(contractAddress(workchain, init), init, c.subwallet ?? 0);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        // empty body: the contract ignores it and keeps the TON
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: Cell.EMPTY });
    }

    /** Admin action: sends `messages` from the marketplace (wallet v3r2 external format). */
    async sendActions(
        provider: ContractProvider,
        secretKey: Buffer,
        messages: { message: MessageRelaxed; mode?: number }[],
        opts: { seqno?: number; validFor?: number } = {},
    ) {
        if (messages.length > 4) throw new Error('At most 4 messages per external');
        const seqno = opts.seqno ?? (await this.getSeqno(provider));
        const b = beginCell()
            .storeUint(this.subwallet, 32)
            .storeUint(Math.floor(Date.now() / 1000) + (opts.validFor ?? 120), 32)
            .storeUint(seqno, 32);
        for (const m of messages) {
            b.storeUint(m.mode ?? SendMode.PAY_GAS_SEPARATELY, 8).storeRef(
                beginCell().store(storeMessageRelaxed(m.message)).endCell(),
            );
        }
        const unsigned = b.endCell();
        const signature = sign(unsigned.hash(), secretKey);
        await provider.external(beginCell().storeBuffer(signature).storeSlice(unsigned.beginParse()).endCell());
    }

    /** Admin: send TON from the marketplace (e.g. the collected registration notes). */
    async sendWithdraw(provider: ContractProvider, secretKey: Buffer, to: Address, value: bigint) {
        await this.sendActions(provider, secretKey, [
            { message: internal({ to, value, bounce: false, body: 'marketplace withdraw' }) },
        ]);
    }

    /** Admin: cancel a sale (op 3) or an auction without bids (cancel_auction) — the NFT returns to the seller. */
    async sendCancelListing(
        provider: ContractProvider,
        secretKey: Buffer,
        listing: Address,
        body: Cell,
        value: bigint,
    ) {
        await this.sendActions(provider, secretKey, [
            { message: internal({ to: listing, value, bounce: true, body }) },
        ]);
    }

    /**
     * Admin rescue (op 555): makes a sale/auction send `message`. Allowed only when the listing is finished or was never
     * activated (e.g. the NFT arrived without ownership_assigned) — and not within 10 minutes of a sale/bid.
     */
    async sendRescue(
        provider: ContractProvider,
        secretKey: Buffer,
        listing: Address,
        message: MessageRelaxed,
        value: bigint,
        mode = 64,
    ) {
        const inner = beginCell()
            .storeUint(mode, 8)
            .storeRef(beginCell().store(storeMessageRelaxed(message)).endCell())
            .endCell();
        const body = beginCell().storeUint(555, 32).storeUint(0, 64).storeRef(inner).endCell();
        await this.sendActions(provider, secretKey, [
            { message: internal({ to: listing, value, bounce: true, body }) },
        ]);
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const state = await provider.getState();
        if (state.state.type !== 'active') return 0;
        return (await provider.get('seqno', [])).stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_public_key', [])).stack.readBigNumber();
    }
}

/**
 * Body of op 1 "deploy sale signed by the marketplace key" — the Getgems backend flow (a server checks the listing and
 * signs it; the seller sends it to the marketplace, which deploys the sale). The stand does not need it, kept for a
 * future backend; covered by tests.
 */
export function signedDeployBody(secretKey: Buffer, init: StateInit, saleBody: Cell): Cell {
    const stateInit = beginCell().store(storeStateInit(init)).endCell();
    const signed = beginCell().storeRef(stateInit).storeRef(saleBody).endCell();
    return beginCell()
        .storeUint(1, 32)
        .storeBuffer(sign(signed.hash(), secretKey))
        .storeRef(stateInit)
        .storeRef(saleBody)
        .endCell();
}
