-- Virtual card program (Reap-backed): one card per user + event log

CREATE TABLE IF NOT EXISTS user_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  card_brand TEXT NOT NULL DEFAULT 'Place to All',
  card_network TEXT NOT NULL DEFAULT 'VISA',
  card_type TEXT NOT NULL DEFAULT 'virtual',
  card_last4 TEXT,
  available_balance_usdt NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (available_balance_usdt >= 0),
  lifetime_funded_usdt NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (lifetime_funded_usdt >= 0),
  reap_customer_id TEXT,
  reap_card_id TEXT UNIQUE,
  apple_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  google_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_cards_user_id ON user_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_user_cards_reap_card_id ON user_cards(reap_card_id);

CREATE TABLE IF NOT EXISTS card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_card_id UUID NOT NULL REFERENCES user_cards(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('issue', 'fund', 'spend', 'refund', 'webhook')),
  amount_usdt NUMERIC(36, 18) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_events_user_id ON card_events(user_id);
CREATE INDEX IF NOT EXISTS idx_card_events_card_id ON card_events(user_card_id);
CREATE INDEX IF NOT EXISTS idx_card_events_created_at ON card_events(created_at DESC);

