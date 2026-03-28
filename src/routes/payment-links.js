import { Router } from 'express';
import { supabase } from '../db.js';
import { generatePaymentLinkToken, getActivePaymentLinkByToken } from '../lib/payment-link.js';

export const paymentLinksRouter = Router();

async function assertAgent(userId) {
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (!profile || (profile.role !== 'agent' && profile.role !== 'super_agent')) {
    throw new Error('Only agent or super-agent accounts can manage payment links');
  }
}

/** POST /api/payment-links — create link (agent only) */
paymentLinksRouter.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    await assertAgent(userId);

    const { currency = 'USDT', amount, title } = req.body;
    const code = String(currency || 'USDT').toUpperCase();
    const token = generatePaymentLinkToken();
    const amountNum = amount != null && amount !== '' ? Number(amount) : null;
    if (amountNum == null || Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Amount is required and must be greater than 0' });
    }

    const { data: row, error } = await supabase
      .from('payment_links')
      .insert({
        token,
        agent_user_id: userId,
        currency: code,
        amount: amountNum,
        title: title ? String(title).slice(0, 120) : null,
        active: true,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** GET /api/payment-links — list my links (agent only) */
paymentLinksRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    await assertAgent(userId);

    const { data, error } = await supabase
      .from('payment_links')
      .select('id, token, currency, amount, title, active, created_at')
      .eq('agent_user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** GET /api/payment-links/public/:token — no auth; for pay page */
paymentLinksRouter.get('/public/:token', async (req, res) => {
  try {
    const link = await getActivePaymentLinkByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const { data: cw } = await supabase
      .from('coinbase_wallets')
      .select('default_address, delivery_address')
      .eq('user_id', link.agent_user_id)
      .maybeSingle();

    const depositAddress = cw?.delivery_address || cw?.default_address || null;

    res.json({
      title: link.title,
      currency: link.currency,
      amount: link.amount != null ? Number(link.amount) : null,
      depositAddress,
      agentUserId: link.agent_user_id,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
