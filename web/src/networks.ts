// Per-network constants shared by the page and the deploy scripts (no browser APIs).
import { Address } from '@ton/core';

export type Net = 'testnet' | 'mainnet';

/** Jettons accepted for prices and bids. GUM: 9 decimals on both networks. */
export const JETTONS: Record<Net, { symbol: string; master: Address; decimals: number }[]> = {
    mainnet: [
        { symbol: 'GUM', master: Address.parse('EQC8prgBYisGDdRZ2ZmmJHom1-a6WZDT5atEBn1ZvTA--GUM'), decimals: 9 },
    ],
    testnet: [
        {
            symbol: 'GUM',
            master: Address.parse('0:81fa8e5475134728231b174561afc2b09859b98c89db8db915daebe21eccdb41'),
            decimals: 9,
        },
    ],
};
