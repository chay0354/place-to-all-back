-- Super agent: same capabilities as agent; invite creates subordinate agents; 4% upline on their network buys (see backend fee/affiliate logic)

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('regular', 'agent', 'super_agent'));
