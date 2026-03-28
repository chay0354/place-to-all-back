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
