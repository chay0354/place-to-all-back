-- Single commission take per agent-tier account (0–6% of gross buy for that user’s tier); null = default 4% in app logic.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS affiliate_take_rate NUMERIC;

COMMENT ON COLUMN profiles.affiliate_take_rate IS 'Optional 0–0.06: share taken on qualifying buys for this account’s affiliate tier; NULL = use default 4%.';
