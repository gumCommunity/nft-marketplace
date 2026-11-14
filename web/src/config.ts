// Stand settings. Addresses and fee come from ../../deployments.json (written by the deploy scripts) at build time.
// The network is chosen by the page address: ?net=mainnet, default testnet.
import { Address } from '@ton/core';
import deployments from '../../deployments.json';
import type { MarketConfig } from './market';
import { JETTONS, type Net } from './networks';

export type { Net };
type Deployment = { marketplace?: string; feeAddress?: string; fee?: number; testCollection?: string };

export const NETWORK: Net =
    new URLSearchParams(window.location.search).get('net') === 'mainnet' ? 'mainnet' : 'testnet';

const dep: Deployment = (deployments as Partial<Record<Net, Deployment>>)[NETWORK] ?? {};

export const MARKET: MarketConfig | null =
    dep.marketplace && dep.feeAddress && dep.fee !== undefined
        ? {
              marketplace: Address.parse(dep.marketplace),
              feeAddress: Address.parse(dep.feeAddress),
              fee: dep.fee,
              jettons: JETTONS[NETWORK],
          }
        : null;

export const TEST_COLLECTION: Address | null = dep.testCollection ? Address.parse(dep.testCollection) : null;

// Optional tonapi.io client key (web/.env.local: VITE_TONAPI_KEY=...). Without it tonapi allows ~1 request per second and
// the page queues requests. The key ends up in public JavaScript: use a key meant for browsers.
export const TONAPI_KEY: string = import.meta.env.VITE_TONAPI_KEY ?? '';
export const TONAPI_BASE = NETWORK === 'mainnet' ? 'https://tonapi.io' : 'https://testnet.tonapi.io';
export const EXPLORER = NETWORK === 'mainnet' ? 'https://tonviewer.com' : 'https://testnet.tonviewer.com';

// tonconnect-manifest.json is served next to index.html
export const MANIFEST_URL = new URL('tonconnect-manifest.json', window.location.href).toString();

/** How many latest registrations the stand checks. */
export const LISTINGS_LIMIT = 50;
