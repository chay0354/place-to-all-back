/**
 * E2E test: create user → ensure Coinbase wallet is created (no user without wallet).
 * Run: npm run test:user-wallet   (or node scripts/test-user-wallet.js)
 * Backend must be running: npm run dev (in back/)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_EMAIL = `wallet-test-${Date.now()}@place-to-all.test`;
const TEST_PASSWORD = 'TestPassword123!';

function log(step, msg, data = null) {
  console.log(`[${step}] ${msg}`);
  if (data != null) console.log(JSON.stringify(data, null, 2));
}

async function api(method, path, body = null, userId = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (userId) opts.headers['X-User-Id'] = userId;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
  return data;
}

async function main() {
  log('0', 'Config', { API_URL, hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  // 1. Create user (admin, auto-confirmed) — simulates "registration"
  log('1', 'Creating test user...', { email: TEST_EMAIL });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (authErr) throw new Error(`Create user: ${authErr.message}`);
  const userId = authData.user.id;
  log('1', 'User created', { userId });

  // 2. Create Coinbase wallet (same as register flow: POST /api/coinbase/wallet)
  log('2', 'Creating Coinbase wallet for user...');
  const wallet = await api('POST', '/api/coinbase/wallet', null, userId);
  if (!wallet || !wallet.wallet_id) {
    throw new Error(`Wallet creation returned no wallet_id: ${JSON.stringify(wallet)}`);
  }
  log('2', 'Wallet created', wallet);

  // 3. Verify GET /api/coinbase/wallet returns the same wallet
  log('3', 'Verifying wallet via GET...');
  const walletGet = await api('GET', '/api/coinbase/wallet', null, userId);
  if (walletGet.wallet_id !== wallet.wallet_id) {
    throw new Error(`GET wallet mismatch: ${walletGet.wallet_id} !== ${wallet.wallet_id}`);
  }
  log('3', 'GET wallet OK', walletGet);

  // 4. Verify DB row exists
  const { data: row, error: rowErr } = await supabase
    .from('coinbase_wallets')
    .select('user_id, wallet_id, network_id, default_address')
    .eq('user_id', userId)
    .single();
  if (rowErr || !row) throw new Error(`coinbase_wallets row missing: ${rowErr?.message || 'no row'}`);
  if (row.wallet_id !== wallet.wallet_id) throw new Error(`DB wallet_id mismatch: ${row.wallet_id}`);
  log('4', 'DB row verified', row);

  console.log('\n--- OK: User created and wallet opened (no user without wallet) ---');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  if (err.message.includes('rate limit') || err.message.includes('CDP_WALLET_SECRET')) {
    console.error('\nTo fix: set CDP_WALLET_SECRET in back/.env (get it from https://portal.cdp.coinbase.com/products/server-wallet/accounts).');
  }
  process.exit(1);
});
