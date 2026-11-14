// Mints test NFTs from the test collection (you must be its owner).
//   npx blueprint run mintTestNft --testnet [count] [toAddress]
import { Address, Cell } from '@ton/core';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { NftCollection } from '../wrappers/Listings';
import { mintMessage, testItemContent } from '../web/src/market';
import { deploymentOf } from './config';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const d = deploymentOf(provider);
    if (!d.testCollection) throw new Error('No test collection in deployments.json: run deployTestCollection first');
    const collection = provider.open(NftCollection.createFromAddress(Address.parse(d.testCollection)));
    const count = Number(args[0] ?? 1);
    const to = args[1] ? Address.parse(args[1]) : provider.sender().address!;

    for (let i = 0; i < count; i++) {
        const { nextItemIndex } = await collection.getCollectionData();
        const m = mintMessage(collection.address, nextItemIndex, to, testItemContent(nextItemIndex));
        await provider
            .sender()
            .send({ to: collection.address, value: BigInt(m.amount), body: Cell.fromBase64(m.payload!) });
        const item = await collection.getNftAddressByIndex(nextItemIndex);
        await provider.waitForDeploy(item, 30);
        ui.write(`Minted #${nextItemIndex}: ${item.toString()}`);
        await sleep(1500);
    }
}
