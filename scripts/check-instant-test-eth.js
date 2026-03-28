/**
 * Verifies that instant-test (DB-only, no blockchain) updates ETH balance.
 * Run: node scripts/check-instant-test-eth.js
 * Backend must be running: npm run dev (in back/)
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; API_URL optional (default localhost:4000).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CURRENCY = 'ETH';
const FIAT_AMOUNT = 10; // USD

function log(step, msg, data = null) {
  console.log(`[${step}] ${msg}`);
  if (data != null && typeof data === 'object') console.log(JSON.stringify(data, null, 2));
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

function getEthBalance(wallets) {
  if (!Array.isArray(wallets)) return 0;
  const w = wallets.find((x) => (x.currency || '').toUpperCase() === CURRENCY);
  return w != null ? parseFloat(w.balance) || Number(w.balance) || 0 : 0;
}

async function main() {
  log('0', 'Config', { API_URL, hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  // 1. Create test user
  const TEST_EMAIL = `instant-eth-${Date.now()}@place-to-all.test`;
  const TEST_PASSWORD = 'TestPassword123!';
  log('1', 'Creating test user...', { email: TEST_EMAIL });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (authErr) throw new Error(`Create user: ${authErr.message}`);
  const userId = authData.user.id;
  log('1', 'User created', { userId });

  // 2. Ensure wallet (ledger rows)
  log('2', 'Ensuring wallet (POST /api/coinbase/wallet)...');
  await api('POST', '/api/coinbase/wallet', null, userId);
  log('2', 'Wallet ensured');

  // 3. ETH balance before
  log('3', 'Fetching wallets (GET /api/wallets)...');
  const walletsBefore = await api('GET', '/api/wallets', null, userId);
  const ethBefore = getEthBalance(walletsBefore);
  log('3', `ETH balance before: ${ethBefore}`);

  // 4. Instant-test buy (DB only, no blockchain)
  log('4', 'POST /api/buy instant_test (DB only)...', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT, instant_test: true });
  const buyRes = await api('POST', '/api/buy', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT, instant_test: true }, userId);
  if (!buyRes.success || buyRes.new_balance == null) {
    throw new Error(`Instant-test buy failed or missing new_balance: ${JSON.stringify(buyRes)}`);
  }
  const expectedNewBalance = Number(buyRes.new_balance);
  log('4', 'Instant-test response', { new_balance: buyRes.new_balance, transaction_id: buyRes.transaction?.id });

  // 5. ETH balance after (must match DB)
  log('5', 'Fetching wallets after buy...');
  const walletsAfter = await api('GET', '/api/wallets', null, userId);
  const ethAfter = getEthBalance(walletsAfter);
  log('5', `ETH balance after: ${ethAfter}`);

  if (ethAfter !== expectedNewBalance) {
    throw new Error(
      `ETH balance mismatch: GET /api/wallets returned ${ethAfter}, instant-test new_balance was ${expectedNewBalance}. Wallets: ${JSON.stringify(walletsAfter)}`
    );
  }
  if (ethAfter <= ethBefore) {
    throw new Error(
      `ETH balance did not increase: before=${ethBefore}, after=${ethAfter}. Wallets: ${JSON.stringify(walletsAfter)}`
    );
  }

  console.log('\n--- OK: Instant-test (DB only) updates ETH balance; GET /api/wallets returns new balance ---');
}

main().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
