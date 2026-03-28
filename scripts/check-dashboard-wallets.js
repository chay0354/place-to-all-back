/**
 * Checks why dashboard might not show all balances:
 * 1. Reads wallets from DB (Supabase) for a user
 * 2. Calls backend GET /api/wallets for the same user
 * 3. Compares and logs any mismatch
 *
 * Run: node scripts/check-dashboard-wallets.js <userId>
 *   or: CHECK_USER_ID=<uuid> node scripts/check-dashboard-wallets.js
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: API_URL (default http://localhost:4000)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const userId = process.env.CHECK_USER_ID || process.argv[2];
const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!userId) {
  console.error('Usage: node scripts/check-dashboard-wallets.js <userId>');
  console.error('   or: CHECK_USER_ID=<uuid> node scripts/check-dashboard-wallets.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function log(label, data) {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  console.log('Config:', { userId, API_URL, hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // 1. Wallets from DB (source of truth)
  const { data: dbWallets, error: dbErr } = await supabase
    .from('wallets')
    .select('id, user_id, currency, balance, updated_at')
    .eq('user_id', userId)
    .order('currency');

  if (dbErr) {
    console.error('DB error:', dbErr.message);
    process.exit(1);
  }

  const dbRows = dbWallets || [];
  const dbByCurrency = Object.fromEntries(dbRows.map((w) => [String(w.currency).toUpperCase(), { balance: w.balance, id: w.id }]));

  log('1. DB wallets (wallets table)', dbRows.length ? dbRows : '(none)');

  // 2. Wallets from backend API (what dashboard would get if it called backend with this user)
  const res = await fetch(`${API_URL}/api/wallets?_t=${Date.now()}`, {
    headers: { 'X-User-Id': userId },
    cache: 'no-store',
  });
  const apiBody = await res.json().catch(() => ({}));
  const apiWallets = Array.isArray(apiBody) ? apiBody : apiBody.data || [];
  const apiByCurrency = Object.fromEntries(
    apiWallets.map((w) => [String(w.currency || '').toUpperCase(), { balance: w.balance, id: w.id }])
  );

  log('2. Backend API GET /api/wallets response', apiBody);
  log('2b. Backend API wallets (parsed array)', apiWallets.length ? apiWallets : '(none)');

  // 3. Compare
  const dbCurrencies = new Set(Object.keys(dbByCurrency).filter(Boolean));
  const apiCurrencies = new Set(Object.keys(apiByCurrency).filter(Boolean));
  const inDbNotApi = [...dbCurrencies].filter((c) => !apiCurrencies.has(c));
  const inApiNotDb = [...apiCurrencies].filter((c) => !dbCurrencies.has(c));
  const inBoth = [...dbCurrencies].filter((c) => apiCurrencies.has(c));

  console.log('\n--- 3. Comparison ---');
  console.log('Currencies in DB:', [...dbCurrencies].sort().join(', ') || '(none)');
  console.log('Currencies in API:', [...apiCurrencies].sort().join(', ') || '(none)');
  if (inDbNotApi.length) console.log('In DB but NOT in API (missing on dashboard):', inDbNotApi.join(', '));
  if (inApiNotDb.length) console.log('In API but not in DB:', inApiNotDb.join(', '));
  if (inBoth.length) {
    console.log('In both (balance check):');
    for (const c of inBoth.sort()) {
      const dbBal = dbByCurrency[c]?.balance;
      const apiBal = apiByCurrency[c]?.balance;
      const match = String(dbBal) === String(apiBal) || Number(dbBal) === Number(apiBal);
      console.log(`  ${c}: DB=${dbBal} API=${apiBal} ${match ? 'OK' : 'MISMATCH'}`);
    }
  }

  if (inDbNotApi.length) {
    console.log('\n>>> Dashboard is missing these because the API did not return them. Check backend /api/wallets and RLS.');
  }
  if (dbRows.length > 0 && apiWallets.length === 0) {
    console.log('\n>>> API returned no wallets. Backend may be using a different Supabase client or RLS is blocking.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
