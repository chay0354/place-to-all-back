-- Affiliate / Agent: profiles get role (regular | agent) and optional referrer; agents earn 2% on referred users' buys

-- Add role and referred_by to profiles (create profile row if missing for existing users)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'regular' CHECK (role IN ('regular', 'agent')),
  ADD COLUMN IF NOT EXISTS referred_by_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_referred_by ON profiles(referred_by_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- Allow transaction type 'affiliate' for agent commission payouts
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('transfer', 'buy', 'sell', 'fee', 'affiliate'));
