-- System fee: dedicated user for collected 8% fees; allow transaction type 'fee'
-- Fee user ID: 00000000-0000-0000-0000-000000000002

-- Allow type 'fee' in transactions
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('transfer', 'buy', 'sell', 'fee'));

-- Fee collection wallets (one per currency)
INSERT INTO wallets (user_id, currency, balance)
VALUES
  ('00000000-0000-0000-0000-000000000002'::UUID, 'BTC', 0),
  ('00000000-0000-0000-0000-000000000002'::UUID, 'ETH', 0),
  ('00000000-0000-0000-0000-000000000002'::UUID, 'USDT', 0)
ON CONFLICT (user_id, currency) DO NOTHING;
