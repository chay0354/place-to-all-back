-- NPS recommendation score (1–10) from About us screen
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS nps_score SMALLINT,
  ADD COLUMN IF NOT EXISTS nps_submitted_at TIMESTAMPTZ;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_nps_score_range;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_nps_score_range
  CHECK (nps_score IS NULL OR (nps_score >= 1 AND nps_score <= 10));

COMMENT ON COLUMN profiles.nps_score IS 'User recommendation score 1–10 from About us NPS widget.';
COMMENT ON COLUMN profiles.nps_submitted_at IS 'When nps_score was last submitted.';
