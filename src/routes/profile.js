import { Router } from 'express';
import { supabase } from '../db.js';

export const profileRouter = Router();

/** GET /api/profile — get current user's profile (role, referred_by_id). Requires X-User-Id. */
profileRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, referred_by_id, username, display_name')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.json({ id: userId, role: 'regular', referred_by_id: null });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/profile/downline — agents under a super agent, or regular users under an agent.
 * Requires X-User-Id. No emails for other users unless we enrich (optional).
 */
profileRouter.get('/downline', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });

    const { data: me, error: meErr } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();

    if (meErr) throw meErr;
    const role = me?.role || 'regular';

    let targetRole;
    let kind;
    if (role === 'super_agent') {
      targetRole = 'agent';
      kind = 'agents';
    } else if (role === 'agent') {
      targetRole = 'regular';
      kind = 'regulars';
    } else {
      return res.json({ kind: 'none', members: [] });
    }

    const { data: rows, error: qErr } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, created_at')
      .eq('referred_by_id', userId)
      .eq('role', targetRole)
      .order('created_at', { ascending: false })
      .limit(500);

    if (qErr) throw qErr;

    const list = rows || [];
    const members = await Promise.all(
      list.map(async (row) => {
        const { data: u } = await supabase.auth.admin.getUserById(row.id);
        return {
          ...row,
          email: u?.user?.email || null,
        };
      }),
    );

    res.json({ kind, members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
