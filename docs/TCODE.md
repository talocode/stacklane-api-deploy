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

## Credit purchases ($TCODE) — implemented, not enabled

Pay for Talocode Cloud credits with $TCODE. Quotes are refused while
`TCODE_TREASURY_TOKEN_ACCOUNT` is unset, so these routes are inert in production today.

- `GET /api/v1/cloud/billing/packs` — public, both rails for every pack with the $TCODE amount priced
- `GET /api/v1/cloud/tcode/price` — public, current $TCODE/USD and source
- `POST /api/v1/cloud/tcode/purchase/quote` — session, `{ projectId, packId }` only
- `POST /api/v1/cloud/tcode/purchase` — `{ projectId, quoteId, signature }`, verifies on chain
- `GET /api/v1/cloud/tcode/purchases?projectId=` — session, purchase history

Credits come from the server-owned pack, never from the request. A wallet must be linked first, and
the payment must come from that linked wallet to the treasury's $TCODE token account. The
transaction signature is the idempotency key, so a repeat credits nothing further.

Only `starter` (500 credits) and `builder` (1,000) are enabled by default, because larger orders
cannot be filled against current pool depth without severe slippage.

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
- `TCODE_TREASURY_TOKEN_ACCOUNT` — the $TCODE **token account** that receives purchase payments, not the wallet. Required before any purchase quote is served.
- `TCODE_PURCHASE_PACKS` — comma list of packs enabled for $TCODE payment. Default `starter,builder`.
- `TCODE_PURCHASE_DISCOUNT_BPS` — discount for paying in $TCODE, 0 to 5000. Default 0.
- `TCODE_PURCHASE_DAILY_CREDIT_CAP` — per-project daily credit cap. Default 0, meaning no cap.
- `TCODE_PRICE_URL` — price endpoint override
- `TCODE_PRICE_USD_OVERRIDE` — test and pre-launch only; marks the price source as `override`

## Card top-ups

Fiat checkout is the other rail. `GET /api/v1/cloud/billing/packs` reports both rails per pack,
including whether each can actually complete, so a client never shows a dead option.

`POST /api/v1/cloud/billing/topup` takes `{ projectId, packId }`. A legacy `amount` is still
accepted for older clients but is deprecated; pack requests never use custom pricing.

Both rails read pack values from `netlify/functions/credit-packs.mjs`, so a pack cannot cost
different credits depending on how it is paid for.

## Dashboard

Wallet page on the Cloud dashboard: connect, sign, claim. Same project wallet that API keys spend.
