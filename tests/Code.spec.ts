// The pinned code (web/src/codes.ts, copied from Getgems' *.source.ts) is what we deploy. This test shows that the
// FunC sources in contracts/getgems/ are the same programs: they compile to the same cells.
// Getgems built them with different FunC versions: the sale with 0.4.4 (0.4.0-0.4.5 give the same bytecode, 0.4.6 does
// not), the auction with 0.4.6. So each case names its compiler.
// nft-item.fc is not checked: Getgems' pinned item code was built from an earlier revision of that file. It is used only
// by the test collection, not by the marketplace.
import { FuncCompiler, latestCompiler } from '@ton-community/func-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Cell } from '@ton/core';
import * as codes from '../web/src/codes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const func045 = new FuncCompiler(require('func-js-bin-0.4.5').object);
const dir = join(__dirname, '..', 'contracts', 'getgems');

async function compile(compiler: FuncCompiler, targets: string[]): Promise<Cell> {
    const r = await compiler.compileFunc({ targets, sources: (p: string) => readFileSync(join(dir, p), 'utf8') });
    if (r.status === 'error') throw new Error(r.message);
    return Cell.fromBase64(r.codeBoc);
}

const cases: [string, FuncCompiler, string[], string][] = [
    ['nft-fixprice-sale-v4r1', func045, ['nft-fixprice-sale-v4r1.fc'], codes.SALE_CODE_BOC],
    ['nft-auction-v4r1', latestCompiler, ['nft-auction-v4r1.func'], codes.AUCTION_CODE_BOC],
    // these two have no #include lines: Getgems concatenates the files in this order
    [
        'nft-marketplace-v2',
        latestCompiler,
        ['stdlib.fc', 'op-codes.fc', 'nft-marketplace-v2.fc'],
        codes.MARKETPLACE_CODE_BOC,
    ],
    [
        'nft-collection-editable',
        latestCompiler,
        ['stdlib.fc', 'op-codes.fc', 'params.fc', 'nft-collection-editable.fc'],
        codes.COLLECTION_CODE_BOC,
    ],
];

describe('pinned Getgems code', () => {
    for (const [name, compiler, targets, boc] of cases) {
        it(`${name}: sources compile to the pinned cell`, async () => {
            const compiled = await compile(compiler, targets);
            expect(compiled.hash().toString('hex')).toBe(Cell.fromBase64(boc).hash().toString('hex'));
        });
    }
});
