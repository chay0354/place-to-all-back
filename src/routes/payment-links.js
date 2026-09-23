import { Router } from 'express';
import { supabase } from '../db.js';
import { generatePaymentLinkToken, getActivePaymentLinkByToken } from '../lib/payment-link.js';
import { simulatePublicPaymentLinkPay } from '../lib/public-payment-link-pay.js';

export const paymentLinksRouter = Router();

const PAYMENT_LINK_OWNER_ROLES = new Set(['regular', 'agent', 'super_agent', 'super_super_agent', 'admin']);

async function assertCanManagePaymentLinks(userId) {
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle();
  const role = profile?.role || 'regular';
  if (!PAYMENT_LINK_OWNER_ROLES.has(role)) {
    throw new Error('Your account type cannot manage payment links');
  }
}

/** Same split as link creation: rate set for the agent, plus the earn percent they chose. */
async function feePercentsForAgent(agentUserId) {
  const platformPercent = 4;
  let feeBasePercent = platformPercent;
  let earnPercent = 4;
  if (!agentUserId) return { feeBasePercent, earnPercent };

  const { data: me } = await supabase
    .from('profiles')
    .select('affiliate_take_rate, referred_by_id')
    .eq('id', agentUserId)
    .maybeSingle();

  if (me?.affiliate_take_rate != null && me.affiliate_take_rate !== '') {
    const n = Math.round(Number(me.affiliate_take_rate) * 10000) / 100;
    if (Number.isFinite(n)) earnPercent = n;
  }

  if (me?.referred_by_id) {
    const { data: setting, error } = await supabase
      .from('affiliation_team_settings')
      .select('earn_rate')
      .eq('manager_id', me.referred_by_id)
      .eq('member_id', agentUserId)
      .maybeSingle();
    if (!error && setting?.earn_rate != null && setting.earn_rate !== '') {
      const n = Math.round(Number(setting.earn_rate) * 10000) / 100;
      if (Number.isFinite(n)) feeBasePercent = n;
    }
  }

  return { feeBasePercent, earnPercent };
}

/** POST /api/payment-links — create link */
paymentLinksRouter.post('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    await assertCanManagePaymentLinks(userId);

    const { currency = 'USDT', amount, title } = req.body;
    const code = String(currency || 'USDT').toUpperCase();
    const token = generatePaymentLinkToken();
    const amountNum = amount != null && amount !== '' ? Number(amount) : null;
    if (amountNum == null || Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Amount is required and must be greater than 0' });
    }

    await supabase.from('payment_links').update({ active: false }).eq('agent_user_id', userId).eq('active', true);

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

/** GET /api/payment-links — list my links */
paymentLinksRouter.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'Missing X-User-Id' });
    await assertCanManagePaymentLinks(userId);

    const { data, error } = await supabase
      .from('payment_links')
      .select('id, token, currency, amount, title, active, created_at')
      .eq('agent_user_id', userId)
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** POST /api/payment-links/public/:token/simulate-pay — no auth; demo pay + deactivate link */
paymentLinksRouter.post('/public/:token/simulate-pay', async (req, res) => {
  try {
    const result = await simulatePublicPaymentLinkPay(req.params.token, req.body || {});
    res.status(201).json(result);
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
    const fees = await feePercentsForAgent(link.agent_user_id);

    res.json({
      title: link.title,
      currency: link.currency,
      amount: link.amount != null ? Number(link.amount) : null,
      depositAddress,
      agentUserId: link.agent_user_id,
      feeBasePercent: fees.feeBasePercent,
      earnPercent: fees.earnPercent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
