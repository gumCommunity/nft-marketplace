# Getgems contracts (unmodified)

Copied from [getgems-io/nft-contracts](https://github.com/getgems-io/nft-contracts) at commit
`68cfc0cf14685fdad0e16e42e516ecf96b56e9ae` (2026-10-22), `packages/contracts/sources/`. MIT, © Getgems (see LICENSE).

| File | Role | Code hash (hex) |
|---|---|---|
| `nft-fixprice-sale-v4r1.fc` | fixed price sale, TON and/or jettons | `6b95a6418b9c9d2359045d1e7559b8d549ae0e506f24caab58fa30c8fb1feb86` |
| `nft-auction-v4r1.func` | auction, TON or one jetton | `ce5a78534eaaa6ceed8dafd486d076eb60a9b0d6dbfb53676f662649c0689956` |
| `nft-marketplace-v2.fc` | marketplace: wallet v3r2 + signed sale deploy | `cbd73dced5b4e113234e5b3da1b933f6aad9205b5b8250964bee7a261507de6a` |
| `nft-collection-editable.fc` | test collection for the stand | `64bb2d4661b5f2dc1a83bf5cbbe09e92ac0b460a1b879a5519386fca4c348bca` |
| `nft-item.fc` | items of the test collection | `4c9123828682fa6f43797ab41732bca890cae01766e0674100250516e0bf8d42` |

Deployed code is not compiled here: it is the compiled cells Getgems publishes (`*.source.ts`), copied to
`web/src/codes.ts`, so the code hashes equal the contracts Getgems runs. `tests/Code.spec.ts` compiles these sources and
checks they give exactly those cells (sale: FunC 0.4.5, the rest: 0.4.6). The only exception is `nft-item.fc`: Getgems'
item code was built from an earlier revision of the file and does not reproduce; it is used only by the test collection.

`stdlib.fc` and `imports/stdlib.fc` are two different stdlib versions, both kept as Getgems has them (the auction uses
the first, the sale the second). `nft-marketplace-v2.fc`, `nft-collection-editable.fc` and `nft-item.fc` have no
`#include` lines: Getgems compiles them as `stdlib.fc + op-codes.fc [+ params.fc] + file`.

Do not edit these files: any change gives a different code hash, and the stand (`checkListing`) only accepts listings
with the pinned hashes.
