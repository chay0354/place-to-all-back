-- Quick unlock PIN (hashed; never store plaintext)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS security_pin_hash text,
  ADD COLUMN IF NOT EXISTS security_pin_set_at timestamptz;

COMMENT ON COLUMN public.profiles.security_pin_hash IS 'scrypt hash of 6-digit PIN + user id';
COMMENT ON COLUMN public.profiles.security_pin_set_at IS 'When the user last set their quick PIN';
