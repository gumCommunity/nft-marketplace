// Deploys a test NFT collection (Getgems nft-collection-editable + nft-item) owned by your wallet.
// Mint items from the stand ("Test collection" tab) or with: npx blueprint run mintTestNft
//   npx blueprint run deployTestCollection --testnet [royaltyPercent]
import { toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NftCollection } from '../wrappers/Listings';
import { testCollectionInit } from '../web/src/market';
import { netOf, saveDeployment, STAND_URL } from './config';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const net = netOf(provider);
    const owner = provider.sender().address!;
    const royaltyPercent = Number(args[0] ?? 5);
    if (!(royaltyPercent >= 0 && royaltyPercent < 50)) throw new Error('Royalty must be 0..50%');

    const base = new URL('test-nft/', STAND_URL).toString();
    const collection = provider.open(
        NftCollection.createFromInit(
            testCollectionInit({
                owner,
                collectionContent: base + 'collection.json',
                commonContent: base,
                royalty: { factor: Math.round(royaltyPercent * 10), base: 1000, address: owner },
            }),
        ),
    );
    ui.write(
        `Network: ${net}\nCollection: ${collection.address.toString()}\nMetadata: ${base}collection.json\nRoyalty: ${royaltyPercent}% -> you`,
    );

    if (!(await provider.isContractDeployed(collection.address))) {
        await collection.sendDeploy(provider.sender(), toNano('0.05'));
        await provider.waitForDeploy(collection.address);
    } else {
        ui.write('Already deployed.');
    }
    saveDeployment(net, { testCollection: collection.address.toString() });
    ui.write('Saved to deployments.json.');
}
