/**
 * Dev/test: ensure fixed login accounts exist with a known password.
 *
 * Run from back/: npm run seed:system-users
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in back/.env
 *
 * Password for all (set below): 123456 — dev/test only; rotate in production.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Same for every seeded account (matches user request). */
const PASSWORD = '123456';

/**
 * Emails and app roles (profiles.role).
 * Note: user wrote "superagant@system.com" — kept literally.
 */
const ACCOUNTS = [
  { email: 'user@system.com', role: 'regular' },
  { email: 'agent@system.com', role: 'agent' },
  { email: 'superagant@system.com', role: 'super_agent' },
  { email: 'supersuperagent@system.com', role: 'super_super_agent' },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function findUserIdByEmail(target) {
  const t = target.toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || '').toLowerCase() === t);
    if (u) return u.id;
    if (data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function ensureAccount({ email, role }) {
  const e = email.trim().toLowerCase();
  let userId = await findUserIdByEmail(e);

  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: e,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser ${e}: ${error.message}`);
    userId = data.user.id;
    console.log(`[create] ${e} → ${userId}`);
  } else {
    const { error } = await supabase.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`updateUser ${e}: ${error.message}`);
    console.log(`[update] ${e} → password reset, confirmed`);
  }

  const { error: pErr } = await supabase.from('profiles').upsert({ id: userId, role }, { onConflict: 'id' });
  if (pErr) throw new Error(`profiles ${e}: ${pErr.message}`);
  console.log(`[profile] ${e} role=${role}`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in back/.env');
    process.exit(1);
  }
  for (const row of ACCOUNTS) {
    await ensureAccount(row);
  }
  console.log('\nDone. Sign in with any listed email and password:', PASSWORD);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
