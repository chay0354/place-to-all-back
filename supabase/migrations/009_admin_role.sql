-- App operator: promote agents to super_agent from dashboard admin UI (profiles.role = 'admin')
-- App admin UI/API uses auth email admin@admin.com (or ADMIN_OPERATOR_EMAIL), not this role.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('regular', 'agent', 'super_agent', 'admin'));
