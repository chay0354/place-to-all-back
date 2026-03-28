-- Agent payment links: shareable URL for payers to send crypto or buy for the agent

CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  agent_user_id UUID NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDT',
  amount NUMERIC(36, 18),
  title TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token);
CREATE INDEX IF NOT EXISTS idx_payment_links_agent ON payment_links(agent_user_id);

ALTER TABLE rapyd_checkouts
  ADD COLUMN IF NOT EXISTS beneficiary_user_id UUID,
  ADD COLUMN IF NOT EXISTS payment_link_token TEXT;
