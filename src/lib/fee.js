/**
 * Buy splits (all deducted from gross crypto — payer bears the cost):
 * - 4% admin (system) always
 * - 4% direct affiliate when buyer is regular and referred by agent or super-tier recruiter
 * - 4% to first super_agent above that direct referrer (separate wallet; not double-paying direct)
 * - 4% to first super_super_agent further up the chain
 * Max 16% fees + user net when full chain exists. Remainder credits the recipient wallet.
 */

import { supabase } from '../db.js';
import { findUserIdByEmail } from './auth-users.js';

/** Synthetic wallet user from migration 005; used only if operator account is missing and env not set. */
export const LEGACY_SYSTEM_FEE_USER_ID = '00000000-0000-0000-0000-000000000002';

const ADMIN_OPERATOR_EMAIL = (process.env.ADMIN_OPERATOR_EMAIL || 'admin@admin.com').toLowerCase().trim();

/** @deprecated Use resolveAdminFeeRecipientUserId(). Env SYSTEM_FEE_USER_ID still pins recipient when set. */
export const SYSTEM_FEE_USER_ID = process.env.SYSTEM_FEE_USER_ID?.trim() || LEGACY_SYSTEM_FEE_USER_ID;

let cachedAdminFeeUserId = null;

/**
 * User id whose app wallets receive platform fees (buy 4%, SYSTEM_FEE_PERCENT ledger fees).
 * Defaults to auth user for ADMIN_OPERATOR_EMAIL (admin@admin.com). Override with SYSTEM_FEE_USER_ID.
 */
export async function resolveAdminFeeRecipientUserId() {
  const envId = process.env.SYSTEM_FEE_USER_ID?.trim();
  if (envId && /^[0-9a-f-]{36}$/i.test(envId)) return envId;
  if (cachedAdminFeeUserId) return cachedAdminFeeUserId;

  const operatorId = await findUserIdByEmail(ADMIN_OPERATOR_EMAIL);
  if (operatorId) {
    cachedAdminFeeUserId = operatorId;
    return operatorId;
  }

  console.warn(
    `[fee] No auth user for ${ADMIN_OPERATOR_EMAIL}; crediting legacy fee user ${LEGACY_SYSTEM_FEE_USER_ID}. Create the operator account or set SYSTEM_FEE_USER_ID.`
  );
  cachedAdminFeeUserId = LEGACY_SYSTEM_FEE_USER_ID;
  return LEGACY_SYSTEM_FEE_USER_ID;
}

const BUY_SYSTEM_FEE_RATE = 0.04;
const BUY_AGENT_FEE_RATE = 0.04;
const BUY_SUPER_UPLINE_RATE = 0.04;
const BUY_SUPER_SUPER_UPLINE_RATE = 0.04;

/**
 * @param {number} grossAmount
 * @param {{ hasAffiliate?: boolean, hasSuperUpline?: boolean, hasSuperSuperUpline?: boolean }} flags
 * @returns {{ userNet: number, systemFee: number, agentFee: number, superAgentFee: number, superSuperAgentFee: number }}
 */
export function computeBuySplit(grossAmount, flags = {}) {
  const { hasAffiliate = false, hasSuperUpline = false, hasSuperSuperUpline = false } = flags;
  const systemFee = Math.max(0, grossAmount * BUY_SYSTEM_FEE_RATE);
  const agentFee = hasAffiliate ? Math.max(0, grossAmount * BUY_AGENT_FEE_RATE) : 0;
  const superAgentFee = hasSuperUpline ? Math.max(0, grossAmount * BUY_SUPER_UPLINE_RATE) : 0;
  const superSuperAgentFee = hasSuperSuperUpline ? Math.max(0, grossAmount * BUY_SUPER_SUPER_UPLINE_RATE) : 0;
  const userNet = Math.max(0, grossAmount - systemFee - agentFee - superAgentFee - superSuperAgentFee);
  return { userNet, systemFee, agentFee, superAgentFee, superSuperAgentFee };
}

/**
 * Fee rate as decimal (e.g. 0.08 for 8%). From env SYSTEM_FEE_PERCENT: "8" or "0.08".
 */
export function getFeeRate() {
  const raw = process.env.SYSTEM_FEE_PERCENT;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0 || n > 100) return 0;
  return n > 1 ? n / 100 : n; // 8 -> 0.08, 0.08 -> 0.08
}

/**
 * Split amount into net (user gets) and fee (system gets).
 * @param {number} amount
 * @returns {{ netAmount: number, feeAmount: number }}
 */
export function applyFee(amount) {
  const rate = getFeeRate();
  if (rate <= 0) return { netAmount: amount, feeAmount: 0 };
  const feeAmount = Math.max(0, amount * rate);
  const netAmount = Math.max(0, amount - feeAmount);
  return { netAmount, feeAmount };
}

/**
 * Get or create the system fee wallet for a currency. Returns null if fee rate is 0.
 */
export async function getOrCreateFeeWallet(currency) {
  if (getFeeRate() <= 0) return null;
  const code = (currency || '').toUpperCase();
  if (!code) return null;

  const feeUserId = await resolveAdminFeeRecipientUserId();
  const { data: existing } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', feeUserId)
    .eq('currency', code)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('wallets')
    .insert({ user_id: feeUserId, currency: code, balance: 0 })
    .select()
    .single();

  if (error) throw error;
  return created;
}

/**
 * Credit the fee wallet and insert a fee transaction. No-op if feeAmount is 0 or no fee wallet.
 * @param {string} currency - e.g. ETH, USDT
 * @param {number} feeAmount
 * @param {object} opts - { fromWalletId, metadata }
 */
export async function recordFee(currency, feeAmount, opts = {}) {
  if (!feeAmount || feeAmount <= 0) return;
  const wallet = await getOrCreateFeeWallet(currency);
  if (!wallet) return;

  const newBalance = Number(wallet.balance) + feeAmount;
  await supabase
    .from('wallets')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('id', wallet.id);

  await supabase.from('transactions').insert({
    from_wallet_id: opts.fromWalletId || null,
    to_wallet_id: wallet.id,
    amount: feeAmount,
    type: 'fee',
    metadata: { currency, ...(opts.metadata || {}) },
  });
}

/**
 * Get or create the system fee wallet (admin) for a currency. Used for buy 4% fee regardless of SYSTEM_FEE_PERCENT.
 */
export async function getOrCreateSystemFeeWallet(currency) {
  const code = (currency || '').toUpperCase();
  if (!code) return null;
  const feeUserId = await resolveAdminFeeRecipientUserId();
  const { data: existing } = await supabase
    .from('wallets')
    .select('*')
    .eq('user_id', feeUserId)
    .eq('currency', code)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase
    .from('wallets')
    .insert({ user_id: feeUserId, currency: code, balance: 0 })
    .select()
    .single();
  if (error) throw error;
  return created;
}

/**
 * Record the 4% buy system fee to the operator account (ADMIN_OPERATOR_EMAIL, default admin@admin.com).
 */
export async function recordBuySystemFee(currency, feeAmount, opts = {}) {
  if (!feeAmount || feeAmount <= 0) return;
  const wallet = await getOrCreateSystemFeeWallet(currency);
  if (!wallet) return;
  const newBalance = Number(wallet.balance) + feeAmount;
  await supabase
    .from('wallets')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('id', wallet.id);
  await supabase.from('transactions').insert({
    from_wallet_id: opts.fromWalletId || null,
    to_wallet_id: wallet.id,
    amount: feeAmount,
    type: 'fee',
    metadata: { currency, source: 'buy', ...(opts.metadata || {}) },
  });
}
