/**
 * Creates a user, buys ~11 ETH via instant-test, then verifies GET /api/wallets
 * returns the correct ETH balance.
 * Run: node scripts/check-buy-11-eth.js
 * Backend must be running. Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CURRENCY = 'ETH';
// ~11 ETH at ~$2000/ETH
const FIAT_AMOUNT = 22000;

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
  const w = wallets.find((x) => ((x.currency || '').trim().toUpperCase()) === CURRENCY);
  if (w == null) return 0;
  const b = w.balance;
  if (typeof b === 'number' && !Number.isNaN(b)) return b;
  if (typeof b === 'string') return parseFloat(b) || 0;
  return Number(b) || 0;
}

async function main() {
  log('0', 'Config', { API_URL, FIAT_AMOUNT, target: '~11 ETH' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  // 1. Create test user
  const TEST_EMAIL = `buy-11-eth-${Date.now()}@place-to-all.test`;
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

  // 2. Ensure wallet (ledger rows including ETH)
  log('2', 'Ensuring wallet (POST /api/coinbase/wallet)...');
  await api('POST', '/api/coinbase/wallet', null, userId);
  log('2', 'Wallet ensured');

  // 3. ETH balance before
  log('3', 'GET /api/wallets (before buy)...');
  const walletsBefore = await api('GET', '/api/wallets', null, userId);
  const ethBefore = getEthBalance(walletsBefore);
  log('3', `ETH balance before: ${ethBefore}`, walletsBefore);

  // 4. Buy ~11 ETH via instant-test
  log('4', 'POST /api/buy instant_test...', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT, instant_test: true });
  const buyRes = await api('POST', '/api/buy', { currency: CURRENCY, fiatAmount: FIAT_AMOUNT, instant_test: true }, userId);
  if (!buyRes.success || buyRes.new_balance == null) {
    throw new Error(`Instant-test buy failed: ${JSON.stringify(buyRes)}`);
  }
  const expectedBalance = Number(buyRes.new_balance);
  log('4', 'Buy response', { new_balance: buyRes.new_balance, transaction_id: buyRes.transaction?.id });

  // 5. GET /api/wallets again and verify ETH balance
  log('5', 'GET /api/wallets (after buy)...');
  const walletsAfter = await api('GET', '/api/wallets', null, userId);
  const ethAfter = getEthBalance(walletsAfter);
  log('5', `ETH balance after: ${ethAfter}`, walletsAfter);

  const balanceCorrect = Math.abs(ethAfter - expectedBalance) < 0.000001;
  if (!balanceCorrect) {
    throw new Error(
      `ETH balance incorrect: GET /api/wallets returned ${ethAfter}, expected (new_balance) ${expectedBalance}. Raw wallets: ${JSON.stringify(walletsAfter)}`
    );
  }
  if (ethAfter < 10) {
    throw new Error(`Expected at least ~10 ETH, got ${ethAfter}. Check quote (fiatAmount=${FIAT_AMOUNT}).`);
  }

  console.log('\n--- OK: User created, bought ~11 ETH, GET /api/wallets returns correct ETH balance ---');
}

main().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
