import { Router } from 'express';
import { supabase } from '../db.js';
import { SYSTEM_FEE_USER_ID, getFeeRate } from '../lib/fee.js';

export const systemRouter = Router();

/** Require admin secret (header X-Admin-Secret or query adminSecret) */
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.adminSecret;
  const expected = process.env.ADMIN_SECRET || process.env.SYSTEM_FEE_ADMIN_SECRET;
  if (!expected || secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized. Set X-Admin-Secret header or adminSecret query to ADMIN_SECRET.' });
  }
  next();
}

/**
 * GET /api/system/fees
 * Returns collected system fee balances per currency. Requires ADMIN_SECRET in X-Admin-Secret header (or ?adminSecret=).
 * How to see fees: curl -H "X-Admin-Secret: your-secret" http://localhost:4000/api/system/fees
 */
systemRouter.get('/fees', requireAdmin, async (req, res) => {
  try {
    const rate = getFeeRate();
    const { data: wallets, error } = await supabase
      .from('wallets')
      .select('currency, balance')
      .eq('user_id', SYSTEM_FEE_USER_ID)
      .order('currency');

    if (error) throw error;

    const balances = (wallets || []).map((w) => ({
      currency: w.currency,
      balance: Number(w.balance) || 0,
    }));

    res.json({
      feePercent: rate * 100,
      feeUserId: SYSTEM_FEE_USER_ID,
      balances,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
