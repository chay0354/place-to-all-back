/**
 * E2E test: create user → ensure wallet created → simulate buy (webhook) → verify balances updated.
 * Run: npm run test:user-buy   (or node scripts/test-user-buy.js)
 * Backend must be running: npm run dev (in back/)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_EMAIL = `buy-test-${Date.now()}@place-to-all.test`;
const TEST_PASSWORD = 'TestPassword123!';
const CURRENCY = 'BTC';
const FIAT_AMOUNT = 50; // USD

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

  // 1. Create user (admin, auto-confirmed)
  log('1', 'Creating test user...', { email: TEST_EMAIL });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (authErr) throw new Error(`Create user: ${authErr.message}`);
  const userId = authData.user.id;
  log('1', 'User created', { userId });

  // 2. Create wallet (CDP + ledger BTC/ETH/USDT) — same as registration
  log('2', 'Creating wallet for user (POST /api/coinbase/wallet)...');
  const coinbaseWallet = await api('POST', '/api/coinbase/wallet', null, userId);
  if (!coinbaseWallet?.wallet_id) throw new Error(`Wallet creation failed: ${JSON.stringify(coinbaseWallet)}`);
  log('2', 'Wallet created', { wallet_id: coinbaseWallet.wallet_id });

  // 3. Verify ledger wallets exist (BTC, ETH, USDT)
  log('3', 'Fetching ledger wallets (GET /api/wallets)...');
  const walletsBefore = await api('GET', '/api/wallets', null, userId);
  if (!Array.isArray(walletsBefore) || walletsBefore.length === 0) {
    throw new Error(`Expected at least one ledger wallet, got: ${JSON.stringify(walletsBefore)}`);
  }
  const currencies = walletsBefore.map((w) => w.currency);
  log('3', 'Ledger wallets before buy', walletsBefore);

  const btcBefore = walletsBefore.find((w) => w.currency === CURRENCY);
  const balanceBefore = btcBefore ? Number(btcBefore.balance) : 0;

  // 4. Buy (instant test: POST /api/buy credits user from treasury; production uses MoonPay)
  log('4', 'Buy via POST /api/buy...', { fiatAmount: FIAT_AMOUNT, currency: CURRENCY });
  await api('POST', '/api/buy', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT }, userId);
  log('4', 'Webhook accepted (user credited)');

  // 5. Verify balances updated
  log('5', 'Fetching ledger wallets after buy...');
  const walletsAfter = await api('GET', '/api/wallets', null, userId);
  const btcAfter = walletsAfter.find((w) => w.currency === CURRENCY);
  const balanceAfter = btcAfter ? Number(btcAfter.balance) : 0;

  if (balanceAfter <= balanceBefore) {
    throw new Error(
      `Expected ${CURRENCY} balance to increase after buy. Before: ${balanceBefore}, After: ${balanceAfter}. Wallets: ${JSON.stringify(walletsAfter)}`
    );
  }
  log('5', 'Wallets after buy', walletsAfter);
  log('5', `${CURRENCY} balance updated: ${balanceBefore} → ${balanceAfter}`);

  console.log('\n--- OK: User created, wallet created, buy simulated, coins updated ---');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
