CREATE TABLE IF NOT EXISTS stacklane.tcode_challenges (
  nonce TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tcode_challenges_project ON stacklane.tcode_challenges (project_id);

CREATE TABLE IF NOT EXISTS stacklane.tcode_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES stacklane.cloud_projects(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stacklane.tcode_receipts (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES stacklane.wallets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  period TEXT NOT NULL,
  credits INTEGER NOT NULL,
  raw_balance NUMERIC NOT NULL,
  decimals INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  tier_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, type, period)
);

CREATE INDEX IF NOT EXISTS idx_tcode_receipts_wallet ON stacklane.tcode_receipts (wallet_id, created_at DESC);
