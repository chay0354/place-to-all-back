/**
 * E2E test: register user → buy (POST /api/buy) → sell crypto.
 * Run with: node scripts/test-flow.js
 * Backend must be running: npm run dev (in back/)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_EMAIL = `test-${Date.now()}@place-to-all.test`;
const TEST_PASSWORD = 'TestPassword123!';
const CRYPTO_AMOUNT = 0.001;
const CURRENCY = 'BTC';

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

  // 1. Create user (admin API, auto-confirmed)
  log('1', 'Creating test user...', { email: TEST_EMAIL });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (authErr) throw new Error(`Create user: ${authErr.message}`);
  const userId = authData.user.id;
  log('1', 'User created', { userId });

  // 2. Buy (POST /api/buy credits user from treasury; production uses MoonPay)
  log('2', 'Buy via POST /api/buy...', { currency: CURRENCY, fiatAmount: 50 });
  await api('POST', '/api/buy', { currency: CURRENCY, fiatAmount: 50 }, userId);
  log('2', 'Buy accepted (user credited from treasury)');

  // 3. (no webhook; buy already done)

  // 4. Get wallets and find BTC balance
  const walletsBefore = await api('GET', '/api/wallets', null, userId);
  const btcWallet = walletsBefore.find((w) => w.currency === CURRENCY);
  if (!btcWallet || Number(btcWallet.balance) < CRYPTO_AMOUNT) {
    throw new Error(`Expected ${CURRENCY} balance >= ${CRYPTO_AMOUNT}, got ${btcWallet?.balance ?? 0}`);
  }
  log('4', 'Wallets after buy', walletsBefore);

  // 5. Sell crypto
  log('5', 'Selling crypto...', { walletId: btcWallet.id, amount: CRYPTO_AMOUNT });
  const sellResult = await api('POST', '/api/sell', {
    walletId: btcWallet.id,
    amount: CRYPTO_AMOUNT,
  }, userId);
  log('5', 'Sell result', sellResult);

  // 6. Verify balance
  const walletsAfter = await api('GET', '/api/wallets', null, userId);
  const btcAfter = walletsAfter.find((w) => w.currency === CURRENCY);
  const balanceAfter = btcAfter ? Number(btcAfter.balance) : 0;
  log('6', 'Wallets after sell', walletsAfter);

  if (balanceAfter > 0.0001) {
    throw new Error(`Expected ~0 balance after sell, got ${balanceAfter}`);
  }

  console.log('\n--- All steps passed: register → buy (POST /api/buy) → sell ---');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
