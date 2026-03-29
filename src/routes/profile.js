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
 * GET /api/profile/downline — super_super: agent + super_agent recruits; super_agent: agents only; agent: regulars.
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

    let kind;
    let query = supabase
      .from('profiles')
      .select('id, username, display_name, role, created_at')
      .eq('referred_by_id', userId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (role === 'super_super_agent') {
      kind = 'agents';
      query = query.in('role', ['agent', 'super_agent']);
    } else if (role === 'super_agent') {
      kind = 'agents';
      query = query.eq('role', 'agent');
    } else if (role === 'agent') {
      kind = 'regulars';
      query = query.eq('role', 'regular');
    } else {
      return res.json({ kind: 'none', members: [] });
    }

    const { data: rows, error: qErr } = await query;

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
