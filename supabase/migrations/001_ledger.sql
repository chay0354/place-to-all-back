-- Ledger tables for crypto wallets (testing environment)
-- Run this in Supabase SQL Editor or via Supabase CLI

-- Wallets: one row per (user_id, currency)
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  currency TEXT NOT NULL,
  balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_currency ON wallets(currency);

-- Transactions ledger
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_wallet_id UUID REFERENCES wallets(id),
  to_wallet_id UUID REFERENCES wallets(id),
  amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
  type TEXT NOT NULL CHECK (type IN ('transfer', 'buy', 'sell')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- Optional: profiles for display name (links to auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: allow service role full access; anon can only read own wallets via app
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policies for frontend (anon key): users see only their wallets
CREATE POLICY "Users can read own wallets" ON wallets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

-- Insert/update profile on signup (optional, can be done by app)
CREATE POLICY "Users can update own profile" ON profiles
  FOR ALL USING (auth.uid() = id);

-- Transactions: users can read transactions where they are sender or receiver (via wallet ownership)
CREATE POLICY "Users can read own transactions" ON transactions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM wallets w
      WHERE (w.id = transactions.from_wallet_id OR w.id = transactions.to_wallet_id)
        AND w.user_id = auth.uid()
    )
  );

-- Seed treasury wallets for system user (used by buy/sell in test env)
INSERT INTO wallets (user_id, currency, balance)
VALUES
  ('00000000-0000-0000-0000-000000000001'::UUID, 'BTC', 100),
  ('00000000-0000-0000-0000-000000000001'::UUID, 'ETH', 1000),
  ('00000000-0000-0000-0000-000000000001'::UUID, 'USDT', 100000)
ON CONFLICT (user_id, currency) DO NOTHING;
