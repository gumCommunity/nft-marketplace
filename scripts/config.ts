import { NetworkProvider } from '@ton/blueprint';
import { KeyPair, mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// deployments.json is read by the page at build time (web/src/config.ts): addresses and fee per network.
export type Deployment = {
    marketplace?: string;
    adminPublicKey?: string;
    feeAddress?: string;
    /** marketplace fee over 100000 (5000 = 5%) */
    fee?: number;
    testCollection?: string;
};

const DEPLOYMENTS = join(__dirname, '..', 'deployments.json');
const ENV_FILE = join(__dirname, '..', '.env');

export type Net = 'testnet' | 'mainnet';

export function netOf(provider: NetworkProvider): Net {
    const n = provider.network();
    if (n === 'testnet' || n === 'mainnet') return n;
    throw new Error(`Unsupported network "${n}": use --testnet or --mainnet`);
}

export function loadDeployments(): Partial<Record<Net, Deployment>> {
    return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {};
}

export function saveDeployment(net: Net, patch: Deployment) {
    const all = loadDeployments();
    all[net] = { ...(all[net] ?? {}), ...patch };
    writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 4) + '\n');
}

export function deploymentOf(provider: NetworkProvider): Deployment {
    return loadDeployments()[netOf(provider)] ?? {};
}

/** .env variable with the marketplace admin mnemonic for this network. */
export const adminEnvName = (net: Net) => `MARKETPLACE_ADMIN_MNEMONIC_${net.toUpperCase()}`;

/** Admin key of the marketplace contract (signs its external messages). */
export async function loadAdminKey(net: Net): Promise<KeyPair> {
    const words = (process.env[adminEnvName(net)] ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error(`${adminEnvName(net)} is not set in .env`);
    if (!(await mnemonicValidate(words))) throw new Error(`${adminEnvName(net)} is not a valid TON mnemonic`);
    return mnemonicToPrivateKey(words);
}

/** Uses the key from .env, or creates a new one and appends it to .env (never printed). */
export async function loadOrCreateAdminKey(net: Net): Promise<{ key: KeyPair; created: boolean }> {
    if (process.env[adminEnvName(net)]) return { key: await loadAdminKey(net), created: false };
    const words = await mnemonicNew(24);
    appendFileSync(
        ENV_FILE,
        `${existsSync(ENV_FILE) ? '\n' : ''}# marketplace admin key (${net}) — back it up, it controls the marketplace contract\n${adminEnvName(net)}="${words.join(' ')}"\n`,
    );
    process.env[adminEnvName(net)] = words.join(' ');
    return { key: await mnemonicToPrivateKey(words), created: true };
}

/** Base URL of the published stand; the test collection metadata lives under <stand>/test-nft/. */
export const STAND_URL = process.env.STAND_URL ?? 'https://gumcommunity.github.io/nft-marketplace/';
