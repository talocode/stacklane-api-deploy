CREATE SCHEMA IF NOT EXISTS stacklane;

CREATE TABLE IF NOT EXISTS stacklane.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stacklane.sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES stacklane.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON stacklane.sessions(user_id);

CREATE TABLE IF NOT EXISTS stacklane.cloud_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES stacklane.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_projects_owner_id ON stacklane.cloud_projects(owner_id);

CREATE TABLE IF NOT EXISTS stacklane.api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES stacklane.cloud_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES stacklane.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON stacklane.api_keys(project_id);

CREATE TABLE IF NOT EXISTS stacklane.wallets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES stacklane.cloud_projects(id) ON DELETE CASCADE,
  balance_credits INTEGER NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
  lifetime_credits INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_credits >= 0),
  lifetime_spend INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_spend >= 0),
  free_credits_granted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stacklane.transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES stacklane.wallets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  credits_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON stacklane.transactions(wallet_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stacklane.usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES stacklane.cloud_projects(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES stacklane.users(id) ON DELETE SET NULL,
  api_key_id TEXT REFERENCES stacklane.api_keys(id) ON DELETE SET NULL,
  product TEXT NOT NULL,
  action TEXT NOT NULL,
  credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'charged',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_project_id ON stacklane.usage_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stacklane.topups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES stacklane.cloud_projects(id) ON DELETE CASCADE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount_usd NUMERIC(12, 2) NOT NULL CHECK (amount_usd >= 0),
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
