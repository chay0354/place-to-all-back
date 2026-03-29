import { Router } from 'express';
import { supabase } from '../db.js';

const authRouter = Router();
const MAX_AGE_SECONDS = 120; // Only confirm users created in the last 2 minutes

/** GET /api/auth/referral-preview?ref=uuid — public; for register UI (agent vs super_agent invite). */
authRouter.get('/referral-preview', async (req, res) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.json({ valid: false, recruiterRole: null });
    const { data } = await supabase.from('profiles').select('role').eq('id', ref).maybeSingle();
    if (!data || (data.role !== 'agent' && data.role !== 'super_agent' && data.role !== 'super_super_agent')) {
      return res.json({ valid: false, recruiterRole: null });
    }
    res.json({ valid: true, recruiterRole: data.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/confirm-email
 * Body: { userId, role?: 'regular' | 'agent', referredBy?: string }
 * Super / super-super agent is never set here — only via admin. referredBy = agent → regular. referredBy = super_agent|super_super_agent → agent under that recruiter.
 */
authRouter.post('/confirm-email', async (req, res) => {
  try {
    const { userId, role: requestedRole, referredBy } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: user, error: fetchErr } = await supabase.auth.admin.getUserById(userId);
    if (fetchErr || !user?.user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const created = new Date(user.user.created_at).getTime();
    const now = Date.now();
    if (now - created > MAX_AGE_SECONDS * 1000) {
      return res.status(400).json({ error: 'User too old to auto-confirm' });
    }

    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      email_confirm: true,
    });
    if (updateErr) throw updateErr;

    let role;
    let referred_by_id = null;

    if (referredBy) {
      const { data: refProfile } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('id', referredBy)
        .maybeSingle();
      if (!refProfile || (refProfile.role !== 'agent' && refProfile.role !== 'super_agent' && refProfile.role !== 'super_super_agent')) {
        return res.status(400).json({ error: 'Invalid referral link' });
      }
      if (refProfile.role === 'super_agent' || refProfile.role === 'super_super_agent') {
        role = 'agent';
        referred_by_id = referredBy;
      } else {
        role = 'regular';
        referred_by_id = referredBy;
      }
    } else {
      role = requestedRole === 'agent' ? 'agent' : 'regular';
    }

    const { data: existing } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
    const updated_at = new Date().toISOString();
    if (existing) {
      await supabase.from('profiles').update({ role, referred_by_id, updated_at }).eq('id', userId);
    } else {
      await supabase.from('profiles').insert({ id: userId, role, referred_by_id, updated_at });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { authRouter };
