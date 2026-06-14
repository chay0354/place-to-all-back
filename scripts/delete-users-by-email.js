/**
 * One-off: delete Supabase Auth users by email (profiles CASCADE from auth.users).
 *
 * Run from back/: node scripts/delete-users-by-email.js
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in back/.env
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Lowercase; script matches case-insensitively */
const EMAILS_TO_REMOVE = ['chay.moalem@gmail.com', 'chaykaduri@gmail.com'];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in back/.env');
    process.exit(1);
  }

  for (const email of EMAILS_TO_REMOVE) {
    const id = await findUserIdByEmail(email);
    if (!id) {
      console.log(`[skip] No user found for ${email}`);
      continue;
    }
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) {
      console.error(`[error] ${email}: ${error.message}`);
      continue;
    }
    console.log(`[deleted] ${email} (${id})`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
