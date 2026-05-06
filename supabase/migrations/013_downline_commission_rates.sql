-- Configurable commission takes within max 4% per tier (buyer gross); platform 4% unchanged from fee.js.

CREATE TABLE IF NOT EXISTS downline_direct_rates (
  parent_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  child_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rate NUMERIC NOT NULL DEFAULT 0.04 CHECK (rate >= 0 AND rate <= 0.04),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_user_id, child_user_id)
);

CREATE INDEX IF NOT EXISTS idx_downline_direct_rates_parent ON downline_direct_rates(parent_user_id);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS super_upline_commission_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS super_super_upline_commission_rate NUMERIC;

COMMENT ON COLUMN profiles.super_upline_commission_rate IS 'Optional 0–0.04; super_agent tier share when this user receives super-upline commission; NULL = default 4%.';
COMMENT ON COLUMN profiles.super_super_upline_commission_rate IS 'Optional 0–0.04; super_super_agent tier share; NULL = default 4%.';
