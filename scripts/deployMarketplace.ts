// Deploys the marketplace contract (Getgems nft-marketplace-v2) and records the fee settings for the stand.
//   npx blueprint run deployMarketplace --testnet
//   npx blueprint run deployMarketplace --mainnet [feeAddress] [feePercent]
import { Address, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Marketplace } from '../wrappers/Marketplace';
import { adminEnvName, loadOrCreateAdminKey, netOf, saveDeployment } from './config';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const net = netOf(provider);
    const deployer = provider.sender().address!;

    const { key, created } = await loadOrCreateAdminKey(net);
    if (created)
        ui.write(
            `New admin key saved to .env as ${adminEnvName(net)}. Back up .env — without the key the marketplace cannot be managed.`,
        );

    const feeAddress = args[0]
        ? Address.parse(args[0])
        : await ui.inputAddress('Address that receives the marketplace fee', deployer);
    const feePercent = Number(args[1] ?? (await ui.input('Marketplace fee, % (e.g. 5)')));
    if (!(feePercent >= 0 && feePercent < 100)) throw new Error('Fee must be 0..100%');
    const fee = Math.round(feePercent * 1000); // over 100000

    const marketplace = provider.open(Marketplace.createFromConfig({ publicKey: key.publicKey }));
    ui.write(
        `Network: ${net}\nMarketplace: ${marketplace.address.toString()}\nFee: ${feePercent}% -> ${feeAddress.toString()}`,
    );

    if (await provider.isContractDeployed(marketplace.address)) {
        ui.write('Already deployed with this admin key — only the settings are updated.');
    } else {
        // the balance pays for admin actions (each cancel/rescue sends 0.1 TON); top it up any time with a plain transfer
        await marketplace.sendDeploy(provider.sender(), toNano('0.5'));
        await provider.waitForDeploy(marketplace.address);
    }

    saveDeployment(net, {
        marketplace: marketplace.address.toString(),
        adminPublicKey: key.publicKey.toString('hex'),
        feeAddress: feeAddress.toString({ bounceable: false }),
        fee,
    });
    ui.write('Saved to deployments.json. Rebuild and publish the stand: cd web && npm run deploy');
}
