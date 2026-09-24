-- $TCODE credit purchases: pay for Talocode Cloud credits in $TCODE.
--
-- Mirrors the hold-to-earn receipt pattern in 0002_tcode_hold_to_earn.sql:
-- a durable row written before any credit moves, and a UNIQUE constraint that
-- makes a second credit attempt a no-op rather than a double grant.
--
-- One on-chain transfer credits at most once. `tx_signature` is unique across
-- all rows, so a signature cannot be replayed against a second quote.

CREATE TABLE IF NOT EXISTS stacklane.tcode_purchases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES stacklane.cloud_projects(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES stacklane.wallets(id) ON DELETE RESTRICT,
  pack_id TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  tcode_raw NUMERIC(40, 0) NOT NULL CHECK (tcode_raw > 0),
  tcode_price_usd NUMERIC(30, 12) NOT NULL CHECK (tcode_price_usd > 0),
  price_source TEXT NOT NULL,
  discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (discount_bps >= 0),
  treasury_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'credited', 'expired', 'failed')),
  tx_signature TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tcode_purchases_project
  ON stacklane.tcode_purchases (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tcode_purchases_quoted
  ON stacklane.tcode_purchases (status) WHERE status = 'quoted';

-- The replay guard. One signature, one credit, forever.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tcode_purchases_signature
  ON stacklane.tcode_purchases (tx_signature) WHERE tx_signature IS NOT NULL;
