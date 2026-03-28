-- Let users set their own wallet address (e.g. Coinbase Wallet) so MoonPay sends there and they see funds in Coinbase.
ALTER TABLE coinbase_wallets
  ADD COLUMN IF NOT EXISTS delivery_address TEXT;

COMMENT ON COLUMN coinbase_wallets.delivery_address IS 'User’s own EVM address (e.g. Coinbase Wallet). When set, MoonPay and balance API use this so funds appear in their third-party wallet.';
