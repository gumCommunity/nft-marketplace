// Read-only wrappers for the sale/auction get-methods (used by tests to cross-check web/src/market.ts parsers)
// and for the test collection / NFT items.
import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    Sender,
    SendMode,
    StateInit,
    contractAddress,
} from '@ton/core';

export class FixPriceSale implements Contract {
    constructor(readonly address: Address) {}
    static createFromAddress(a: Address) {
        return new FixPriceSale(a);
    }

    async getSaleData(provider: ContractProvider) {
        const s = (await provider.get('get_fix_price_data_v4', [])).stack;
        return {
            isComplete: s.readBoolean(),
            createdAt: s.readNumber(),
            marketplace: s.readAddress(),
            nft: s.readAddress(),
            owner: s.readAddressOpt(),
            fullPrice: s.readBigNumber(),
            feeAddress: s.readAddress(),
            feePercent: s.readNumber(),
            royaltyAddress: s.readAddress(),
            royaltyPercent: s.readNumber(),
            soldAt: s.readNumber(),
            soldQueryId: s.readBigNumber(),
            jettonPrices: s.readCellOpt(),
        };
    }
}

export class Auction implements Contract {
    constructor(readonly address: Address) {}
    static createFromAddress(a: Address) {
        return new Auction(a);
    }

    async getAuctionData(provider: ContractProvider) {
        const s = (await provider.get('get_auction_data_v4', [])).stack;
        return {
            activated: s.readBoolean(),
            end: s.readBoolean(),
            endTime: s.readNumber(),
            marketplace: s.readAddress(),
            nft: s.readAddress(),
            owner: s.readAddressOpt(),
            lastBid: s.readBigNumber(),
            lastMember: s.readAddressOpt(),
            minStep: s.readNumber(),
            feeAddress: s.readAddress(),
            feeFactor: s.readNumber(),
            feeBase: s.readNumber(),
            royaltyAddress: s.readAddress(),
            royaltyFactor: s.readNumber(),
            royaltyBase: s.readNumber(),
            maxBid: s.readBigNumber(),
            minBid: s.readBigNumber(), // next minimal bid once there are bids
            createdAt: s.readNumber(),
            lastBidAt: s.readNumber(),
            isCanceled: s.readBoolean(),
            stepTime: s.readNumber(),
            lastQueryId: s.readBigNumber(),
            jettonWallet: s.readAddressOpt(),
            jettonMaster: s.readAddressOpt(),
            isBrokenState: s.readBoolean(),
            publicKey: s.readBigNumber(),
        };
    }
}

export class NftCollection implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: StateInit,
    ) {}
    static createFromAddress(a: Address) {
        return new NftCollection(a);
    }
    static createFromInit(init: StateInit) {
        return new NftCollection(contractAddress(0, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async getCollectionData(provider: ContractProvider) {
        const s = (await provider.get('get_collection_data', [])).stack;
        return { nextItemIndex: s.readBigNumber(), content: s.readCell(), owner: s.readAddress() };
    }

    async getNftAddressByIndex(provider: ContractProvider, index: bigint): Promise<Address> {
        return (await provider.get('get_nft_address_by_index', [{ type: 'int', value: index }])).stack.readAddress();
    }

    async getRoyaltyParams(provider: ContractProvider) {
        const s = (await provider.get('royalty_params', [])).stack;
        return { factor: s.readNumber(), base: s.readNumber(), address: s.readAddress() };
    }
}

export class NftItem implements Contract {
    constructor(readonly address: Address) {}
    static createFromAddress(a: Address) {
        return new NftItem(a);
    }

    async getNftData(provider: ContractProvider) {
        const s = (await provider.get('get_nft_data', [])).stack;
        return {
            init: s.readBoolean(),
            index: s.readBigNumber(),
            collection: s.readAddressOpt(),
            owner: s.readAddressOpt(),
            content: s.readCellOpt() as Cell | null,
        };
    }
}
