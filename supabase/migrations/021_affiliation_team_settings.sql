-- Per-agent overrides set by a super / super-super manager: nickname + earn rate on that agent.

CREATE TABLE IF NOT EXISTS affiliation_team_settings (
  manager_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  nickname text,
  earn_rate numeric,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, member_id),
  CONSTRAINT affiliation_team_settings_earn_rate_check
    CHECK (earn_rate IS NULL OR (earn_rate >= 0 AND earn_rate <= 0.06))
);

CREATE INDEX IF NOT EXISTS affiliation_team_settings_manager_idx
  ON affiliation_team_settings (manager_id);

COMMENT ON TABLE affiliation_team_settings IS
  'Manager (super_agent / super_super_agent) display nickname and optional earn_rate (0–0.06) for a direct downline agent.';

COMMENT ON COLUMN affiliation_team_settings.earn_rate IS
  'Optional share the manager takes from this member’s volume; NULL = use manager profiles.affiliate_take_rate / default 4%.';
