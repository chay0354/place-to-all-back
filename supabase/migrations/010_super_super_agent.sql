-- Super super agent: promoted from super_agent (operator admin UI); earns extra 4% upline like super tier.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('regular', 'agent', 'super_agent', 'super_super_agent', 'admin'));
