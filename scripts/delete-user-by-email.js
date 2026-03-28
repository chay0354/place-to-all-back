/**
 * Remove a Supabase Auth user by email and clean app tables (no FK to auth.users).
 * Run from back/: node scripts/delete-user-by-email.js <email>
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/delete-user-by-email.js <email>');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function findUserIdByEmail(target) {
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || '').toLowerCase() === target);
    if (u) return u.id;
    if (data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function main() {
  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.log('No auth user found for:', email);
    return;
  }
  console.log('Found user id:', userId);

  await supabase.from('profiles').update({ referred_by_id: null }).eq('referred_by_id', userId);

  const { data: walletRows } = await supabase.from('wallets').select('id').eq('user_id', userId);
  const walletIds = (walletRows || []).map((w) => w.id);
  if (walletIds.length) {
    for (const wid of walletIds) {
      await supabase.from('transactions').delete().eq('from_wallet_id', wid);
      await supabase.from('transactions').delete().eq('to_wallet_id', wid);
    }
    await supabase.from('wallets').delete().eq('user_id', userId);
    console.log('Removed', walletIds.length, 'ledger wallet(s) and related transactions');
  }

  await supabase.from('rapyd_checkouts').delete().eq('user_id', userId);
  await supabase.from('rapyd_checkouts').delete().eq('beneficiary_user_id', userId);
  await supabase.from('payment_links').delete().eq('agent_user_id', userId);

  const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
  if (delErr) throw delErr;
  console.log('Deleted auth user:', email);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
