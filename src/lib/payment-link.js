import crypto from 'crypto';
import { supabase } from '../db.js';

export function generatePaymentLinkToken() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * @param {string} token
 * @returns {Promise<object|null>} link row or null
 */
export async function getActivePaymentLinkByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { data } = await supabase
    .from('payment_links')
    .select('*')
    .eq('token', token.trim())
    .eq('active', true)
    .maybeSingle();
  return data || null;
}

/**
 * Validate token and that the link credits this user (any role).
 * @param {string} token
 * @param {string} beneficiaryUserId
 */
export async function assertValidPaymentLinkForBeneficiary(token, beneficiaryUserId) {
  const link = await getActivePaymentLinkByToken(token);
  if (!link || link.agent_user_id !== beneficiaryUserId) {
    throw new Error('Invalid or expired payment link');
  }
  return link;
}

/** @deprecated Use assertValidPaymentLinkForBeneficiary */
export async function assertValidPaymentLinkForAgent(token, agentUserId) {
  return assertValidPaymentLinkForBeneficiary(token, agentUserId);
}
