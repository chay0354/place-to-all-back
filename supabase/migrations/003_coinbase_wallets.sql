-- Coinbase CDP wallet per user (sandbox now; same flow for production with different keys)
CREATE TABLE IF NOT EXISTS coinbase_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id TEXT NOT NULL,
  network_id TEXT NOT NULL DEFAULT 'base-sepolia',
  default_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coinbase_wallets_wallet_id ON coinbase_wallets(wallet_id);

ALTER TABLE coinbase_wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only coinbase_wallets" ON coinbase_wallets FOR ALL USING (false);
