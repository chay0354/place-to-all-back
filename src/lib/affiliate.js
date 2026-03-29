import { supabase } from '../db.js';

/** Direct recruiter share (regular buyer’s immediate referrer). */
const AFFILIATE_DIRECT_RATE = 0.04;
/** First super_agent above the direct recruiter (not the same wallet as direct). */
const SUPER_AGENT_TIER_RATE = 0.04;
/** First super_super_agent further up the chain. */
const SUPER_SUPER_TIER_RATE = 0.04;

function isSuperUplineRole(role) {
  return role === 'super_agent' || role === 'super_super_agent';
}

function isDirectAffiliateReferrerRole(role) {
  return role === 'agent' || isSuperUplineRole(role);
}

async function getProfile(id) {
  if (!id) return null;
  const { data } = await supabase.from('profiles').select('id, role, referred_by_id').eq('id', id).maybeSingle();
  return data || null;
}

/**
 * Regular buyer: immediate referrer (agent / super_agent / super_super_agent) for the 4% “direct” tier.
 */
export async function resolveDirectAffiliateId(userId) {
  const p = await getProfile(userId);
  if (p?.role !== 'regular' || !p.referred_by_id) return null;
  const ref = await getProfile(p.referred_by_id);
  if (!ref || !isDirectAffiliateReferrerRole(ref.role)) return null;
  return ref.id;
}

/**
 * 4% “super agent” tier: first profile with role super_agent walking up from (above) the direct referrer.
 * Agent buyer: pays buyer’s referred_by only if that parent is super_agent.
 */
export async function resolveSuperAgentTierId(userId) {
  const p = await getProfile(userId);
  if (!p) return null;

  if (p.role === 'regular') {
    const directId = await resolveDirectAffiliateId(userId);
    if (!directId) return null;
    const direct = await getProfile(directId);
    let cur = direct?.referred_by_id;
    while (cur) {
      const node = await getProfile(cur);
      if (!node) return null;
      if (node.role === 'super_agent') return node.id;
      cur = node.referred_by_id;
    }
    return null;
  }

  if (p.role === 'agent' && p.referred_by_id) {
    const up = await getProfile(p.referred_by_id);
    if (up?.role === 'super_agent') return p.referred_by_id;
  }

  return null;
}

/**
 * 4% “super super agent” tier: first super_super_agent walking up from above the direct referrer (regular),
 * or up from the agent buyer’s referred_by chain.
 */
export async function resolveSuperSuperAgentTierId(userId) {
  const p = await getProfile(userId);
  if (!p) return null;

  if (p.role === 'regular') {
    const directId = await resolveDirectAffiliateId(userId);
    if (!directId) return null;
    const direct = await getProfile(directId);
    let cur = direct?.referred_by_id;
    while (cur) {
      const node = await getProfile(cur);
      if (!node) return null;
      if (node.role === 'super_super_agent') return node.id;
      cur = node.referred_by_id;
    }
    return null;
  }

  if (p.role === 'agent' && p.referred_by_id) {
    let cur = p.referred_by_id;
    while (cur) {
      const node = await getProfile(cur);
      if (!node) return null;
      if (node.role === 'super_super_agent') return node.id;
      cur = node.referred_by_id;
    }
  }

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

  const superId = await resolveSuperAgentTierId(payerUserId);
  const superSuperId = await resolveSuperSuperAgentTierId(payerUserId);
  return {
    hasAffiliate,
    hasSuperUpline: Boolean(superId),
    hasSuperSuperUpline: Boolean(superSuperId),
  };
}

/**
 * 4% to direct referrer when buyer is regular (agent / super_agent / super_super_agent).
 */
export async function recordAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;

  const { data: payer } = await supabase.from('profiles').select('role, referred_by_id').eq('id', buyerUserId).maybeSingle();
  if (payer?.role !== 'regular' || !payer.referred_by_id) return;

  const { data: ref } = await supabase.from('profiles').select('role').eq('id', payer.referred_by_id).maybeSingle();
  if (!ref || !isDirectAffiliateReferrerRole(ref.role)) return;

  const agentId = payer.referred_by_id;
  const commissionAmount = buyAmount * AFFILIATE_DIRECT_RATE;
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
    metadata: { currency: code, buyer_user_id: buyerUserId, to_wallet_id: toWalletId, rate: AFFILIATE_DIRECT_RATE, kind: 'direct' },
  });
}

/** 4% to first super_agent tier (see resolveSuperAgentTierId). */
export async function recordSuperAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;
  const superAgentId = await resolveSuperAgentTierId(buyerUserId);
  if (!superAgentId) return;

  const commissionAmount = buyAmount * SUPER_AGENT_TIER_RATE;
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
      rate: SUPER_AGENT_TIER_RATE,
      kind: 'super_upline',
    },
  });
}

/** 4% to first super_super_agent tier (see resolveSuperSuperAgentTierId). */
export async function recordSuperSuperAgentCommission(buyerUserId, currency, buyAmount, toWalletId) {
  if (!buyAmount || buyAmount <= 0) return;
  const id = await resolveSuperSuperAgentTierId(buyerUserId);
  if (!id) return;

  const commissionAmount = buyAmount * SUPER_SUPER_TIER_RATE;
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
      rate: SUPER_SUPER_TIER_RATE,
      kind: 'super_super_upline',
    },
  });
}
