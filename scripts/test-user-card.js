/**
 * E2E test: issue a virtual card for a user and verify retrieval.
 *
 * Run:
 *   npm run test:user-card
 *   node scripts/test-user-card.js
 *   node scripts/test-user-card.js <existing-user-id>
 *
 * Backend must be running: npm run dev (in back/)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const ARG_USER_ID = process.argv[2] || null;
const TEST_EMAIL = `card-test-${Date.now()}@place-to-all.test`;
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
  if (!res.ok) throw new Error(`${path}: ${data.error || res.statusText || String(res.status)}`);
  return data;
}

async function resolveUserId() {
  if (ARG_USER_ID) return ARG_USER_ID;
  if (!supabase) throw new Error('Provide user id arg, or set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  const { data, error } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`Create user failed: ${error.message}`);
  return data.user.id;
}

async function main() {
  log('0', 'Config', {
    API_URL,
    hasSupabase: !!supabase,
    usingUserIdFromArg: !!ARG_USER_ID,
  });

  const userId = await resolveUserId();
  log('1', 'Target user resolved', { userId });

  const issue = await api('POST', '/api/cards/issue', {}, userId);
  log('2', 'Issue card response', issue);

  const account = await api('GET', '/api/cards', null, userId);
  log('3', 'Fetch card account response', account);

  if (!account?.card?.id) {
    throw new Error('Card was not created or returned by GET /api/cards');
  }
  if (!account?.card?.reap_card_id) {
    throw new Error('Missing reap_card_id on created card');
  }
  if (String(account.card.card_network || '').toUpperCase() !== 'VISA') {
    throw new Error(`Unexpected network: ${account.card.card_network}`);
  }

  console.log('\n--- OK: card issue flow works for this user ---');
}

main().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});

