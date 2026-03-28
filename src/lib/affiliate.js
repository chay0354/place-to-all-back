import { supabase } from '../db.js';

const AFFILIATE_RATE = 0.02; // direct agent (or super) on referred regular's buy
const SUPER_UPLINE_RATE = 0.04; // super agent on subordinate agent network buys (payer pays)

/**
 * Super agent id when payer is (a) an agent recruited by a super, or
 * (b) a regular user whose referring agent was recruited by a super.
 */
export async function resolveSuperAgentUplineForBuyer(userId) {
  const { data: p } = await supabase.from('profiles').select('role, referred_by_id').eq('id', userId).maybeSingle();
  if (!p) return null;
  if (p.role === 'agent' && p.referred_by_id) {
    const { data: up } = await supabase.from('profiles').select('role').eq('id', p.referred_by_id).maybeSingle();
    if (up?.role === 'super_agent') return p.referred_by_id;
  }
  if (p.role === 'regular' && p.referred_by_id) {
    const { data: ref } = await supabase.from('profiles').select('role, referred_by_id').eq('id', p.referred_by_id).maybeSingle();
    if (ref?.role === 'agent' && ref.referred_by_id) {
      const { data: up } = await supabase.from('profiles').select('role').eq('id', ref.referred_by_id).maybeSingle();
      if (up?.role === 'super_agent') return ref.referred_by_id;
    }
  }
  return null;
}

/**
 * @returns {{ hasAffiliate: boolean, hasSuperUpline: boolean }}
 */
export async function getBuyCommissionFlags(payerUserId) {
  const { data: payer } = await supabase.from('profiles').select('role, referred_by_id').eq('id', payerUserId).maybeSingle();
  let hasAffiliate = false;
  if (payer?.role === 'regular' && payer.referred_by_id) {
    const { data: ref } = await supabase.from('profiles').select('role').eq('id', payer.referred_by_id).maybeSingle();
    if (ref && (ref.role === 'agent' || ref.role === 'super_agent')) hasAffiliate = true;
  }
  const superId = await resolveSuperAgentUplineForBuyer(payerUserId);
  return { hasAffiliate, hasSuperUpline: Boolean(superId) };
}

/**
 * 2% to direct referrer when buyer is regular and referred by an agent or super_agent.
 */
export async function recordAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;

  const { data: payer } = await supabase.from('profiles').select('role, referred_by_id').eq('id', buyerUserId).maybeSingle();
  if (payer?.role !== 'regular' || !payer.referred_by_id) return;

  const { data: ref } = await supabase.from('profiles').select('role').eq('id', payer.referred_by_id).maybeSingle();
  if (!ref || (ref.role !== 'agent' && ref.role !== 'super_agent')) return;

  const agentId = payer.referred_by_id;
  const commissionAmount = buyAmount * AFFILIATE_RATE;
  if (commissionAmount <= 0) return;

  const code = (currency || '').toUpperCase();
  if (!code) return;

  const { data: agentWallet, error: walletErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', agentId)
    .eq('currency', code)
    .maybeSingle();

  if (walletErr) return;

  let agentWalletId;
  let newBalance;

  if (agentWallet) {
    agentWalletId = agentWallet.id;
    newBalance = Number(agentWallet.balance) + commissionAmount;
    await supabase
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', agentWalletId);
  } else {
    const { data: created, error: ins } = await supabase
      .from('wallets')
      .insert({ user_id: agentId, currency: code, balance: commissionAmount })
      .select()
      .single();
    if (ins) return;
    agentWalletId = created.id;
    newBalance = commissionAmount;
  }

  await supabase.from('transactions').insert({
    from_wallet_id: null,
    to_wallet_id: agentWalletId,
    amount: commissionAmount,
    type: 'affiliate',
    metadata: { currency: code, buyer_user_id: buyerUserId, to_wallet_id: toWalletId, rate: AFFILIATE_RATE, kind: 'direct' },
  });
}

/**
 * 4% to super agent when buyer is in a super's downline (fees borne by payer / gross buy).
 */
export async function recordSuperAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;
  const superAgentId = await resolveSuperAgentUplineForBuyer(buyerUserId);
  if (!superAgentId) return;

  const commissionAmount = buyAmount * SUPER_UPLINE_RATE;
  if (commissionAmount <= 0) return;

  const code = (currency || '').toUpperCase();
  if (!code) return;

  const { data: sw, error: walletErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', superAgentId)
    .eq('currency', code)
    .maybeSingle();

  if (walletErr) return;

  let walletId;
  let newBalance;

  if (sw) {
    walletId = sw.id;
    newBalance = Number(sw.balance) + commissionAmount;
    await supabase.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('id', walletId);
  } else {
    const { data: created, error: ins } = await supabase
      .from('wallets')
      .insert({ user_id: superAgentId, currency: code, balance: commissionAmount })
      .select()
      .single();
    if (ins) return;
    walletId = created.id;
    newBalance = commissionAmount;
  }

  await supabase.from('transactions').insert({
    from_wallet_id: null,
    to_wallet_id: walletId,
    amount: commissionAmount,
    type: 'affiliate',
    metadata: {
      currency: code,
      buyer_user_id: buyerUserId,
      to_wallet_id: toWalletId,
      rate: SUPER_UPLINE_RATE,
      kind: 'super_upline',
    },
  });
}
