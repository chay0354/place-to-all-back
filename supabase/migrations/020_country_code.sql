-- User country (ISO 3166-1 alpha-2) for avatar flag and localization.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS country_code char(2) NOT NULL DEFAULT 'IL';

UPDATE profiles SET country_code = 'IL' WHERE country_code IS NULL OR country_code = '';

ALTER TABLE profiles
  ADD CONSTRAINT profiles_country_code_format
  CHECK (country_code ~ '^[A-Z]{2}$');
