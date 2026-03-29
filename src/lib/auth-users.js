import { supabase } from '../db.js';

/** Escape % and _ so ilike matches the literal string only. */
export function escapeIlikeExact(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Resolve auth user id by email (case-insensitive). Service role required. */
export async function findUserIdByEmail(rawEmail) {
  const normalized = String(rawEmail || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || '').toLowerCase() === normalized);
    if (found?.id) return found.id;
    if (users.length < perPage) break;
    page += 1;
  }
  return null;
}
