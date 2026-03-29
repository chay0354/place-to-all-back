import { supabase } from '../db.js';

const AFFILIATE_RATE = 0.02; // direct agent (or super / super-super) on referred regular's buy
const SUPER_UPLINE_RATE = 0.04; // first upline tier (super_agent or super_super_agent as recruiter)
const SUPER_SUPER_UPLINE_RATE = 0.04; // second tier: super_super_agent above first-tier recipient

function isSuperUplineRole(role) {
  return role === 'super_agent' || role === 'super_super_agent';
}

function isDirectAffiliateReferrerRole(role) {
  return role === 'agent' || isSuperUplineRole(role);
}

/**
 * First upline commission recipient: super_agent or super_super_agent who recruited the selling agent,
 * or (for a regular buyer) that agent's super recruiter.
 */
export async function resolveSuperAgentUplineForBuyer(userId) {
  const { data: p } = await supabase.from('profiles').select('role, referred_by_id').eq('id', userId).maybeSingle();
  if (!p) return null;
  if (p.role === 'agent' && p.referred_by_id) {
    const { data: up } = await supabase.from('profiles').select('role').eq('id', p.referred_by_id).maybeSingle();
    if (isSuperUplineRole(up?.role)) return p.referred_by_id;
  }
  if (p.role === 'regular' && p.referred_by_id) {
    const { data: ref } = await supabase.from('profiles').select('role, referred_by_id').eq('id', p.referred_by_id).maybeSingle();
    if (ref?.role === 'super_agent') {
      return p.referred_by_id;
    }
    if (ref?.role === 'agent' && ref.referred_by_id) {
      const { data: up } = await supabase.from('profiles').select('role').eq('id', ref.referred_by_id).maybeSingle();
      if (isSuperUplineRole(up?.role)) return ref.referred_by_id;
    }
  }
  return null;
}

/**
 * Second upline: super_super_agent who recruited the first-tier recipient (referred_by_id chain).
 */
export async function resolveSuperSuperAgentUplineForBuyer(userId) {
  const firstId = await resolveSuperAgentUplineForBuyer(userId);
  if (!firstId) return null;
  const { data: first } = await supabase.from('profiles').select('referred_by_id').eq('id', firstId).maybeSingle();
  const parentId = first?.referred_by_id;
  if (!parentId) return null;
  const { data: parent } = await supabase.from('profiles').select('role').eq('id', parentId).maybeSingle();
  if (parent?.role === 'super_super_agent') return parentId;
  return null;
}

/**
 * @returns {{ hasAffiliate: boolean, hasSuperUpline: boolean, hasSuperSuperUpline: boolean }}
 */
export async function getBuyCommissionFlags(payerUserId) {
  const { data: payer } = await supabase.from('profiles').select('role, referred_by_id').eq('id', payerUserId).maybeSingle();
  let hasAffiliate = false;
  if (payer?.role === 'regular' && payer.referred_by_id) {
    const { data: ref } = await supabase.from('profiles').select('role').eq('id', payer.referred_by_id).maybeSingle();
    if (ref && isDirectAffiliateReferrerRole(ref.role)) hasAffiliate = true;
  }
  const superId = await resolveSuperAgentUplineForBuyer(payerUserId);
  const superSuperId = await resolveSuperSuperAgentUplineForBuyer(payerUserId);
  return {
    hasAffiliate,
    hasSuperUpline: Boolean(superId),
    hasSuperSuperUpline: Boolean(superSuperId),
  };
}

/**
 * 2% to direct referrer when buyer is regular and referred by agent, super_agent, or super_super_agent.
 */
export async function recordAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;

  const { data: payer } = await supabase.from('profiles').select('role, referred_by_id').eq('id', buyerUserId).maybeSingle();
  if (payer?.role !== 'regular' || !payer.referred_by_id) return;

  const { data: ref } = await supabase.from('profiles').select('role').eq('id', payer.referred_by_id).maybeSingle();
  if (!ref || !isDirectAffiliateReferrerRole(ref.role)) return;

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
 * 4% first upline tier (super_agent or super_super_agent as network head for the buyer).
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

/**
 * 4% to super_super_agent above the first upline tier (when applicable).
 */
export async function recordSuperSuperAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;
  const id = await resolveSuperSuperAgentUplineForBuyer(buyerUserId);
  if (!id) return;

  const commissionAmount = buyAmount * SUPER_SUPER_UPLINE_RATE;
  if (commissionAmount <= 0) return;

  const code = (currency || '').toUpperCase();
  if (!code) return;

  const { data: sw, error: walletErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', id)
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
      .insert({ user_id: id, currency: code, balance: commissionAmount })
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
      rate: SUPER_SUPER_UPLINE_RATE,
      kind: 'super_super_upline',
    },
  });
}
