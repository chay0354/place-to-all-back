import { Router } from 'express';
import { supabase } from '../db.js';

export const adminRouter = Router();

const ADMIN_OPERATOR_EMAIL = (process.env.ADMIN_OPERATOR_EMAIL || 'admin@admin.com').toLowerCase().trim();

async function requireAppAdmin(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

  const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId);
  if (authErr || !authData?.user) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const email = (authData.user.email || '').toLowerCase().trim();
  if (email !== ADMIN_OPERATOR_EMAIL) {
    return res.status(403).json({ error: 'Admin tools are only available to the operator account' });
  }
  next();
}

adminRouter.use(requireAppAdmin);

/** Profiles where referred_by_id is set — count per referrer id */
async function getInvitedCountsByReferrerIds(referrerIds) {
  const ids = [...new Set((referrerIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const { data: refs, error } = await supabase.from('profiles').select('referred_by_id').in('referred_by_id', ids);
  if (error) throw error;
  const map = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const r of refs || []) {
    const id = r.referred_by_id;
    if (id && map[id] !== undefined) map[id] += 1;
  }
  return map;
}

/** GET /api/admin/agents — agents and super agents (role on each row); invitedCount = profiles with referred_by_id = this user */
adminRouter.get('/agents', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, referred_by_id, created_at, role')
      .in('role', ['agent', 'super_agent'])
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    const list = rows || [];
    const countMap = await getInvitedCountsByReferrerIds(list.map((r) => r.id));
    const withEmail = await enrichProfilesWithEmail(list);
    const enriched = withEmail.map((row) => ({ ...row, invitedCount: countMap[row.id] ?? 0 }));

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function enrichProfilesWithEmail(rows) {
  const list = rows || [];
  return Promise.all(
    list.map(async (row) => {
      const { data: u } = await supabase.auth.admin.getUserById(row.id);
      return {
        ...row,
        email: u?.user?.email || null,
      };
    })
  );
}

/** GET /api/admin/regular-users — all profiles with role regular */
adminRouter.get('/regular-users', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, referred_by_id, role, created_at')
      .eq('role', 'regular')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;
    const enriched = await enrichProfilesWithEmail(rows || []);
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/invites/:referrerId
 * Profiles that list this user as referrer (regular users under an agent, or agents under a super agent).
 */
adminRouter.get('/invites/:referrerId', async (req, res) => {
  try {
    const referrerId = String(req.params.referrerId || '').trim();
    if (!referrerId) return res.status(400).json({ error: 'referrerId required' });

    const { data: rows, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, referred_by_id, role, created_at')
      .eq('referred_by_id', referrerId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;
    const enriched = await enrichProfilesWithEmail(rows || []);
    res.json({ referrerId, invites: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/promote-to-super-agent
 * Body: { targetUserId } — target must currently be role agent
 */
adminRouter.post('/promote-to-super-agent', async (req, res) => {
  try {
    const targetUserId = String(req.body?.targetUserId || '').trim();
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

    const { data: target, error: fetchErr } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', targetUserId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role !== 'agent') {
      return res.status(400).json({ error: 'Only users with the agent role can be promoted to super agent' });
    }

    const countMap = await getInvitedCountsByReferrerIds([targetUserId]);
    const invited = countMap[targetUserId] ?? 0;
    if (invited > 0) {
      return res.status(400).json({
        error: `Agent can be promoted to super agent only with no invited users (no profiles with referred_by_id = this agent). Currently: ${invited}.`,
      });
    }

    const updated_at = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('profiles')
      .update({ role: 'super_agent', updated_at })
      .eq('id', targetUserId);

    if (updErr) throw updErr;
    res.json({ ok: true, id: targetUserId, role: 'super_agent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
