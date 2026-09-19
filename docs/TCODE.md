# $TCODE hold-to-earn

Signed Solana wallet link plus monthly API credit claims. Credits are Talocode Cloud usage credits (1 credit = $0.01 list), not cash.

Public token page: https://talocode.site/tcode.html

## Token

| Field | Value |
| --- | --- |
| Name | Talocode |
| Symbol | TCODE |
| Chain | Solana mainnet |
| Mint | `6ptxwABxQz8zMhwhiPeVgRgWjGMdVcEBFBv8v8C3ory` |
| Decimals | 6 |
| Total / max supply | 500,000 (mint revoked, freeze revoked) |

Only this mint is $TCODE.

Circulating supply equals tokens already in wallets. Until the launch curve completes, most of the 500,000 supply is not in an open pool.

## Live API

- `GET /api/v1/cloud/tcode` — mint and tiers (public)
- `POST /api/v1/cloud/tcode/challenge` — session, `{ projectId }`
- `POST /api/v1/cloud/tcode/link` — `{ projectId, walletAddress, signature, nonce }`
- `GET /api/v1/cloud/tcode/holdings?projectId=` — server reads chain
- `POST /api/v1/cloud/tcode/claim` — `{ projectId }` only

Client `rawBalance` is rejected. Holdings are read from `SOLANA_RPC_URL` (default mainnet public RPC).

## Tiers (whole tokens)

| Min $TCODE | Monthly credits |
|---|---|
| 1 | 1,000 |
| 100 | 10,000 |
| 1,000 | 100,000 |
| 5,000 | 500,000 |

One Solana address maps to one Talocode project. One grant per project wallet per UTC month.

## Not live

Contributor airdrops, a redemption floor, and staking-for-product-perks are not implemented on this API.

## Env

- `DATABASE_URL` — required
- `SOLANA_RPC_URL` — recommended dedicated RPC in production

## Dashboard

Wallet page on the Cloud dashboard: connect, sign, claim. Same project wallet that API keys spend.
