/**
 * Tests the payments flow from PAYMENTS_FLOW.md:
 *
 *   Buy flow: MoonPay (production) or POST /api/buy (instant test / dev).
 *   This script uses POST /api/buy to credit the user's ledger and asserts balances.
 *
 * Run: npm run test:payments-flow   (backend must be running)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TEST_EMAIL = `flow-${Date.now()}@place-to-all.test`;
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
  console.log('=== Payments flow test (PAYMENTS_FLOW.md) ===\n');
  log('0', 'Config', { API_URL, hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  // --- User buy (instant test: POST /api/buy credits ledger) ---
  console.log('\n--- Buy flow: POST /api/buy (instant test) ---');

  // 1. Create user
  log('1', 'Creating test user...', { email: TEST_EMAIL });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (authErr) throw new Error(`Create user: ${authErr.message}`);
  const userId = authData.user.id;
  log('1', 'User created', { userId });

  // 2. Ensure wallet (CDP + ledger rows)
  log('2', 'Ensuring wallet (POST /api/coinbase/wallet)...');
  const coinbaseWallet = await api('POST', '/api/coinbase/wallet', null, userId);
  if (!coinbaseWallet?.wallet_id) throw new Error(`Wallet creation failed: ${JSON.stringify(coinbaseWallet)}`);
  log('2', 'Wallet ready', { wallet_id: coinbaseWallet.wallet_id });

  // 3. Ledger before payment
  log('3', 'Ledger before payment (GET /api/wallets)...');
  const walletsBefore = await api('GET', '/api/wallets', null, userId);
  if (!Array.isArray(walletsBefore) || walletsBefore.length === 0) {
    throw new Error(`Expected ledger wallets, got: ${JSON.stringify(walletsBefore)}`);
  }
  const balanceBefore = Number(walletsBefore.find((w) => w.currency === CURRENCY)?.balance ?? 0);
  log('3', `${CURRENCY} balance before`, balanceBefore);

  // 4. Credit user via POST /api/buy (instant test; production uses MoonPay)
  log('4', 'Crediting user via POST /api/buy...', { fiatAmount: FIAT_AMOUNT, currency: CURRENCY });
  await api('POST', '/api/buy', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT }, userId);
  log('4', 'Buy accepted (ledger credited: treasury → user)');

  // 5. Verify ledger updated
  log('5', 'Ledger after payment (GET /api/wallets)...');
  const walletsAfter = await api('GET', '/api/wallets', null, userId);
  const btcAfter = walletsAfter.find((w) => w.currency === CURRENCY);
  const balanceAfter = btcAfter ? Number(btcAfter.balance) : 0;
  if (balanceAfter <= balanceBefore) {
    throw new Error(
      `Ledger not updated: ${CURRENCY} before=${balanceBefore} after=${balanceAfter}`
    );
  }
  log('5', `${CURRENCY} balance after`, balanceAfter);

  // 6. Verify transaction record (treasury → user, type buy)
  const { data: userWallets } = await supabase
    .from('wallets')
    .select('id')
    .eq('user_id', userId)
    .eq('currency', CURRENCY);
  const userWalletId = userWallets?.[0]?.id;
  if (userWalletId) {
    const { data: txRows } = await supabase
      .from('transactions')
      .select('id, from_wallet_id, to_wallet_id, amount, type, metadata')
      .eq('to_wallet_id', userWalletId)
      .eq('type', 'buy')
      .order('created_at', { ascending: false })
      .limit(1);
    const tx = txRows?.[0];
    if (!tx) throw new Error('No buy transaction found (treasury → user)');
    log('6', 'Transaction recorded', { id: tx.id, amount: tx.amount, type: tx.type });
  }

  // --- Leg 2: not run ---
  console.log('\n--- Leg 2: Bank → Coinbase → user wallet (separate; not run in this test) ---');
  log('–', 'Actual coin is added to the user CDP wallet via a separate process.');

  console.log('\n=== OK: Payments flow (Leg 1) passed ===');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
