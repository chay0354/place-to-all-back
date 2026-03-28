-- Rapyd: link checkouts to user intent; idempotency for webhooks
CREATE TABLE IF NOT EXISTS rapyd_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rapyd_checkout_id TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  currency TEXT NOT NULL,
  crypto_amount NUMERIC(36, 18) NOT NULL,
  fiat_amount NUMERIC(12, 2) NOT NULL,
  fiat_currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rapyd_checkouts_user ON rapyd_checkouts(user_id);
CREATE INDEX IF NOT EXISTS idx_rapyd_checkouts_status ON rapyd_checkouts(status);

-- Idempotency: avoid crediting twice for same Rapyd payment
CREATE TABLE IF NOT EXISTS processed_rapyd_payments (
  rapyd_payment_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: backend uses service role; no anon access needed for these
ALTER TABLE rapyd_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_rapyd_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only rapyd_checkouts" ON rapyd_checkouts FOR ALL USING (false);
CREATE POLICY "Service role only processed_rapyd" ON processed_rapyd_payments FOR ALL USING (false);
