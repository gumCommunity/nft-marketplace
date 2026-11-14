// Sandbox with the marketplace, a test collection (10% royalty), GUM and wallets.
// Every user action goes through the page's own builders (web/src/market.ts) and is sent the way a wallet would send a
// TON Connect request: all messages in one transaction.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, internal, loadStateInit, SendMode, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { randomBytes } from 'crypto';
import { Marketplace } from '../../wrappers/Marketplace';
import { NftCollection, NftItem } from '../../wrappers/Listings';
import { mintMessage, testCollectionInit, type MarketConfig, type TcMessage } from '../../web/src/market';
import { GUM_MASTER, installGumLibrary, jettonWalletAddress } from './gum';

export const FEE = 5000; // 5%
export const ROYALTY = { factor: 10, base: 100 }; // 10%

export async function setup() {
    const blockchain = await Blockchain.create();
    installGumLibrary(blockchain);
    blockchain.now = Math.floor(Date.now() / 1000);

    const admin = await blockchain.treasury('admin');
    const feeWallet = await blockchain.treasury('fee');
    const royaltyWallet = await blockchain.treasury('royalty');
    const seller = await blockchain.treasury('seller');
    const buyer = await blockchain.treasury('buyer');
    const buyer2 = await blockchain.treasury('buyer2');

    const adminKey = keyPairFromSeed(randomBytes(32));
    const marketplace = blockchain.openContract(Marketplace.createFromConfig({ publicKey: adminKey.publicKey }));
    await marketplace.sendDeploy(admin.getSender(), toNano('0.1'));

    const collection = blockchain.openContract(
        NftCollection.createFromInit(
            testCollectionInit({
                owner: admin.address,
                collectionContent: 'https://example.com/test-nft/collection.json',
                commonContent: 'https://example.com/test-nft/',
                royalty: { ...ROYALTY, address: royaltyWallet.address },
            }),
        ),
    );
    await collection.sendDeploy(admin.getSender(), toNano('0.1'));

    const market: MarketConfig = {
        marketplace: marketplace.address,
        feeAddress: feeWallet.address,
        fee: FEE,
        jettons: [{ symbol: 'GUM', master: GUM_MASTER, decimals: 9 }],
    };

    /** Sends TON Connect messages from a wallet in one transaction (one external, several out messages), as a wallet app would. */
    const send = async (from: SandboxContract<TreasuryContract>, messages: TcMessage[]) => {
        const relaxed = messages.map((m) =>
            internal({
                to: Address.parse(m.address),
                value: BigInt(m.amount),
                bounce: Address.parseFriendly(m.address).isBounceable,
                body: m.payload ? Cell.fromBase64(m.payload) : undefined,
                init: m.stateInit ? loadStateInit(Cell.fromBase64(m.stateInit).beginParse()) : undefined,
            }),
        );
        return from.sendMessages(relaxed, SendMode.PAY_GAS_SEPARATELY);
    };

    let nextIndex = 0n;
    /** Mints a test NFT to `owner` with the page's mint message (sent by the collection owner). */
    const mintTo = async (owner: Address) => {
        const index = nextIndex++;
        await send(admin, [mintMessage(collection.address, index, owner, `${index}.json`)]);
        const address = await collection.getNftAddressByIndex(index);
        return blockchain.openContract(NftItem.createFromAddress(address));
    };

    const resolveJettonWallet = async (master: Address, owner: Address) => jettonWalletAddress(owner, master);

    return {
        blockchain,
        admin,
        adminKey,
        feeWallet,
        royaltyWallet,
        seller,
        buyer,
        buyer2,
        marketplace,
        collection,
        market,
        send,
        mintTo,
        resolveJettonWallet,
    };
}
